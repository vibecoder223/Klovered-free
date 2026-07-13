"""Job queue for the async, resumable document pipeline (port of lib/jobs.ts).

Each stage is an idempotent row in `jobs` (migration 0010). The drain endpoint
claims a small batch, runs one stage per row, then enqueues the successor
stage(s). A failed unit retries with backoff on its own; it never re-runs the
whole document. See docs/superpowers/specs/2026-05-30-async-pipeline-design.md.

`db` is a service-role SupabaseRest (RLS bypassed), matching the TS admin client.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

import httpx

from ..mistral import MODEL_FAST
from .agents import (
    Doc,
    ExtractedRequirement,
    record_run,
    run_chunking_agent,
    run_extraction_agent,
    run_ingestion_agent,
    run_structuring_agent,
)
from .chunk import ProducedChunk
from .rag import BatchQuestion, generate_and_persist_answer, generate_batch_answers

JobStage = str  # "ingest" | "extract" | "structure" | "generate"
JobStatus = str  # "pending" | "claimed" | "done" | "failed" | "dead"

PG_UNIQUE_VIOLATION = "23505"


@dataclass
class Job:
    id: str
    document_id: str
    org_id: str
    stage: JobStage
    target_id: str | None
    status: JobStatus
    attempts: int
    max_attempts: int

    @classmethod
    def from_row(cls, r: dict) -> "Job":
        return cls(
            id=r["id"],
            document_id=r["document_id"],
            org_id=r["org_id"],
            stage=r["stage"],
            target_id=r.get("target_id"),
            status=r["status"],
            attempts=r.get("attempts", 0),
            max_attempts=r.get("max_attempts", 0),
        )


def _now_iso() -> str:
    # time.time()*1000 ms → ISO 8601 UTC, mirroring new Date().toISOString().
    return (
        time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        + f".{int((time.time() % 1) * 1000):03d}Z"
    )


def _iso_at(ms_from_now: float) -> str:
    t = time.time() + ms_from_now / 1000
    return (
        time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t))
        + f".{int((t % 1) * 1000):03d}Z"
    )


# ---------- enqueue ----------


def enqueue_job(
    db, *, document_id: str, org_id: str, stage: JobStage, target_id: str | None = None
) -> None:
    """Insert a job, swallowing the unique-violation when a live row already exists."""
    try:
        db.insert(
            "jobs",
            {
                "document_id": document_id,
                "org_id": org_id,
                "stage": stage,
                "target_id": target_id,
            },
        )
    except httpx.HTTPStatusError as e:
        code = None
        try:
            code = e.response.json().get("code")
        except Exception:  # noqa: BLE001 — non-JSON error body
            pass
        if code != PG_UNIQUE_VIOLATION:
            raise RuntimeError(f"enqueue failed: {e.response.text}") from e


def enqueue_ingest(db, *, document_id: str, org_id: str) -> None:
    """Kick off a document by queuing its first stage."""
    enqueue_job(db, document_id=document_id, org_id=org_id, stage="ingest")


# ---------- drain (port of app/api/jobs/drain/route.ts) ----------

DRAIN_BATCH = 8
DRAIN_TIME_BUDGET_MS = 4 * 60_000


async def run_drain(
    db, *, batch: int = DRAIN_BATCH, time_budget_ms: float = DRAIN_TIME_BUDGET_MS
) -> dict:
    """Heartbeat drain loop: recover stuck claims, then claim a small batch, run
    it concurrently, enqueue successors, repeat — until the queue is empty or
    the time budget is spent. Called directly in-process (this is a persistent
    server, not serverless, so no self-HTTP round-trip is needed as the TS
    fire-and-forget fetch did)."""
    recover_stuck_jobs(db)

    started_at = time.time() * 1000
    all_results: list[dict] = []
    total_claimed = 0

    while True:
        claimed = claim_jobs(db, batch)
        if not claimed:
            break
        total_claimed += len(claimed)
        touched_docs: set[str] = set()

        async def _run_one(job: Job) -> dict:
            touched_docs.add(job.document_id)
            try:
                await run_job(db, job)
                # Enqueue successors BEFORE marking done. If this crashes
                # mid-fan-out the stage stays claimed, gets recovered, and
                # re-runs — re-enqueue is idempotent (unique-live index).
                # Marking done first would leave a permanent gap: a "done"
                # stage with missing successors that nothing ever revisits.
                enqueue_successors(db, job)
                mark_done(db, job.id)
                return {"id": job.id, "stage": job.stage, "ok": True}
            except Exception as e:  # noqa: BLE001 — record then continue draining
                mark_failed(db, job, str(e) or "stage failed")
                return {"id": job.id, "stage": job.stage, "ok": False, "error": str(e)}

        results = await asyncio.gather(*(_run_one(job) for job in claimed))
        all_results.extend(results)

        # Status updates inside the loop so the UI tracks progress live.
        for document_id in touched_docs:
            derive_doc_status(db, document_id)

        if time.time() * 1000 - started_at > time_budget_ms:
            break

    return {"claimed": total_claimed, "results": all_results}


# ---------- claim / drain primitives ----------


def recover_stuck_jobs(db) -> None:
    db.rpc("recover_stuck_jobs")


def claim_jobs(db, limit: int) -> list[Job]:
    rows = db.rpc("claim_jobs", {"p_limit": limit}) or []
    return [Job.from_row(r) for r in rows]


def _backoff_ms(attempts: int) -> int:
    """Retry backoff in ms, indexed by attempt count just made."""
    table = [5_000, 30_000, 120_000]
    return table[attempts - 1] if 1 <= attempts <= len(table) else 120_000


def mark_done(db, job_id: str) -> None:
    db.update("jobs", {"id": f"eq.{job_id}"}, {"status": "done", "updated_at": _now_iso()})


def mark_failed(db, job: Job, message: str) -> None:
    """Failed unit: re-queue with backoff, or bury as 'dead' once attempts exhausted."""
    dead = job.attempts >= job.max_attempts
    db.update(
        "jobs",
        {"id": f"eq.{job.id}"},
        {
            "status": "dead" if dead else "pending",
            "error": message[:1000],
            "run_after": _now_iso() if dead else _iso_at(_backoff_ms(job.attempts)),
            "lease_until": None,
            "updated_at": _now_iso(),
        },
    )


# ---------- stage dispatch ----------


def _load_doc(db, document_id: str) -> Doc:
    rows = db.get(
        "documents",
        {
            "select": "id,deal_id,filename,file_path,mime_type,extracted_text",
            "id": f"eq.{document_id}",
            "limit": "1",
        },
    )
    if not rows:
        raise RuntimeError("Document not found")
    r = rows[0]
    return Doc(
        id=r["id"],
        deal_id=r["deal_id"],
        filename=r["filename"],
        file_path=r["file_path"],
        mime_type=r.get("mime_type"),
        extracted_text=r.get("extracted_text"),
    )


async def run_job(db, job: Job) -> None:
    """Run one job's stage. Raises on failure (drain decides retry vs dead)."""
    doc = _load_doc(db, job.document_id)

    if job.stage == "ingest":
        # Deterministic from the file: parse → chunk → embed, all persisted.
        parsed = await run_ingestion_agent(db, doc)
        await run_chunking_agent(db, doc, parsed)
        return
    if job.stage == "extract":
        chunks = _read_chunks(db, job.document_id)
        await run_extraction_agent(db, doc, chunks)
        return
    if job.stage == "structure":
        reqs = _read_requirements(db, job.document_id)
        await run_structuring_agent(db, doc, reqs)
        return
    if job.stage == "generate":
        # New shape: one doc-level job (target_id null) answers every question in
        # grouped batch calls. Legacy per-question rows (target_id set) may still
        # exist from before the cutover — run those through the single path.
        if job.target_id:
            await _run_generate(db, job)
        else:
            await _run_generate_batched(db, job)
        return


