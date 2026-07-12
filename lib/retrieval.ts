/**
 * Hybrid retrieval: query expansion → dense (pgvector, mistral-embed) +
 * sparse (BM25) → merge/dedup → top-6 by score. Returns ranked chunk
 * candidates with full provenance for citation.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { callMistralJson, MODEL, MODEL_FAST, hasLlmKey } from "./mistral";
import { embedTexts, hasEmbeddings } from "./embeddings";

export type Candidate = {
  chunk_id: string;
  text: string;
  section_path: string | null;
  page_start: number | null;
  page_end: number | null;
  document_filename: string;
  /** 0..1 — cosine similarity (dense) or normalized BM25 score (sparse). */
  score: number;
};

export type RetrievalResult = {
  candidates: Candidate[];
  top_score: number;
  query_expansion: { paraphrases: string[]; keywords: string[] } | null;
  usage: { input_tokens: number; output_tokens: number };
};

// Calibrated to mistral-embed cosine similarity: genuinely relevant passages
// on this corpus commonly score 0.65-0.95; unrelated chunks fall below 0.5.
// 0.55 keeps real matches while filtering noise.
const NO_SOURCE_THRESHOLD = 0.55;

export async function retrieveForQuery(
  supabase: SupabaseClient,
  opts: { org_id: string; query: string; topK?: number }
): Promise<RetrievalResult> {
  const topK = opts.topK ?? 6;
  let usageIn = 0;
  let usageOut = 0;

  // 1. Query expansion. Off by default — it costs an extra LLM call per
  // question and the recall gain is small. Set RAG_USE_QUERY_EXPANSION=1 to
  // re-enable. Embeddings still capture paraphrase similarity.
  let expansion: { paraphrases: string[]; keywords: string[] } | null = null;
  if (process.env.RAG_USE_QUERY_EXPANSION === "1" && hasLlmKey()) {
    try {
      const { data, usage } = await callMistralJson<{
        paraphrases: string[];
        keywords: string[];
      }>({
        system: `You expand RFP requirement queries for retrieval.
Return JSON:
{ "paraphrases": [<2 short paraphrases of the requirement>],
  "keywords":    [<5 likely keywords or phrases that would appear in a relevant past document>] }
No prose, no fences.`,
        user: opts.query,
        maxTokens: 400,
        // Use the quality model — llama3.1-8b returns {"type":"object"}
        // schema descriptors instead of real data under json_object mode.
        model: MODEL,
      });
      if (Array.isArray(data?.paraphrases) && Array.isArray(data?.keywords)) {
        expansion = {
          paraphrases: data.paraphrases.slice(0, 2),
          keywords: data.keywords.slice(0, 5),
        };
      }
      usageIn += usage.input_tokens;
      usageOut += usage.output_tokens;
    } catch {
      // Non-fatal — proceed with the bare query.
    }
  }

  // 2. Dense retrieval (only if an embedding provider is configured).
  const dense: Candidate[] = [];
  if (hasEmbeddings()) {
    const queries = [opts.query, ...(expansion?.paraphrases ?? [])];
    const embeds = await embedTexts(queries, "query");
    const denseMap = new Map<string, Candidate>();
    for (const e of embeds) {
      const { data, error } = await supabase.rpc("match_chunks", {
        p_org_id: opts.org_id,
        p_embedding: e,
        p_match_count: 20,
      });
      if (error) continue;
      for (const row of (data ?? []) as any[]) {
        const existing = denseMap.get(row.chunk_id);
        if (!existing || row.similarity > existing.score) {
          denseMap.set(row.chunk_id, {
            chunk_id: row.chunk_id,
            text: row.text,
            section_path: row.section_path,
            page_start: row.page_start,
            page_end: row.page_end,
            document_filename: row.document_filename,
            score: row.similarity,
          });
        }
      }
    }
    dense.push(...denseMap.values());
  }

  // 3. Sparse retrieval (BM25) — implemented in-memory over the workspace
  // because the corpus per workspace is small in v1. For large workspaces
  // we'd materialize a tsvector + GIN; out of scope.
  const sparse = await sparseSearch(supabase, {
    org_id: opts.org_id,
    keywords: expansion?.keywords ?? extractKeywords(opts.query),
    topK: 20,
  });

  // 4. Merge → dedup → rerank
  const merged = new Map<string, Candidate>();
  for (const c of [...dense, ...sparse]) {
    if (!merged.has(c.chunk_id)) merged.set(c.chunk_id, c);
  }
  const candidates = Array.from(merged.values());
  if (candidates.length === 0) {
    return {
      candidates: [],
      top_score: 0,
      query_expansion: expansion,
      usage: { input_tokens: usageIn, output_tokens: usageOut },
    };
  }

  const ranked = candidates.sort((a, b) => b.score - a.score).slice(0, topK);

  return {
    candidates: ranked,
    top_score: ranked[0]?.score ?? 0,
    query_expansion: expansion,
    usage: { input_tokens: usageIn, output_tokens: usageOut },
  };
}

/**
 * Batched retrieval for many queries at once. The throughput win: query
 * embedding is the ONLY rate-limited step in retrieval (dense match_chunks and
 * sparse BM25 are DB-only). The per-question path embeds one query per call, so
 * a 70-question document fired ~70 embed calls that burst past mistral-embed's
 * 60 RPM ceiling and paid large 429 backoffs. Here every query is embedded in a
 * single embedTexts call (which internally batches + gates), collapsing ~70
 * network calls to ~1. Query expansion is intentionally skipped — per-query LLM
 * expansion would defeat the batching and is off by default anyway.
 *
 * Returns results aligned 1:1 with the input `queries` order.
 */
