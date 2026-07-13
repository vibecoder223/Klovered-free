"""Grounded answer generation with citations + confidence (port of lib/rag.ts).

Persists to `responses` + `citations`. `db` is a service-role SupabaseRest.
NOTE: not yet quality-verified end-to-end — the DB has no ingested chunks to run
against. Behavior is ported 1:1 from lib/rag.ts (prompts verbatim) and covered by
mock-based unit tests; eval-parity against the TS output is pending seeded data.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

from ..mistral import MODEL_FAST, call_mistral_json, call_mistral_text, has_llm_key
from .answer_library import (
    LIBRARY_REUSE_MIN,
    record_reuse,
    suggest_answers,
    suggest_answers_by_embeddings,
)
from .embeddings import embed_texts, has_embeddings
from .retrieval import Candidate, is_no_source, retrieve_for_queries, retrieve_for_query

GENERATOR_SYSTEM_V1 = """You are a proposal writer at the customer's company. You write answers to RFP requirements in the customer's own voice, drawing exclusively from the source chunks provided. You never invent facts. You never speculate. You never use external knowledge.

Rules:
1. Every SENTENCE must be individually traceable to a specific chunk in <sources>. If you cannot point to the exact chunk that supports a sentence, delete that sentence — do not write it and cite a nearby chunk hoping it's close enough.
2. Never combine a fact from one chunk with an unrelated claim from another chunk unless both facts are actually about the same subject (e.g. do not take a remediation timeline from a penetration-testing chunk and apply it to a support-SLA answer).
3. Never generalize a specific number, policy, or capability beyond what the chunk states. If a chunk describes one thing (e.g. audit logging) do not extend it into a different capability (e.g. full version control) that the chunk does not mention.
4. Cite every supported claim inline using [c:N], where N is the chunk's number from <sources> (e.g. [c:1], [c:3]). No quotes, no extra brackets, no UUIDs.
5. Write in business prose: confident, specific, concise. If voice examples are provided, match their tone.
6. If sources contradict each other, prefer the more recent document and note the discrepancy in a closing sentence.
7. If the sources do not cover the requirement, output exactly:
   "NO_SOURCE: The knowledge base does not contain content sufficient to answer this requirement."
   Do not draft a partial or hedged answer. A single loosely-related chunk is NOT coverage — if the chunk doesn't state the specific fact asked for, this is NO_SOURCE, not an inference.
8. Length: match the requirement. "Describe" gets 100-200 words. "Confirm" gets one sentence. Do not pad."""

GENERATOR_BATCH_SYSTEM_V1 = """You are a proposal writer at the customer's company, answering RFP requirements in the customer's voice using ONLY the source chunks provided.