def enqueue_successors(db, job: Job) -> None:
    """Enqueue the next stage(s) after a job completes. Idempotent — duplicate
    inserts are swallowed by the unique-live index."""
    base = {"document_id": job.document_id, "org_id": job.org_id}
    if job.stage == "ingest":
        enqueue_job(db, **base, stage="extract")
    elif job.stage == "extract":
        enqueue_job(db, **base, stage="structure")
    elif job.stage == "structure":
        # ONE doc-level generate job answers all questions in grouped batch calls
        # (see _run_generate_batched) — replaces the old per-question fan-out that
        # cost one LLM call per question.
        enqueue_job(db, **base, stage="generate")
    # generate: terminal, no successor.


# ---------- derived document status ----------

STAGE_RUNNING_STATUS: dict[JobStage, str] = {
    "ingest": "extracting",
    "extract": "analyzing",
    "structure": "analyzing",
    "generate": "structured",
}

STAGE_DEAD_STATUS: dict[JobStage, str] = {
    "ingest": "failed",
    "extract": "extraction_failed",
    "structure": "failed",
    "generate": "generation_failed",
}

STAGE_ORDER: list[JobStage] = ["ingest", "extract", "structure", "generate"]


def derive_doc_status(db, document_id: str) -> None:
    """Recompute documents.processing_status from the document's job rows."""
    jobs = db.get(
        "jobs", {"select": "stage,status", "document_id": f"eq.{document_id}"}
    ) or []
    if not jobs:
        return

    dead = [j for j in jobs if j["status"] == "dead"]
    active = [j for j in jobs if j["status"] in ("pending", "claimed")]

    # A dead PRE-generate stage (ingest/extract/structure) blocks everything
    # downstream — that's a genuine hard fail. A dead *generate* job only kills
    # one question's answer; the document is still usable if other questions
    # succeeded. Never let one dead answer condemn the whole document.
    blocking_dead = next((j for j in dead if j["stage"] != "generate"), None)
    gen_jobs = [j for j in jobs if j["stage"] == "generate"]
    gen_done = [j for j in gen_jobs if j["status"] == "done"]

    if blocking_dead:
        status = STAGE_DEAD_STATUS[blocking_dead["stage"]]
    elif active:
        # Coarse phase = the earliest stage with active work.
        stage = next(
            (s for s in STAGE_ORDER if any(j["stage"] == s for j in active)), "generate"
        )
        status = STAGE_RUNNING_STATUS[stage]
    elif gen_jobs and not gen_done:
        # Every answer failed — nothing usable produced.
        status = STAGE_DEAD_STATUS["generate"]
    else:
        # No active work, no blocking failure, at least one answer produced.
        # Completed — possibly partial (some generate jobs may be dead).
        status = "completed"

    db.update(
        "documents",
        {"id": f"eq.{document_id}"},
        {"processing_status": status, "updated_at": _now_iso()},
    )


