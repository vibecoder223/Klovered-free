/**
 * Generation with citations + confidence scoring. The grounded answer
 * generator. Persists to `responses` + `citations`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { callMistralJson, callMistralText, MODEL, MODEL_FAST, fastLaneSaturated, hasLlmKey } from "./mistral";
import { embedTexts, hasEmbeddings } from "./embeddings";
import { isNoSource, retrieveForQuery, retrieveForQueries, type Candidate } from "./retrieval";
import { suggestAnswers, suggestAnswersByEmbeddings, recordReuse, LIBRARY_REUSE_MIN } from "./answer-library";

const PROMPTS = {
  generator_system_v1: `You are a proposal writer at the customer's company. You write answers to RFP requirements in the customer's own voice, drawing exclusively from the source chunks provided. You never invent facts. You never speculate. You never use external knowledge.

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
8. Length: match the requirement. "Describe" gets 100-200 words. "Confirm" gets one sentence. Do not pad.`,
  // Batched variant: N questions against ONE shared, deduplicated source list.
  // Kept lean — this prefix is the per-call overhead the batching amortizes.
  generator_batch_system_v1: `You are a proposal writer at the customer's company, answering RFP requirements in the customer's voice using ONLY the source chunks provided.

Rules:
1. Every sentence must be individually traceable to a specific chunk — if you can't point to the exact chunk supporting a sentence, delete that sentence rather than cite a nearby chunk hoping it's close enough.
2. Never combine facts from unrelated chunks (e.g. don't take a remediation timeline from a security chunk and apply it to a support-SLA answer), and never generalize a chunk's specific claim into a broader capability it doesn't state.
3. Cite every supported claim inline as [c:N] using that chunk's number. Never invent facts or use outside knowledge.
4. Business prose: confident, specific, concise. Match the voice examples if provided.
5. If the sources do not cover a question — including when a chunk is only topically related but doesn't state the specific fact asked — that answer must be exactly "NO_SOURCE".
6. Length follows the question: "describe/explain" 100-200 words; "confirm/yes-no" 1-2 sentences. No padding.

Return ONLY a JSON array, one item per question, no fences:
[{"q": <question number>, "answer": "<answer text with [c:N] citations>"}]`,
  confidence_system_v1: `Score this answer's grounding 0.0-1.0.

- 1.0: every claim is directly supported by a cited chunk.
- 0.7: mostly supported; minor unsupported phrasing.
- 0.4: partially supported; weak source coverage on some claims.
- 0.0: not grounded.

Output a single decimal number, nothing else.`,
  // Batched variant of the scorer: several independent answers in one call.
  // Each <item> carries ONLY its own cited chunks, so the judgment per answer
  // is identical to the single-answer scorer — batching amortizes the call
  // overhead (and the per-call rate-gate spacing), not the evidence scope.
  confidence_batch_system_v1: `You are scoring how well each answer is grounded in its OWN cited source chunks. Score each item independently — never let one item's sources influence another's score.

Per item, score 0.0-1.0:
- 1.0: every claim is directly supported by that item's cited chunks.
- 0.7: mostly supported; minor unsupported phrasing.
- 0.4: partially supported; weak source coverage on some claims.
- 0.0: not grounded.

Return ONLY a JSON array, one entry per item, no fences:
[{"q": <item number>, "score": <decimal>}]`,
};

export type GenerationUsage = { input_tokens: number; output_tokens: number };

export async function generateAndPersistAnswer(
  supabase: SupabaseClient,
  args: {
    question_id: string;
    question_text: string;
    org_id: string;
    org_name: string;
    tone?: string;
  }
): Promise<GenerationUsage> {
  let totalIn = 0;
  let totalOut = 0;

  // 0. Library-first. If a near-identical question was already approved for this
  // org, draft that approved answer verbatim and skip retrieval + the LLM
  // entirely — faster, free, and consistent with what a human already signed
  // off. Still routed to review so a person confirms the reuse. Cross-tenant
  // safety is enforced inside match_answers (org-scoped).
  const libMatches = await suggestAnswers(supabase, {
    org_id: args.org_id,
    question_text: args.question_text,
    limit: 1,
  });
  const reuse = libMatches[0];
  if (
    reuse &&
    reuse.similarity >= LIBRARY_REUSE_MIN &&
    reuse.source_question_id !== args.question_id &&
    reuse.response_text?.trim()
  ) {
    await upsertResponse(supabase, {
      question_id: args.question_id,
      answer_text_with_markers: reuse.response_text,
      answer_text_clean: reuse.response_text,
      tone: args.tone || "technical",
      confidence: 0.95,
      gap_flag: "ok",
      status: "requires_review",
      generated_by: "ai",
      citations: [],
    });
    void recordReuse(supabase, reuse.id);
    return { input_tokens: totalIn, output_tokens: totalOut };
  }

  // 1. Retrieve
  const retrieval = await retrieveForQuery(supabase, {
    org_id: args.org_id,
    query: args.question_text,
    topK: 6,
  });
  totalIn += retrieval.usage.input_tokens;
  totalOut += retrieval.usage.output_tokens;

  // 2. Gap gate
  if (isNoSource(retrieval.top_score, retrieval.candidates.length)) {
    await upsertResponse(supabase, {
      question_id: args.question_id,
      // Keep the sentinel as an internal record of WHY there's no draft, but
      // leave the user-facing draft empty — the no_source gap_flag drives the
      // "No source found" banner. Never leak the sentinel into the draft box.
      answer_text_with_markers:
        "NO_SOURCE: The knowledge base does not contain content sufficient to answer this requirement.",
      answer_text_clean: "",
      tone: args.tone || "technical",
      confidence: 0,
      gap_flag: "no_source",
      status: "requires_review",
      generated_by: "ai",
      citations: [],
    });
    return { input_tokens: totalIn, output_tokens: totalOut };
  }

  // 3. Voice examples — pull a couple of approved answers from THIS org only.
  // responses carry no org column, so join question → document → deal → org and
  // inner-filter on deals.org_id. Without this, approved answers from every
  // tenant leak into this prompt (one customer's prose drafted into another's
  // proposal — a cross-tenant data leak).
  const { data: priorApproved } = await supabase
    .from("responses")
    .select("final_text, draft_text, questions!inner(documents!inner(deals!inner(org_id)))")
    .eq("status", "approved")
    .eq("questions.documents.deals.org_id", args.org_id)
    .not("final_text", "is", null)
    .limit(3);

  const voiceExamples = (priorApproved ?? [])
    .map((r: any) => (r.final_text || r.draft_text || "").slice(0, 600))
    .filter(Boolean)
    .slice(0, 3);

  // 4. Generate
  if (!hasLlmKey()) {
    await upsertResponse(supabase, {
      question_id: args.question_id,
      answer_text_with_markers: "AI_DISABLED: no LLM API key configured.",
      answer_text_clean: "AI_DISABLED: no LLM API key configured.",
      tone: args.tone || "technical",
      confidence: 0,
      gap_flag: "no_source",
      status: "requires_review",
      generated_by: "ai",
      citations: [],
    });
    return { input_tokens: totalIn, output_tokens: totalOut };
  }

  const user = buildGeneratorUser({
    org_name: args.org_name,
    question_text: args.question_text,
    voice_examples: voiceExamples,
    sources: retrieval.candidates,
  });

  // Generation is the many-small-calls workload (up to one per question on
  // this fallback path) — routed to MODEL_FAST, whose rate limit is far
  // higher than the extraction model's (see lib/mistral.ts gateConfigFor).
  const { text: rawAnswer, usage: genUsage } = await callMistralText({
    system: PROMPTS.generator_system_v1,
    user,
    maxTokens: 900,
    model: MODEL_FAST,
  });
  totalIn += genUsage.input_tokens;
  totalOut += genUsage.output_tokens;

  // 5. Detect the model's NO_SOURCE sentinel
  if (/^\s*NO_SOURCE:/i.test(rawAnswer)) {
    await upsertResponse(supabase, {
      question_id: args.question_id,
      // Record the model's sentinel internally; keep the draft box empty so the
      // banner — not raw "NO_SOURCE:" text — communicates the gap to the user.
      answer_text_with_markers: rawAnswer.trim(),
      answer_text_clean: "",
      tone: args.tone || "technical",
      confidence: 0,
      gap_flag: "no_source",
      status: "requires_review",
      generated_by: "ai",
      citations: [],
    });
    return { input_tokens: totalIn, output_tokens: totalOut };
  }

  // 6. Parse citation markers
  const validIds = new Set(retrieval.candidates.map((c) => c.chunk_id));
  const cited = extractCitations(rawAnswer, retrieval.candidates);
  // Grounding truth = citations that resolve to a REAL retrieved chunk. A model
  // that free-writes with no markers, or sprays invalid ones (e.g. [c:1,2,3…]),
  // resolves to zero here — that answer is ungrounded no matter how fluent it is.
  const validCited = cited.filter((c) => validIds.has(c.chunk_id));
  const clean = stripMarkers(rawAnswer);

  // 7. Confidence — heuristic from citation count, not a second LLM call.
  // The dedicated scorer added ~3-5s per question and a full extra request to
  // Cerebras's 30 RPM budget. With Cerebras free tier that doubled total time
  // for diminishing quality signal. Set RAG_USE_CONFIDENCE_LLM=1 to opt back
  // into the LLM-scored path.
  let confidence = validCited.length === 0 ? 0 : validCited.length >= 2 ? 0.7 : 0.5;

  if (process.env.RAG_USE_CONFIDENCE_LLM === "1") {
    try {
      const { text, usage } = await callMistralText({
        system: PROMPTS.confidence_system_v1,
        user: `<answer>
${rawAnswer}
</answer>

<sources>
${retrieval.candidates.map((c) => `<chunk id="${c.chunk_id}">${c.text}</chunk>`).join("\n")}
</sources>`,
        maxTokens: 16,
        model: MODEL_FAST,
      });
      totalIn += usage.input_tokens;
      totalOut += usage.output_tokens;
      const m = text.match(/[01](?:\.\d+)?/);
      if (m) confidence = Math.max(0, Math.min(1, parseFloat(m[0])));
    } catch {
      // Leave heuristic confidence if scorer fails.
    }
  }

  const grounded = validCited.length > 0;
  const gap_flag: "ok" | "partial" | "no_source" =
    !grounded ? "no_source" : confidence >= 0.7 ? "ok" : "partial";
  const status: "draft" | "requires_review" =
    confidence >= 0.7 && gap_flag === "ok" ? "draft" : "requires_review";

  await upsertResponse(supabase, {
    question_id: args.question_id,
    answer_text_with_markers: rawAnswer.trim(),
    // Ungrounded prose (no citation resolves to a real chunk) is a hallucination.
    // Keep it only as an internal record; never surface it in the draft box — the
    // no_source gap_flag drives the "No source found" banner instead.
    answer_text_clean: grounded ? clean : "",
    tone: args.tone || "technical",
    confidence,
    gap_flag,
    status,
    generated_by: "ai",
    citations: validCited,
  });

  return { input_tokens: totalIn, output_tokens: totalOut };
}

// ---------- batched generation ----------

export type BatchQuestion = { question_id: string; question_text: string };

const BatchAnswerSchema = z.array(
  z.object({
    q: z.coerce.number().int().min(1),
    answer: z.string(),
  })
);

const BatchScoreSchema = z.array(
  z.object({
    q: z.coerce.number().int().min(1),
    score: z.coerce.number().min(0).max(1),
  })
);

/** Max unique chunks sent in one batched call (~400 tokens each). */
const BATCH_SOURCE_CAP = 14;
/** Each question's top-K chunks are guaranteed a slot before global fill. */
const PER_QUESTION_GUARANTEE = 3;