Rules:
1. Every sentence must be individually traceable to a specific chunk — if you can't point to the exact chunk supporting a sentence, delete that sentence rather than cite a nearby chunk hoping it's close enough.
2. Never combine facts from unrelated chunks (e.g. don't take a remediation timeline from a security chunk and apply it to a support-SLA answer), and never generalize a chunk's specific claim into a broader capability it doesn't state.
3. Cite every supported claim inline as [c:N] using that chunk's number. Never invent facts or use outside knowledge.
4. Business prose: confident, specific, concise. Match the voice examples if provided.
5. If the sources do not cover a question — including when a chunk is only topically related but doesn't state the specific fact asked — that answer must be exactly "NO_SOURCE".
6. Length follows the question: "describe/explain" 100-200 words; "confirm/yes-no" 1-2 sentences. No padding.

Return ONLY a JSON array, one item per question, no fences:
[{"q": <question number>, "answer": "<answer text with [c:N] citations>"}]"""

CONFIDENCE_SYSTEM_V1 = """Score this answer's grounding 0.0-1.0.

- 1.0: every claim is directly supported by a cited chunk.
- 0.7: mostly supported; minor unsupported phrasing.
- 0.4: partially supported; weak source coverage on some claims.
- 0.0: not grounded.

Output a single decimal number, nothing else."""

_NO_SOURCE_TEXT = (
    "NO_SOURCE: The knowledge base does not contain content sufficient to answer this requirement."
)

BATCH_SOURCE_CAP = 14
PER_QUESTION_GUARANTEE = 3

# Matches [c:N] and the full-width-bracket variant 【c:N】 some models emit.
_CITE_RE = re.compile(r"[\[【]\s*c:\s*(\d{1,3})\s*[\]】]", re.IGNORECASE)


@dataclass
class GenerationUsage:
    input_tokens: int
    output_tokens: int


@dataclass
class ParsedCitation:
    chunk_id: str
    document_filename: str
    section_path: str | None
    page: int | None
    quote: str


def _confidence_llm_enabled() -> bool:
    return os.getenv("RAG_USE_CONFIDENCE_LLM") == "1"


# ── single-question path ────────────────────────────────────────────────────
async def generate_and_persist_answer(
    db, *, question_id: str, question_text: str, org_id: str, org_name: str, tone: str | None = None
) -> GenerationUsage:
    total_in = 0
    total_out = 0
    tone = tone or "technical"

    # 0. Library-first (org-scoped inside match_answers).
    lib = await suggest_answers(db, org_id=org_id, question_text=question_text, limit=1)
    reuse = lib[0] if lib else None
    if (
        reuse
        and reuse.similarity >= LIBRARY_REUSE_MIN
        and reuse.source_question_id != question_id
        and reuse.response_text.strip()
    ):
        _upsert_response(
            db,
            question_id=question_id,
            with_markers=reuse.response_text,
            clean=reuse.response_text,
            tone=tone,
            confidence=0.95,
            gap_flag="ok",
            status="requires_review",
            citations=[],
        )
        record_reuse(db, reuse.id)
        return GenerationUsage(total_in, total_out)

    # 1. Retrieve
    retrieval = await retrieve_for_query(db, org_id=org_id, query=question_text, top_k=6)
    total_in += retrieval.usage.input_tokens
    total_out += retrieval.usage.output_tokens

    # 2. Gap gate
    if is_no_source(retrieval.top_score, len(retrieval.candidates)):
        _upsert_response(
            db, question_id=question_id, with_markers=_NO_SOURCE_TEXT, clean="", tone=tone,
            confidence=0, gap_flag="no_source", status="requires_review", citations=[],
        )
        return GenerationUsage(total_in, total_out)

    # 3. Voice examples — org-scoped (best-effort)
    voice = _voice_examples(db, org_id)

    # 4. Generate
    if not has_llm_key():
        _upsert_response(
            db, question_id=question_id, with_markers="AI_DISABLED: no LLM API key configured.",
            clean="AI_DISABLED: no LLM API key configured.", tone=tone, confidence=0,
            gap_flag="no_source", status="requires_review", citations=[],
        )
        return GenerationUsage(total_in, total_out)

    user = _build_generator_user(org_name, question_text, voice, retrieval.candidates)
    gen = await call_mistral_text(system=GENERATOR_SYSTEM_V1, user=user, max_tokens=900, model=MODEL_FAST)
    raw_answer = gen["text"]
    total_in += gen["usage"].input_tokens
    total_out += gen["usage"].output_tokens

    # 5. Model NO_SOURCE sentinel
    if re.match(r"^\s*NO_SOURCE:", raw_answer, re.IGNORECASE):
        _upsert_response(
            db, question_id=question_id, with_markers=raw_answer.strip(), clean="", tone=tone,
            confidence=0, gap_flag="no_source", status="requires_review", citations=[],
        )
        return GenerationUsage(total_in, total_out)

    # 6. Citations
    valid_ids = {c.chunk_id for c in retrieval.candidates}
    cited = _extract_citations(raw_answer, retrieval.candidates)
    valid_cited = [c for c in cited if c.chunk_id in valid_ids]
    clean = _strip_markers(raw_answer)

    # 7. Confidence — heuristic (or LLM if opted in)
    confidence = 0 if len(valid_cited) == 0 else 0.7 if len(valid_cited) >= 2 else 0.5
    if _confidence_llm_enabled():
        try:
            src = "\n".join(f'<chunk id="{c.chunk_id}">{c.text}</chunk>' for c in retrieval.candidates)
            scored = await call_mistral_text(
                system=CONFIDENCE_SYSTEM_V1,
                user=f"<answer>\n{raw_answer}\n</answer>\n\n<sources>\n{src}\n</sources>",
                max_tokens=16, model=MODEL_FAST,
            )
            total_in += scored["usage"].input_tokens
            total_out += scored["usage"].output_tokens
            m = re.search(r"[01](?:\.\d+)?", scored["text"])
            if m:
                confidence = max(0.0, min(1.0, float(m.group(0))))
        except Exception:  # noqa: BLE001
            pass

    grounded = len(valid_cited) > 0
    gap_flag = "no_source" if not grounded else "ok" if confidence >= 0.7 else "partial"
    status = "draft" if (confidence >= 0.7 and gap_flag == "ok") else "requires_review"

    _upsert_response(
        db, question_id=question_id, with_markers=raw_answer.strip(),
        clean=clean if grounded else "", tone=tone, confidence=confidence,
        gap_flag=gap_flag, status=status, citations=valid_cited,
    )
    return GenerationUsage(total_in, total_out)


# ── batched path ────────────────────────────────────────────────────────────
@dataclass
class BatchQuestion:
    question_id: str
    question_text: str


def _validate_batch_answers(data) -> dict[int, str] | None:
    if not isinstance(data, list):
        return None
    out: dict[int, str] = {}
    for item in data:
        if not isinstance(item, dict):
            return None
        q = item.get("q")
        answer = item.get("answer")
        try:
            qn = int(q)
        except (TypeError, ValueError):
            return None
        if qn < 1 or not isinstance(answer, str):
            return None
        out[qn] = answer
    return out


async def generate_batch_answers(
    db, *, org_id: str, org_name: str, questions: list[BatchQuestion], tone: str | None = None
) -> GenerationUsage:
    total_in = 0
    total_out = 0
    tone = tone or "technical"
    if not questions:
        return GenerationUsage(0, 0)

    # Embed all questions once, reuse for library + retrieval.
    query_embeddings: list[list[float]] = []
    if has_embeddings():
        try:
            query_embeddings = await embed_texts([q.question_text for q in questions], "query")
        except Exception:  # noqa: BLE001
            query_embeddings = []

    # 0. Library-first (embedding similarity only)
    needs_generation: list[BatchQuestion] = []
    needs_embeddings: list[list[float]] = []
    lib = await suggest_answers_by_embeddings(
        db, org_id=org_id, embeddings=[query_embeddings[i] if i < len(query_embeddings) else None for i in range(len(questions))]
    )
    for i, q in enumerate(questions):
        reuse = lib[i] if i < len(lib) else None
        if (
            reuse
            and reuse.similarity >= LIBRARY_REUSE_MIN
            and reuse.source_question_id != q.question_id
            and reuse.response_text.strip()
        ):
            _upsert_response(
                db, question_id=q.question_id, with_markers=reuse.response_text,
                clean=reuse.response_text, tone=tone, confidence=0.95, gap_flag="ok",
                status="requires_review", citations=[],
            )
            record_reuse(db, reuse.id)
        else:
            needs_generation.append(q)
            if i < len(query_embeddings) and query_embeddings[i]:
                needs_embeddings.append(query_embeddings[i])
    if not needs_generation:
        return GenerationUsage(total_in, total_out)

    # 1. Retrieve with precomputed embeddings
    batch_retrievals = await retrieve_for_queries(
        db, org_id=org_id, queries=[q.question_text for q in needs_generation], top_k=6,
        embeddings=needs_embeddings if len(needs_embeddings) == len(needs_generation) else None,
    )
    retrievals = list(zip(needs_generation, batch_retrievals))

    # 2. Per-question gap gate
    live: list[tuple[BatchQuestion, object]] = []
    for q, r in retrievals:
        if is_no_source(r.top_score, len(r.candidates)):
            _upsert_response(
                db, question_id=q.question_id, with_markers=_NO_SOURCE_TEXT, clean="", tone=tone,
                confidence=0, gap_flag="no_source", status="requires_review", citations=[],
            )
        else:
            live.append((q, r))
    if not live:
        return GenerationUsage(total_in, total_out)

    if not has_llm_key():
        for q, _ in live:
            _upsert_response(
                db, question_id=q.question_id, with_markers="AI_DISABLED: no LLM API key configured.",
                clean="AI_DISABLED: no LLM API key configured.", tone=tone, confidence=0,
                gap_flag="no_source", status="requires_review", citations=[],
            )
        return GenerationUsage(total_in, total_out)

    # 3. Shared source list: per-question guarantee, then global fill, dedup.
    union: dict[str, Candidate] = {}
    for _, r in live:
        for c in r.candidates[:PER_QUESTION_GUARANTEE]:
            union.setdefault(c.chunk_id, c)
    overflow = [
        c for _, r in live for c in r.candidates[PER_QUESTION_GUARANTEE:] if c.chunk_id not in union
    ]
    overflow.sort(key=lambda c: c.score, reverse=True)
    for c in overflow:
        if len(union) >= BATCH_SOURCE_CAP:
            break
        union.setdefault(c.chunk_id, c)
    shared_sources = list(union.values())

    # 4. Voice examples (once per batch, org-scoped)
    voice = _voice_examples(db, org_id)

    # 5. One call for the group; validate; one corrective retry.
    user = _build_batch_generator_user(org_name, [q.question_text for q, _ in live], voice, shared_sources)
    max_tokens = min(4096, 400 + len(live) * 350)
    answers: dict[int, str] | None = None
    last_err = ""
    for attempt in range(2):
        if answers is not None:
            break
        try:
            res = await call_mistral_json(
                system=GENERATOR_BATCH_SYSTEM_V1,
                user=user if attempt == 0
                else f"{user}\n\n[Previous attempt failed: {last_err}. Return ONLY the JSON array described in the system prompt.]",
                max_tokens=max_tokens, mode="text", model=MODEL_FAST,
            )
            total_in += res["usage"].input_tokens
            total_out += res["usage"].output_tokens
            validated = _validate_batch_answers(res["data"])
            if validated is None:
                last_err = "invalid batch answer JSON"
                continue
            answers = validated
        except Exception as e:  # noqa: BLE001
            last_err = str(e)

    valid_ids = {c.chunk_id for c in shared_sources}

    for i, (q, r) in enumerate(live):
        raw_answer = (answers.get(i + 1) if answers else None)
        raw_answer = raw_answer.strip() if raw_answer else None

        if not raw_answer:
            # Fall back to the proven per-question path.
            usage = await generate_and_persist_answer(
                db, question_id=q.question_id, question_text=q.question_text,
                org_id=org_id, org_name=org_name, tone=tone,
            )
            total_in += usage.input_tokens
            total_out += usage.output_tokens
            continue

        if re.match(r'^\s*"?NO_SOURCE', raw_answer, re.IGNORECASE):
            _upsert_response(
                db, question_id=q.question_id, with_markers=_NO_SOURCE_TEXT, clean="", tone=tone,
                confidence=0, gap_flag="no_source", status="requires_review", citations=[],
            )
            continue

        cited = _extract_citations(raw_answer, shared_sources)
        valid_cited = [c for c in cited if c.chunk_id in valid_ids]
        clean = _strip_markers(raw_answer)
        grounded = len(valid_cited) > 0
        confidence = 0 if not grounded else 0.7 if len(valid_cited) >= 2 else 0.5

        if grounded and _confidence_llm_enabled():
            try:
                cited_chunks = [s for c in valid_cited for s in shared_sources if s.chunk_id == c.chunk_id]
                src = "\n".join(f'<chunk id="{c.chunk_id}">{c.text}</chunk>' for c in cited_chunks)
                scored = await call_mistral_text(
                    system=CONFIDENCE_SYSTEM_V1,
                    user=f"<answer>\n{raw_answer}\n</answer>\n\n<sources>\n{src}\n</sources>",
                    max_tokens=16, model=MODEL_FAST,
                )
                total_in += scored["usage"].input_tokens
                total_out += scored["usage"].output_tokens
                m = re.search(r"[01](?:\.\d+)?", scored["text"])
                if m:
                    confidence = max(0.0, min(1.0, float(m.group(0))))
            except Exception:  # noqa: BLE001
                pass

        gap_flag = "no_source" if not grounded else "ok" if confidence >= 0.7 else "partial"
        status = "draft" if (confidence >= 0.7 and gap_flag == "ok") else "requires_review"
        _upsert_response(
            db, question_id=q.question_id, with_markers=raw_answer,
            clean=clean if grounded else "", tone=tone, confidence=confidence,
            gap_flag=gap_flag, status=status, citations=valid_cited,
        )

    return GenerationUsage(total_in, total_out)


# ── helpers ─────────────────────────────────────────────────────────────────
def _voice_examples(db, org_id: str) -> list[str]:
    try:
        rows = db.get(
            "responses",
            {
                "select": "final_text,draft_text,questions!inner(documents!inner(deals!inner(org_id)))",
                "status": "eq.approved",
                "questions.documents.deals.org_id": f"eq.{org_id}",
                "final_text": "not.is.null",
                "limit": "3",
            },
        )
    except Exception:  # noqa: BLE001
        return []
    out = []
    for r in rows or []:
        v = (r.get("final_text") or r.get("draft_text") or "")[:600]
        if v:
            out.append(v)
    return out[:3]


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


def _build_generator_user(org_name, question_text, voice_examples, sources: list[Candidate]) -> str:
    voice = ""
    if voice_examples:
        examples = "\n".join(f"<example>{v}</example>" for v in voice_examples)
        voice = f"<voice_examples>\n{examples}\n</voice_examples>"
    src = "\n".join(
        f'<chunk id="{i + 1}" doc="{_esc(c.document_filename)}" section="{_esc(c.section_path or "")}" page="{c.page_start if c.page_start is not None else ""}">\n{c.text}\n</chunk>'
        for i, c in enumerate(sources)
    )
    return (
        f"Company: {org_name}\n\n<requirement>\n{question_text}\n</requirement>\n\n{voice}\n\n"
        f"<sources>\n{src}\n</sources>\n\n"
        "Write the answer now. Cite every supported claim with the chunk's number in square brackets, "
        "e.g. [c:1] or [c:3]. Use only the numbers shown in <sources>."
    )


def _build_batch_generator_user(org_name, questions: list[str], voice_examples, sources: list[Candidate]) -> str:
    voice = ""
    if voice_examples:
        examples = "\n".join(f"<example>{v}</example>" for v in voice_examples)
        voice = f"<voice_examples>\n{examples}\n</voice_examples>\n\n"
    src = "\n".join(
        f'<chunk id="{i + 1}" doc="{_esc(c.document_filename)}" page="{c.page_start if c.page_start is not None else ""}">\n{c.text[:1600]}\n</chunk>'
        for i, c in enumerate(sources)
    )
    qs = "\n".join(f'<question n="{i + 1}">{q}</question>' for i, q in enumerate(questions))
    return (
        f"Company: {org_name}\n\n{voice}<sources>\n{src}\n</sources>\n\n"
        f"<questions>\n{qs}\n</questions>\n\n"
        f"Answer all {len(questions)} questions. Cite with chunk numbers from <sources>, e.g. [c:2]."
    )


def _extract_citations(text_with_markers: str, sources: list[Candidate]) -> list[ParsedCitation]:
    out: list[ParsedCitation] = []
    seen: set[int] = set()
    for m in _CITE_RE.finditer(text_with_markers):
        n = int(m.group(1))
        if n in seen:
            continue
        if n - 1 < 0 or n - 1 >= len(sources):
            continue
        src = sources[n - 1]
        seen.add(n)
        before = re.sub(r"\s+", " ", text_with_markers[: m.start()]).strip()
        sentences = re.split(r"(?<=[.!?])\s+", before)
        quote = (sentences[-1] if sentences and sentences[-1] else src.text[:200])[:400]
        out.append(
            ParsedCitation(
                chunk_id=src.chunk_id,
                document_filename=src.document_filename,
                section_path=src.section_path,
                page=src.page_start,
                quote=quote,
            )
        )
    return out


def _strip_markers(text: str) -> str:
    return re.sub(r"\s+", " ", _CITE_RE.sub("", text)).strip()


def _upsert_response(
    db, *, question_id: str, with_markers: str, clean: str, tone: str, confidence: float,
    gap_flag: str, status: str, citations: list[ParsedCitation],
) -> None:
    existing = db.get("responses", {"select": "id", "question_id": f"eq.{question_id}", "limit": "1"})
    payload = {
        "question_id": question_id,
        "ai_generated_draft": clean,
        "draft_text": clean,
        "answer_text_with_markers": with_markers,
        "tone": tone,
        "confidence": confidence,
        "gap_flag": gap_flag,
        "status": status,
        "generated_by": "ai",
    }
    if existing:
        response_id = existing[0]["id"]
        db.update("responses", {"id": f"eq.{response_id}"}, payload)
    else:
        inserted = db.insert("responses", payload)
        if not inserted:
            raise RuntimeError("Response insert failed")
        response_id = inserted[0]["id"]

    db.delete("citations", {"response_id": f"eq.{response_id}"})
    if citations:
        db.insert(
            "citations",
            [
                {
                    "response_id": response_id,
                    "chunk_id": c.chunk_id,
                    "document_filename": c.document_filename,
                    "section_path": c.section_path,
                    "page": c.page,
                    "quote": c.quote,
                }
                for c in citations
            ],
        )

    if status == "requires_review":
        db.update("questions", {"id": f"eq.{question_id}"}, {"status": "drafting"})