# ---------- helpers ----------


def _read_chunks(db, document_id: str) -> list[ProducedChunk]:
    rows = db.get(
        "document_chunks",
        {
            "select": "raw_text,cleaned_text,section_path,page_start,page_end,sparse_terms",
            "document_id": f"eq.{document_id}",
            "order": "chunk_index.asc",
        },
    ) or []
    return [
        ProducedChunk(
            text=r.get("cleaned_text") or r.get("raw_text") or "",
            text_for_embedding=r.get("cleaned_text") or r.get("raw_text") or "",
            section_path=r.get("section_path") or "",
            page_start=r.get("page_start") or 0,
            page_end=r.get("page_end") or r.get("page_start") or 0,
            sparse_terms=r.get("sparse_terms") or [],
        )
        for r in rows
    ]


def _read_requirements(db, document_id: str) -> list[ExtractedRequirement]:
    rows = db.get(
        "extracted_requirements",
        {
            "select": "requirement_id,description,section,source_page,classification,topic",
            "document_id": f"eq.{document_id}",
        },
    ) or []
    return [
        ExtractedRequirement(
            requirement_id=str(r.get("requirement_id") or ""),
            section=r.get("section"),
            text=r.get("description") or "",
            classification=r.get("classification") or "must",
            topic=r.get("topic") or "technical",
            source_page=r.get("source_page"),
        )
        for r in rows
    ]


def _org_name_from_question(q: dict) -> str:
    docs = q.get("documents") or {}
    deals = docs.get("deals") if isinstance(docs, dict) else None
    if isinstance(deals, dict):
        org = deals.get("organizations")
        if isinstance(org, dict) and org.get("name"):
            return org["name"]
    if isinstance(deals, list) and deals:
        org = deals[0].get("organizations")
        if isinstance(org, list) and org:
            return org[0].get("name") or "Workspace"
        if isinstance(org, dict):
            return org.get("name") or "Workspace"
    return "Workspace"


async def _run_generate(db, job: Job) -> None:
    rows = db.get(
        "questions",
        {
            "select": "id,question_text,documents(deals(organizations(name)))",
            "id": f"eq.{job.target_id}",
            "limit": "1",
        },
    )
    if not rows:
        raise RuntimeError("Question not found")
    q = rows[0]
    await generate_and_persist_answer(
        db,
        question_id=q["id"],
        question_text=q["question_text"],
        org_id=job.org_id,
        org_name=_org_name_from_question(q),
        tone="technical",
    )


# Questions per batched LLM call. 5 keeps the shared-source list relevant to
# every question in the group and the JSON output well under max_tokens.
GENERATE_BATCH_SIZE = 5