/**
 * Answer several questions in ONE LLM call against a shared, deduplicated
 * source list. Token math vs the per-question path: the system prompt, voice
 * examples, and overlapping chunks are sent once per group instead of once per
 * question — on a typical 5-question group that's a 60-70% input reduction.
 *
 * Library reuse and the no-source gap gate still run per question (both are
 * LLM-free). Questions that fail the batch call fall back to the proven
 * single-question path so one malformed JSON response can't strand a group.
 */
export async function generateBatchAnswers(
  supabase: SupabaseClient,
  args: {
    org_id: string;
    org_name: string;
    tone?: string;
    questions: BatchQuestion[];
  }
): Promise<GenerationUsage> {
  let totalIn = 0;
  let totalOut = 0;
  if (args.questions.length === 0) return { input_tokens: 0, output_tokens: 0 };

  // Embed every question ONCE up front and reuse that embedding for both the
  // library lookup and retrieval — the two used to embed the same text
  // separately, doubling calls to a 60 RPM endpoint. Best-effort: on embed
  // failure we proceed with empty embeddings (library skipped, retrieval falls
  // back to BM25) rather than failing the batch.
  let queryEmbeddings: number[][] = [];
  if (hasEmbeddings()) {
    try {
      queryEmbeddings = await embedTexts(args.questions.map((q) => q.question_text), "query");
    } catch {
      queryEmbeddings = [];
    }
  }

  // 0. Library-first (embedding similarity only — no LLM). One shared embed set.
  const needsGeneration: BatchQuestion[] = [];
  const needsEmbeddings: number[][] = [];
  const libMatches = await suggestAnswersByEmbeddings(supabase, {
    org_id: args.org_id,
    embeddings: args.questions.map((_, i) => queryEmbeddings[i]),
  });
  for (let i = 0; i < args.questions.length; i++) {
    const q = args.questions[i];
    const reuse = libMatches[i];
    if (
      reuse &&
      reuse.similarity >= LIBRARY_REUSE_MIN &&
      reuse.source_question_id !== q.question_id &&
      reuse.response_text?.trim()
    ) {
      await upsertResponse(supabase, {
        question_id: q.question_id,
        answer_text_with_markers: reuse.response_text,
        answer_text_clean: reuse.response_text,
        tone: args.tone || "technical",
        confidence: 0.95,
        gap_flag: "ok",
        status: "requires_review",
        generated_by: "ai",
        citations: [],
      });
      void recordReuse(supabase, reuse.id);
    } else {
      needsGeneration.push(q);
      if (queryEmbeddings[i]) needsEmbeddings.push(queryEmbeddings[i]);
    }
  }
  if (needsGeneration.length === 0) return { input_tokens: totalIn, output_tokens: totalOut };

  // 1. Retrieve using the already-computed embeddings (no re-embedding).
  const batchRetrievals = await retrieveForQueries(supabase, {
    org_id: args.org_id,
    queries: needsGeneration.map((q) => q.question_text),
    topK: 6,
    embeddings: needsEmbeddings.length === needsGeneration.length ? needsEmbeddings : undefined,
  });
  const retrievals = needsGeneration.map((q, i) => ({ question: q, retrieval: batchRetrievals[i] }));

  // 2. Gap gate per question; keep the rest.
  const live: typeof retrievals = [];
  for (const item of retrievals) {
    if (isNoSource(item.retrieval.top_score, item.retrieval.candidates.length)) {
      await upsertResponse(supabase, {
        question_id: item.question.question_id,
        answer_text_with_markers:
          "NO_SOURCE: The knowledge base does not contain content sufficient to answer this requirement.",
        answer_text_clean: "",
        tone: args.tone || "technical",
        confidence: 0,
        gap_flag: "no_source",
        status: "requires_review",
        generated_by: "ai",
        citations: [],
      });
    } else {
      live.push(item);
    }
  }
  if (live.length === 0) return { input_tokens: totalIn, output_tokens: totalOut };

  if (!hasLlmKey()) {
    for (const item of live) {
      await upsertResponse(supabase, {
        question_id: item.question.question_id,
        answer_text_with_markers: "AI_DISABLED: no LLM API key configured.",
        answer_text_clean: "AI_DISABLED: no LLM API key configured.",
        tone: args.tone || "technical",
        confidence: 0,
        gap_flag: "no_source",
        status: "requires_review",
        generated_by: "ai",
        citations: [],
      });
    }
    return { input_tokens: totalIn, output_tokens: totalOut };
  }

  // 3. Build the shared source list: each question's top chunks are guaranteed
  // a slot, then remaining capacity fills by global score. Dedup by chunk_id.
  const union = new Map<string, Candidate>();
  for (const item of live) {
    for (const c of item.retrieval.candidates.slice(0, PER_QUESTION_GUARANTEE)) {
      if (!union.has(c.chunk_id)) union.set(c.chunk_id, c);
    }
  }
  const overflow = live
    .flatMap((item) => item.retrieval.candidates.slice(PER_QUESTION_GUARANTEE))
    .filter((c) => !union.has(c.chunk_id))
    .sort((a, b) => b.score - a.score);
  for (const c of overflow) {
    if (union.size >= BATCH_SOURCE_CAP) break;
    union.set(c.chunk_id, c);
  }
  const sharedSources = Array.from(union.values());

  // 4. Voice examples — once per batch, org-scoped (see the single-question
  // path for why the org filter is load-bearing: cross-tenant leak otherwise).
  const { data: priorApproved } = await supabase
    .from("responses")
    .select("final_text, draft_text, questions!inner(documents!inner(deals!inner(org_id)))")
    .eq("status", "approved")
    .eq("questions.documents.deals.org_id", args.org_id)
    .not("final_text", "is", null)
    .limit(3);
  const voiceExamples = (priorApproved ?? [])
    .map((r: any) => (r.final_text || r.draft_text || "").slice(0, 600))
    .filter(Boolean)
    .slice(0, 3);

  // 5. One call for the whole group. Validate; one corrective retry; then fall
  // back to the single-question path for anything still unanswered.
  const user = buildBatchGeneratorUser({
    org_name: args.org_name,
    questions: live.map((l) => l.question.question_text),
    voice_examples: voiceExamples,
    sources: sharedSources,
  });

  const maxTokens = Math.min(4096, 400 + live.length * 350);
  let answers: Map<number, string> | null = null;
  let lastErr = "";
  for (let attempt = 0; attempt < 2 && !answers; attempt++) {
    try {
      const { data, usage } = await callMistralJson<unknown>({
        system: PROMPTS.generator_batch_system_v1,
        user:
          attempt === 0
            ? user
            : `${user}\n\n[Previous attempt failed: ${lastErr}. Return ONLY the JSON array described in the system prompt.]`,
        maxTokens,
        mode: "text",
        // Batched generation defaults to the fast model. Under concurrent
        // documents the fast lane's TPM window saturates (it's the real
        // Mistral cap) — spill this sub-batch to MODEL (mistral-large), whose
        // 400k-TPM budget sits idle once extraction finished. Accuracy is
        // equal-or-better (it's the premium model); the spill only engages
        // when the fast lane would otherwise queue into the next minute.
        model: fastLaneSaturated(Math.ceil(user.length / 4) + maxTokens)
          ? MODEL
          : MODEL_FAST,
      });
      totalIn += usage.input_tokens;
      totalOut += usage.output_tokens;
      const validated = BatchAnswerSchema.safeParse(data);
      if (!validated.success) {
        lastErr = validated.error.issues.slice(0, 3).map((i) => i.message).join("; ");
        continue;
      }
      answers = new Map(validated.data.map((a) => [a.q, a.answer]));
    } catch (e: any) {
      lastErr = e.message;
    }
  }

  const validIds = new Set(sharedSources.map((c) => c.chunk_id));

  // Two-phase persist. Phase 1 (sync, no I/O): classify every question —
  // fallback / NO_SOURCE / answered — and compute the heuristic confidence.
  // Phase 2: ONE batched scorer call refines confidence for every grounded
  // answer at once, then all upserts + fallbacks run concurrently. The old
  // per-question loop serialized ~5 scorer calls + 5 DB round-trips per
  // sub-batch behind the process-wide rate-gate spacing.
  type PreparedAnswer = {
    item: (typeof live)[number];
    rawAnswer: string;
    clean: string;
    validCited: ReturnType<typeof extractCitations>;
    grounded: boolean;
    confidence: number;
  };
  const fallbackItems: Array<(typeof live)[number]> = [];
  const noSourceItems: Array<(typeof live)[number]> = [];
  const prepared: PreparedAnswer[] = [];

  for (let i = 0; i < live.length; i++) {
    const item = live[i];
    const rawAnswer = answers?.get(i + 1)?.trim();

    if (!rawAnswer) {
      // Missing from the batch response — fall back to the proven per-question
      // path rather than leaving a hole. Costs one extra call for that question.
      fallbackItems.push(item);
      continue;
    }
    if (/^\s*"?NO_SOURCE/i.test(rawAnswer)) {
      noSourceItems.push(item);
      continue;
    }

    // Citations index into the SHARED source list — extract against it.
    // Grounding truth = citations that resolve to a real shared chunk. Free-written
    // prose (no markers) or citation-spam ([c:1,2,3…] to invalid ids) resolves to
    // zero — ungrounded, and never surfaced as a draft (see generateAndPersistAnswer).
    const cited = extractCitations(rawAnswer, sharedSources);
    const validCited = cited.filter((c) => validIds.has(c.chunk_id));
    const grounded = validCited.length > 0;
    prepared.push({
      item,
      rawAnswer,
      clean: stripMarkers(rawAnswer),
      validCited,
      grounded,
      confidence: !grounded ? 0 : validCited.length >= 2 ? 0.7 : 0.5,
    });
  }

  // Citation-count is a weak signal — a single valid citation doesn't mean
  // every sentence in the answer is actually supported by it (embellishment,
  // cross-chunk contamination, over-generalization all pass the count check).
  // The independent scorer re-reads each answer against ONLY its cited chunks
  // and catches unsupported sentences the citation check can't see. Batched:
  // one call scores the whole sub-batch; each <item> carries only its own
  // cited chunks, so per-answer judgment is identical to the single scorer.
  const scorable = prepared.filter((p) => p.grounded);
  if (scorable.length > 0 && process.env.RAG_USE_CONFIDENCE_LLM === "1") {
    try {
      const itemsBlock = scorable
        .map((p, idx) => {
          const citedChunks = p.validCited
            .map((c) => sharedSources.find((s) => s.chunk_id === c.chunk_id))
            .filter((c): c is Candidate => !!c);
          return `<item n="${idx + 1}">\n<answer>\n${p.rawAnswer}\n</answer>\n<sources>\n${citedChunks.map((c) => `<chunk id="${c.chunk_id}">${c.text}</chunk>`).join("\n")}\n</sources>\n</item>`;
        })
        .join("\n\n");
      const confMaxTokens = 16 * scorable.length + 32;
      const { data, usage } = await callMistralJson<unknown>({
        system: PROMPTS.confidence_batch_system_v1,
        user: itemsBlock,
        maxTokens: confMaxTokens,
        mode: "text",
        // Same spill rule as generation: don't queue behind a saturated fast
        // lane when the large model's budget is idle.
        model: fastLaneSaturated(Math.ceil(itemsBlock.length / 4) + confMaxTokens)
          ? MODEL
          : MODEL_FAST,
      });
      totalIn += usage.input_tokens;
      totalOut += usage.output_tokens;
      const scores = BatchScoreSchema.safeParse(data);
      if (scores.success) {
        for (const s of scores.data) {
          const p = scorable[s.q - 1];
          if (p) p.confidence = Math.max(0, Math.min(1, s.score));
        }
      }
      // Malformed scorer output → keep heuristic confidence (same as before).
    } catch {
      // Leave heuristic confidence if scorer fails.
    }
  }

  // Persist everything concurrently — rows are independent. A fallback failure
  // still rejects the whole batch (same contract as the old sequential loop).
  const work: Promise<unknown>[] = [];

  for (const item of fallbackItems) {
    work.push(
      (async () => {
        const usage = await generateAndPersistAnswer(supabase, {
          question_id: item.question.question_id,
          question_text: item.question.question_text,
          org_id: args.org_id,
          org_name: args.org_name,
          tone: args.tone,
        });
        totalIn += usage.input_tokens;
        totalOut += usage.output_tokens;
      })()
    );
  }

  for (const item of noSourceItems) {
    work.push(
      upsertResponse(supabase, {
        question_id: item.question.question_id,
        answer_text_with_markers:
          "NO_SOURCE: The knowledge base does not contain content sufficient to answer this requirement.",
        answer_text_clean: "",
        tone: args.tone || "technical",
        confidence: 0,
        gap_flag: "no_source",
        status: "requires_review",
        generated_by: "ai",
        citations: [],
      })
    );
  }

  for (const p of prepared) {
    const gap_flag: "ok" | "partial" | "no_source" =
      !p.grounded ? "no_source" : p.confidence >= 0.7 ? "ok" : "partial";
    const status: "draft" | "requires_review" =
      p.confidence >= 0.7 && gap_flag === "ok" ? "draft" : "requires_review";
    work.push(
      upsertResponse(supabase, {
        question_id: p.item.question.question_id,
        answer_text_with_markers: p.rawAnswer,
        answer_text_clean: p.grounded ? p.clean : "",
        tone: args.tone || "technical",
        confidence: p.confidence,
        gap_flag,
        status,
        generated_by: "ai",
        citations: p.validCited,
      })
    );
  }

  await Promise.all(work);

  return { input_tokens: totalIn, output_tokens: totalOut };
}

