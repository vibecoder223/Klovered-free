/**
 * Agent pipeline.
 *
 * RFP-side pipeline (M3 repaired): ingestion → chunking (page-aware) →
 * requirement extraction (zod-validated) → structuring (compliance matrix
 * + questions) → response generation (handled separately by lib/rag.ts).
 *
 * Each step persists results to Supabase and records an `agent_runs` entry
 * with token usage + estimated cost.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { callMistralJson, callMistralText, estimateCost, MODEL, MODEL_FAST } from "./mistral";
import { parseDocument, type ParsedDoc } from "./parse";
import { chunkBlocks, type ProducedChunk } from "./chunk";
import { embedTexts, hasEmbeddings } from "./embeddings";

type Doc = {
  id: string;
  deal_id: string;
  filename: string;
  file_path: string;
  mime_type: string | null;
  extracted_text: string | null;
};

// Exported so the generate stage (lib/jobs.ts, which persists its own token
// usage rather than going through an agents.ts runXAgent function) can log to
// the same agent_runs table as every other stage — previously generation was
// the only stage with zero cost/token visibility.
export async function recordRun(
  supabase: SupabaseClient,
  args: {
    document_id: string;
    agent_type: string;
    status: "completed" | "failed";
    input_tokens?: number;
    output_tokens?: number;
    error_message?: string;
    result?: unknown;
    startedAt: number;
  }
) {
  await supabase.from("agent_runs").insert({
    document_id: args.document_id,
    agent_type: args.agent_type,
    status: args.status,
    input_tokens: args.input_tokens ?? null,
    output_tokens: args.output_tokens ?? null,
    cost:
      args.input_tokens != null && args.output_tokens != null
        ? estimateCost(args.input_tokens, args.output_tokens)
        : null,
    error_message: args.error_message ?? null,
    result: (args.result as object) ?? null,
    started_at: new Date(args.startedAt).toISOString(),
    completed_at: new Date().toISOString(),
  });
}

async function setStatus(
  supabase: SupabaseClient,
  documentId: string,
  status: string,
  errorMessage?: string
) {
  await supabase
    .from("documents")
    .update({
      processing_status: status,
      error_message: errorMessage ?? null,
    })
    .eq("id", documentId);
}

// ============================================================
// Agent 1: Ingestion — download from Storage, parse to typed blocks.
// Now uses lib/parse.ts (page-aware).
// ============================================================
export async function runIngestionAgent(
  supabase: SupabaseClient,
  doc: Doc
): Promise<ParsedDoc> {
  const startedAt = Date.now();
  await setStatus(supabase, doc.id, "extracting");
  try {
    const { data, error } = await supabase.storage.from("documents").download(doc.file_path);
    if (error) throw error;
    const buf = Buffer.from(await data.arrayBuffer());
    const parsed = await parseDocument(buf, doc.mime_type, doc.filename);
    if (!parsed.blocks.length) throw new Error("No content extracted from this document.");
    await supabase
      .from("documents")
      .update({ extracted_text: parsed.raw_text })
      .eq("id", doc.id);
    await recordRun(supabase, {
      document_id: doc.id,
      agent_type: "ingestion",
      status: "completed",
      result: { chars: parsed.raw_text.length, pages: parsed.page_count, blocks: parsed.blocks.length },
      startedAt,
    });
    return parsed;
  } catch (e: any) {
    await recordRun(supabase, {
      document_id: doc.id,
      agent_type: "ingestion",
      status: "failed",
      error_message: e.message,
      startedAt,
    });
    throw e;
  }
}

// ============================================================
// Agent 2: Chunking — token-aware, page-aware. Also embeds + writes the
// RFP's own chunks into the same `document_chunks` table the KB uses, so
// the RFP can be searched as part of its own context if useful.
// ============================================================
export async function runChunkingAgent(
  supabase: SupabaseClient,
  doc: Doc,
  parsed: ParsedDoc
): Promise<ProducedChunk[]> {
  const startedAt = Date.now();
  await setStatus(supabase, doc.id, "chunked");
  try {
    const chunks = chunkBlocks({ blocks: parsed.blocks, filename: doc.filename });

    // Resolve org_id once for storage.
    const { data: deal } = await supabase
      .from("deals")
      .select("org_id")
      .eq("id", doc.deal_id)
      .single();
    const orgId = deal?.org_id ?? null;

    // Embed via Jina. Skip if no provider configured — embedTexts now throws
    // instead of returning zero vectors, so we gate the call.
    const embeddings: number[][] = hasEmbeddings()
      ? await embedTexts(chunks.map((c) => c.text_for_embedding), "document")
      : [];

    await supabase.from("document_chunks").delete().eq("document_id", doc.id);
    if (chunks.length > 0) {
      const rows = chunks.map((c, i) => ({
        document_id: doc.id,
        org_id: orgId,
        chunk_index: i,
        section_title: c.section_path,
        section_path: c.section_path,
        page_start: c.page_start,
        page_end: c.page_end,
        raw_text: c.text,
        cleaned_text: c.text,
        text_for_embedding: c.text_for_embedding,
        embedding: hasEmbeddings() ? embeddings[i] : null,
        sparse_terms: c.sparse_terms,
      }));
      for (let i = 0; i < rows.length; i += 50) {
        const { error } = await supabase
          .from("document_chunks")
          .insert(rows.slice(i, i + 50));
        if (error) throw new Error(`Chunk insert failed: ${error.message}`);
      }
    }
    await recordRun(supabase, {
      document_id: doc.id,
      agent_type: "chunking",
      status: "completed",
      result: { chunk_count: chunks.length },
      startedAt,
    });
    return chunks;
  } catch (e: any) {
    await recordRun(supabase, {
      document_id: doc.id,
      agent_type: "chunking",
      status: "failed",
      error_message: e.message,
      startedAt,
    });
    throw e;
  }
}

// ============================================================
// Agent 3: Requirement extraction (LLM, zod-validated, with retry).
// ============================================================
// requirement_id / section accept numbers from less-careful LLMs and coerce
// to strings. Some smaller models also return "must-have", "high", etc. for
// classification — preprocess() normalises common variants.
const ClassificationSchema = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const s = v.toLowerCase();
  if (s === "must" || s === "must-have" || s === "mandatory" || s === "required" || s === "high") return "must";
  if (s === "should" || s === "should-have" || s === "desired" || s === "medium") return "should";
  if (s === "info" || s === "informational" || s === "optional" || s === "low") return "info";
  return v;
}, z.enum(["must", "should", "info"]).default("must"));

const TopicSchema = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const s = v.toLowerCase();
  if (["security", "legal", "pricing", "technical", "commercial"].includes(s)) return s;
  if (s.includes("secur")) return "security";
  if (s.includes("legal") || s.includes("compli")) return "legal";
  if (s.includes("price") || s.includes("cost")) return "pricing";
  if (s.includes("tech")) return "technical";
  return "technical";
}, z.enum(["security", "legal", "pricing", "technical", "commercial"]).default("technical"));

const RequirementSchema = z.object({
  requirement_id: z.coerce.string().min(1),
  section: z.union([z.string(), z.number()]).optional().nullable().transform((v) => v == null ? null : String(v)),
  text: z.string().min(1),
  classification: ClassificationSchema,
  topic: TopicSchema,
  source_page: z.union([z.number().int(), z.string()]).nullable().optional().transform((v) => {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }),
});
const RequirementArraySchema = z.array(RequirementSchema);

type ExtractedRequirement = z.infer<typeof RequirementSchema>;

export async function runExtractionAgent(
  supabase: SupabaseClient,
  doc: Doc,
  chunks: ProducedChunk[]
): Promise<ExtractedRequirement[]> {
  const startedAt = Date.now();
  await setStatus(supabase, doc.id, "analyzing");
  const allReqs: ExtractedRequirement[] = [];
  let totalIn = 0;
  let totalOut = 0;

  const sys = `You are an expert RFP analyst. Extract every distinct requirement, question, or compliance item from ALL sections provided. Be exhaustive but de-duplicate within the batch.

Return a JSON array. Each item:
{
  "requirement_id": "Q2.3" | "R-4.1" | "REQ-N",
  "section": "4.2" | "Section 4.2 Security",
  "text": "<the full requirement text, paraphrased if needed>",
  "classification": "must" | "should" | "info",
  "topic": "security" | "legal" | "pricing" | "technical" | "commercial",
  "source_page": <integer page number, or null>
}

Return ONLY the JSON array. No prose, no markdown fences.`;

  try {
    type ChunkResult = { reqs: ExtractedRequirement[]; inTok: number; outTok: number };

    // Batch chunks 12 at a time. This model (MODEL, mistral-large-latest) is
    // capped at 4 requests/minute — a small batch size multiplies call count
    // straight into that ceiling. Large's 250K TPM budget has plenty of room
    // for bigger batches, so trade batch size up to keep extraction call
    // count low (a ~20-chunk document now costs ~2 calls instead of ~5).
    const BATCH = 12;
    const batches: ProducedChunk[][] = [];
    for (let i = 0; i < chunks.length; i += BATCH) batches.push(chunks.slice(i, i + BATCH));

    const tasks = batches.map((batch) => async (): Promise<ChunkResult> => {
      const user = batch
        .map(
          (c, idx) =>
            `--- Section ${idx + 1}: ${c.section_path || "Body"} (page ${c.page_start}${c.page_end !== c.page_start ? `–${c.page_end}` : ""}) ---\n${c.text}`
        )
        .join("\n\n");

      let parsed: ExtractedRequirement[] | null = null;
      let lastErr: string | null = null;
      let inTok = 0, outTok = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { data, usage, raw } = await callMistralJson<unknown>({
            system: sys,
            user:
              attempt === 0
                ? user
                : `${user}\n\n[Previous attempt failed: ${lastErr}. Return ONLY a JSON array.]`,
            // Bigger batches (12 chunks) need more room for the requirements
            // list than the old 4-chunk batches did; salvageTruncatedArray in
            // lib/mistral.ts still recovers a partial list if this cap is hit.
            maxTokens: 8192,
            model: MODEL,
            // response_format=json_object forces the model to return a single
            // top-level object; gpt-oss-120b and llama3.1-8b on Cerebras both
            // misbehave with that and return either a schema descriptor or a
            // lone item. Use text mode so the model can return a real array
            // and let the loose parser extract it from the response.
            mode: "text",
          });
          inTok += usage.input_tokens;
          outTok += usage.output_tokens;
          const validated = RequirementArraySchema.safeParse(data);
          if (validated.success) {
            parsed = validated.data;
            if (parsed.length === 0) {
              console.warn(`[extraction] LLM returned empty array. Raw response:`, raw.slice(0, 400));
            }
            break;
          }
          lastErr = validated.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          console.warn(`[extraction] Validation failed (attempt ${attempt + 1}):`, lastErr, "Raw:", raw.slice(0, 300));
        } catch (e: any) {
          lastErr = e.message;
          console.warn(`[extraction] Call failed (attempt ${attempt + 1}):`, e.message);
        }
      }
      if (!parsed) {
        // If the failure was an API error (rate limit, network, server),
        // bubble it up so the orchestrator marks the doc as extraction_failed.
        // Validation-only failures (LLM produced bad JSON) return empty so a
        // doc that legitimately has no requirements still proceeds.
        if (lastErr && /rate.?limit|429|^LLM |timeout|abort/i.test(lastErr)) {
          throw new Error(`Extraction batch failed: ${lastErr}`);
        }
        console.warn(`[extraction] Chunk batch produced no parsed reqs after retries. Last error:`, lastErr);
        return { reqs: [], inTok, outTok };
      }
      // Fill missing source_page from the first chunk in the batch.
      const reqs = parsed.map((r) => {
        if (r.source_page == null) r.source_page = batch[0].page_start;
        return r;
      });
      return { reqs, inTok, outTok };
    });

    // Fire all batches in parallel — rate limiter handles RPM/TPM pacing.
    const results = await Promise.all(tasks.map((t) => t()));
    for (const r of results) {
      totalIn += r.inTok;
      totalOut += r.outTok;
      allReqs.push(...r.reqs);
    }

    // Dedup by (requirement_id, text)
    const seen = new Set<string>();
    const deduped = allReqs.filter((r) => {
      const k = `${r.requirement_id}::${r.text.slice(0, 100)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    await supabase.from("extracted_requirements").delete().eq("document_id", doc.id);
    if (deduped.length > 0) {
      await supabase.from("extracted_requirements").insert(
        deduped.map((r) => ({
          document_id: doc.id,
          requirement_id: r.requirement_id,
          title: r.text.slice(0, 120),
          description: r.text,
          // Legacy columns (kept for back-compat with existing UI):
          category: r.topic,
          priority: r.classification === "must" ? "high" : r.classification === "should" ? "medium" : "low",
          is_mandatory: r.classification === "must",
          // New spec-aligned columns:
          section: r.section ?? null,
          source_page: r.source_page ?? null,
          classification: r.classification,
          topic: r.topic,
        }))
      );
    }

    await recordRun(supabase, {
      document_id: doc.id,
      agent_type: "extraction",
      status: "completed",
      input_tokens: totalIn,
      output_tokens: totalOut,
      result: { count: deduped.length },
      startedAt,
    });
    return deduped;
  } catch (e: any) {
    await recordRun(supabase, {
      document_id: doc.id,
      agent_type: "extraction",
      status: "failed",
      input_tokens: totalIn,
      output_tokens: totalOut,
      error_message: e.message,
      startedAt,
    });
    throw e;
  }
}

// ============================================================
// Agent 4: Structuring — build compliance matrix + questions.
// ============================================================
export async function runStructuringAgent(
  supabase: SupabaseClient,
  doc: Doc,
  reqs: ExtractedRequirement[]
) {
  const startedAt = Date.now();
  await setStatus(supabase, doc.id, "structured");
  try {
    await supabase.from("compliance_matrix").delete().eq("document_id", doc.id);
    await supabase.from("questions").delete().eq("document_id", doc.id);

    if (reqs.length > 0) {
      await supabase.from("compliance_matrix").insert(
        reqs.map((r) => ({
          document_id: doc.id,
          requirement_id: r.requirement_id,
          our_capability: null,
          compliance_status: "pending",
        }))
      );
      await supabase.from("questions").insert(
        reqs.map((r) => ({
          document_id: doc.id,
          requirement_id: r.requirement_id,
          question_text: r.text,
          category: r.topic,
          priority:
            r.classification === "must"
              ? "high"
              : r.classification === "should"
              ? "medium"
              : "low",
          status: "todo",
        }))
      );
    }

    await recordRun(supabase, {
      document_id: doc.id,
      agent_type: "structuring",
      status: "completed",
      result: { count: reqs.length },
      startedAt,
    });
  } catch (e: any) {
    await recordRun(supabase, {
      document_id: doc.id,
      agent_type: "structuring",
      status: "failed",
      error_message: e.message,
      startedAt,
    });
    throw e;
  }
}
// Response generation (Agent 5) and the synchronous runFullPipeline orchestrator
// were removed: the live path is the durable job queue (lib/jobs.ts), which runs
// one `generate` job per question via runGenerate → generateAndPersistAnswer.