async def _run_generate_batched(db, job: Job) -> None:
    """Doc-level generate: answer every unanswered question in grouped batch calls.

    Idempotent — questions that already have a response are skipped, so a retry
    after a mid-run failure only redoes the unanswered remainder. The job lease
    is 5 minutes; a heartbeat extends it while sub-batches are in flight so a
    long free-tier-paced run isn't reclaimed as stuck mid-work.
    """
    q_rows = db.get(
        "questions",
        {
            "select": "id,question_text,category,documents(deals(organizations(name)))",
            "document_id": f"eq.{job.document_id}",
        },
    ) or []
    if not q_rows:
        return

    org_name = _org_name_from_question(q_rows[0])

    # Skip questions that already have a response (idempotent retry).
    ids = [q["id"] for q in q_rows]
    existing = db.get(
        "responses",
        {"select": "question_id", "question_id": f"in.({','.join(ids)})"},
    ) or []
    answered = {r["question_id"] for r in existing}
    pending = [q for q in q_rows if q["id"] not in answered]
    if not pending:
        return

    # Group by category so each batch shares a topical source pool, then split
    # into fixed-size sub-batches.
    by_category: dict[str, list[dict]] = {}
    for q in pending:
        by_category.setdefault(q.get("category") or "general", []).append(q)

    sub_batches: list[list[BatchQuestion]] = []
    for group in by_category.values():
        for i in range(0, len(group), GENERATE_BATCH_SIZE):
            sub_batches.append(
                [
                    BatchQuestion(question_id=q["id"], question_text=q["question_text"])
                    for q in group[i : i + GENERATE_BATCH_SIZE]
                ]
            )

    # Lease heartbeat — extend while working so recover_stuck_jobs leaves us be.
    stop = asyncio.Event()

    async def _heartbeat() -> None:
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=60)
            except asyncio.TimeoutError:
                db.update(
                    "jobs", {"id": f"eq.{job.id}"}, {"lease_until": _iso_at(5 * 60_000)}
                )

    hb_task = asyncio.create_task(_heartbeat())

    started_at = time.time() * 1000
    totals = {"in": 0, "out": 0}

    async def _run_batches(batches: list[list[BatchQuestion]]) -> list[list[BatchQuestion]]:
        settled = await asyncio.gather(
            *(
                generate_batch_answers(
                    db, org_id=job.org_id, org_name=org_name, tone="technical", questions=batch
                )
                for batch in batches
            ),
            return_exceptions=True,
        )
        still_failed: list[list[BatchQuestion]] = []
        for i, r in enumerate(settled):
            if isinstance(r, Exception):
                still_failed.append(batches[i])
            else:
                totals["in"] += r.input_tokens
                totals["out"] += r.output_tokens
        return still_failed

    try:
        # Fire all sub-batches; the process-wide rate gate in app/mistral.py paces
        # request starts. Any sub-batch that throws (e.g. an exhausted rate-limit
        # retry) is retried once inline — no re-answering of questions that
        # already succeeded, since generate_batch_answers skips persisted responses.
        failed_batches = await _run_batches(sub_batches)
        if failed_batches:
            failed_batches = await _run_batches(failed_batches)

        # Resilience: a document must never end in a hard failure just because a
        # few sub-batches couldn't complete. Count how many questions actually got
        # a response. If ANY did, complete the stage — the unanswered remainder is
        # left as regenerable "todo" rather than condemning the whole document. We
        # only fail the stage (letting the job retry, then surface an error) when
        # ZERO answers were produced, i.e. a real systemic failure (bad key, etc.).
        pending_ids = [q["id"] for q in pending]
        answered_rows = db.get(
            "responses",
            {"select": "question_id", "question_id": f"in.({','.join(pending_ids)})"},
        ) or []
        answered_count = len(answered_rows)

        if answered_count == 0:
            raise RuntimeError(
                f"generation produced no answers: "
                f"{len(failed_batches)}/{len(sub_batches)} sub-batches failed"
            )

        record_run(
            db,
            document_id=job.document_id,
            agent_type="generate",
            status="completed",
            input_tokens=totals["in"],
            output_tokens=totals["out"],
            result={
                "questions": len(pending),
                "answered": answered_count,
                "unanswered": len(pending) - answered_count,
                "sub_batches": len(sub_batches),
                "failed_sub_batches": len(failed_batches),
                "model": MODEL_FAST,
            },
            started_at=started_at,
        )
    except Exception as e:  # noqa: BLE001 — record then re-raise, mirroring TS
        record_run(
            db,
            document_id=job.document_id,
            agent_type="generate",
            status="failed",
            input_tokens=totals["in"],
            output_tokens=totals["out"],
            error_message=str(e),
            result={
                "questions": len(pending),
                "sub_batches": len(sub_batches),
                "model": MODEL_FAST,
            },
            started_at=started_at,
        )
        raise
    finally:
        stop.set()
        hb_task.cancel()
        try:
            await hb_task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