function buildBatchGeneratorUser(args: {
  org_name: string;
  questions: string[];
  voice_examples: string[];
  sources: Candidate[];
}): string {
  const voice = args.voice_examples.length
    ? `<voice_examples>
${args.voice_examples.map((v) => `<example>${v}</example>`).join("\n")}
</voice_examples>

`
    : "";

  // Chunk text capped (~400 tokens) — retrieval already ranked these; the tail
  // of a long chunk adds cost faster than grounding.
  const sources = args.sources
    .map(
      (c, i) =>
        `<chunk id="${i + 1}" doc="${esc(c.document_filename)}" page="${c.page_start ?? ""}">
${c.text.slice(0, 1600)}
</chunk>`
    )
    .join("\n");

  const questions = args.questions
    .map((q, i) => `<question n="${i + 1}">${q}</question>`)
    .join("\n");

  return `Company: ${args.org_name}

${voice}<sources>
${sources}
</sources>

<questions>
${questions}
</questions>

Answer all ${args.questions.length} questions. Cite with chunk numbers from <sources>, e.g. [c:2].`;
}

// ---------- helpers ----------

function buildGeneratorUser(args: {
  org_name: string;
  question_text: string;
  voice_examples: string[];
  sources: Candidate[];
}): string {
  const voice = args.voice_examples.length
    ? `<voice_examples>
${args.voice_examples.map((v) => `<example>${v}</example>`).join("\n")}
</voice_examples>`
    : "";

  // Cite by 1-based index, not chunk UUID. LLMs reliably fail to reproduce long
  // UUIDs verbatim (they emit empty or malformed markers), which silently drops
  // every citation. A small integer is trivial to copy.
  const sources = args.sources
    .map(
      (c, i) =>
        `<chunk id="${i + 1}" doc="${esc(c.document_filename)}" section="${esc(
          c.section_path ?? ""
        )}" page="${c.page_start ?? ""}">
${c.text}
</chunk>`
    )
    .join("\n");

  return `Company: ${args.org_name}

<requirement>
${args.question_text}
</requirement>

${voice}

<sources>
${sources}
</sources>

Write the answer now. Cite every supported claim with the chunk's number in square brackets, e.g. [c:1] or [c:3]. Use only the numbers shown in <sources>.`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type ParsedCitation = {
  chunk_id: string;
  document_filename: string;
  section_path: string | null;
  page: number | null;
  quote: string;
};

// Matches [c:N] and the full-width-bracket variant 【c:N】 some models emit.
const CITE_RE = /[[【]\s*c:\s*(\d{1,3})\s*[\]】]/gi;

function extractCitations(
  textWithMarkers: string,
  sources: Candidate[]
): ParsedCitation[] {
  const out: ParsedCitation[] = [];
  const seen = new Set<number>();
  let m: RegExpExecArray | null;
  CITE_RE.lastIndex = 0;
  while ((m = CITE_RE.exec(textWithMarkers)) !== null) {
    const n = parseInt(m[1], 10);
    if (seen.has(n)) continue;
    const src = sources[n - 1];
    if (!src) continue;
    seen.add(n);
    // Quote: take the sentence preceding this marker as supporting context.
    const before = textWithMarkers.slice(0, m.index).replace(/\s+/g, " ").trim();
    const sentences = before.split(/(?<=[.!?])\s+/);
    const quote = (sentences[sentences.length - 1] || src.text.slice(0, 200)).slice(0, 400);
    out.push({
      chunk_id: src.chunk_id,
      document_filename: src.document_filename,
      section_path: src.section_path,
      page: src.page_start ?? null,
      quote,
    });
  }
  return out;
}

function stripMarkers(text: string): string {
  return text.replace(CITE_RE, "").replace(/\s+/g, " ").trim();
}

async function upsertResponse(
  supabase: SupabaseClient,
  args: {
    question_id: string;
    answer_text_with_markers: string;
    answer_text_clean: string;
    tone: string;
    confidence: number;
    gap_flag: "ok" | "partial" | "no_source";
    status: "draft" | "requires_review";
    generated_by: "ai" | "human" | "edited";
    citations: ParsedCitation[];
  }
) {
  const { data: existing } = await supabase
    .from("responses")
    .select("id")
    .eq("question_id", args.question_id)
    .limit(1)
    .maybeSingle();

  const payload = {
    question_id: args.question_id,
    ai_generated_draft: args.answer_text_clean,
    draft_text: args.answer_text_clean,
    answer_text_with_markers: args.answer_text_with_markers,
    tone: args.tone,
    confidence: args.confidence,
    gap_flag: args.gap_flag,
    status: args.status,
    generated_by: args.generated_by,
  };

  let responseId: string;
  if (existing) {
    responseId = existing.id;
    await supabase.from("responses").update(payload).eq("id", existing.id);
  } else {
    const { data: inserted, error } = await supabase
      .from("responses")
      .insert(payload)
      .select()
      .single();
    if (error || !inserted) throw new Error(`Response insert failed: ${error?.message}`);
    responseId = inserted.id;
  }

  // Replace citations (idempotent)
  await supabase.from("citations").delete().eq("response_id", responseId);
  if (args.citations.length > 0) {
    await supabase.from("citations").insert(
      args.citations.map((c) => ({
        response_id: responseId,
        chunk_id: c.chunk_id,
        document_filename: c.document_filename,
        section_path: c.section_path,
        page: c.page,
        quote: c.quote,
      }))
    );
  }

  // Update question status
  if (args.status === "requires_review") {
    await supabase
      .from("questions")
      .update({ status: "drafting" })
      .eq("id", args.question_id);
  }
}