export async function retrieveForQueries(
  supabase: SupabaseClient,
  opts: { org_id: string; queries: string[]; topK?: number; embeddings?: number[][] }
): Promise<RetrievalResult[]> {
  const topK = opts.topK ?? 6;
  if (opts.queries.length === 0) return [];

  // ONE embed call for every query — or reuse caller-precomputed embeddings so
  // the same texts aren't embedded twice (library lookup + retrieval). Embedding
  // is best-effort: if it fails after its own retries, degrade to sparse/BM25
  // only rather than failing the whole document.
  let embeds: number[][] = opts.embeddings ?? [];
  if (embeds.length === 0 && hasEmbeddings()) {
    try {
      embeds = await embedTexts(opts.queries, "query");
    } catch {
      embeds = [];
    }
  }

  // Per-query assembly. Dense + sparse are DB round-trips (no provider rate
  // limit); rerank degrades to identity when no reranker is configured.
  return Promise.all(
    opts.queries.map(async (query, i): Promise<RetrievalResult> => {
      const dense: Candidate[] = [];
      const emb = embeds[i];
      if (emb) {
        const { data, error } = await supabase.rpc("match_chunks", {
          p_org_id: opts.org_id,
          p_embedding: emb,
          p_match_count: 20,
        });
        if (!error) {
          for (const row of (data ?? []) as any[]) {
            dense.push({
              chunk_id: row.chunk_id,
              text: row.text,
              section_path: row.section_path,
              page_start: row.page_start,
              page_end: row.page_end,
              document_filename: row.document_filename,
              score: row.similarity,
            });
          }
        }
      }

      const sparse = await sparseSearch(supabase, {
        org_id: opts.org_id,
        keywords: extractKeywords(query),
        topK: 20,
      });

      const merged = new Map<string, Candidate>();
      for (const c of [...dense, ...sparse]) {
        if (!merged.has(c.chunk_id)) merged.set(c.chunk_id, c);
      }
      const candidates = Array.from(merged.values());
      if (candidates.length === 0) {
        return { candidates: [], top_score: 0, query_expansion: null, usage: { input_tokens: 0, output_tokens: 0 } };
      }

      const ranked = candidates.sort((a, b) => b.score - a.score).slice(0, topK);

      return { candidates: ranked, top_score: ranked[0]?.score ?? 0, query_expansion: null, usage: { input_tokens: 0, output_tokens: 0 } };
    })
  );
}

export function isNoSource(top_score: number, candidateCount: number): boolean {
  return candidateCount === 0 || top_score < NO_SOURCE_THRESHOLD;
}

// ---------- Sparse / BM25 ----------

async function sparseSearch(
  supabase: SupabaseClient,
  opts: { org_id: string; keywords: string[]; topK: number }
): Promise<Candidate[]> {
  if (opts.keywords.length === 0) return [];
  const terms = opts.keywords
    .flatMap((k) => k.toLowerCase().split(/\s+/))
    .map((t) => t.replace(/[^a-z0-9\-]/g, ""))
    .filter((t) => t.length >= 3);
  if (terms.length === 0) return [];

  // Pull candidate rows whose sparse_terms overlap with our keywords.
  // GIN-indexed && operator is efficient for this.
  const { data: rows, error } = await supabase
    .from("document_chunks")
    .select(
      "id, raw_text, cleaned_text, section_path, page_start, page_end, sparse_terms, document_id, knowledge_document_id, knowledge_documents(filename), documents(filename)"
    )
    .eq("org_id", opts.org_id)
    .not("knowledge_document_id", "is", null)
    .overlaps("sparse_terms", terms)
    .limit(200);
  if (error || !rows) return [];

  // BM25 scoring across the retrieved candidate set.
  const N = rows.length;
  const docFreq: Record<string, number> = {};
  for (const r of rows as any[]) {
    const t = new Set((r.sparse_terms as string[] | null) ?? []);
    for (const term of terms) if (t.has(term)) docFreq[term] = (docFreq[term] ?? 0) + 1;
  }
  const avgdl =
    rows.reduce((s: number, r: any) => s + ((r.sparse_terms as string[] | null)?.length ?? 0), 0) /
    Math.max(1, N);
  const k1 = 1.5;
  const b = 0.75;

  const scored = (rows as any[]).map((r) => {
    const tf: Record<string, number> = {};
    for (const term of (r.sparse_terms as string[] | null) ?? []) {
      tf[term] = (tf[term] ?? 0) + 1;
    }
    const dl = (r.sparse_terms as string[] | null)?.length ?? 0;
    let score = 0;
    for (const term of terms) {
      const f = tf[term];
      if (!f) continue;
      const df = docFreq[term] || 0.5;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgdl))));
    }
    // Normalize to [0,1] for downstream comparability (rough).
    const norm = Math.min(1, score / 12);
    const filename =
      r.knowledge_documents?.filename ?? r.documents?.filename ?? "(unknown)";
    return {
      chunk_id: r.id as string,
      text: (r.cleaned_text ?? r.raw_text ?? "") as string,
      section_path: r.section_path as string | null,
      page_start: r.page_start as number | null,
      page_end: r.page_end as number | null,
      document_filename: filename as string,
      score: norm,
    } satisfies Candidate;
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, opts.topK);
}

function extractKeywords(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 8);
}
