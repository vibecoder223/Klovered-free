/**
 * Embeddings — mistral-embed @ 1024 dims (native, symmetric: same embedding
 * for queries and passages). Matches the DB pgvector(1024) column and
 * match_chunks(p_embedding vector(1024)) RPC. No reranker — ranking is by
 * cosine similarity from match_chunks directly.
 *
 * Calls are paced through a small concurrency gate (EMBED_MAX_CONCURRENCY,
 * default 1) before hitting the network. Mistral's tier enforces a per-second
 * cap — firing embedding calls for a whole batch of questions via Promise.all
 * previously burst past that limit and exhausted the in-call 429 retry
 * budget. On a 429 we still honour `retry-after` with exponential backoff
 * before surfacing a hard failure.
 */

const MISTRAL_EMBED_URL   = "https://api.mistral.ai/v1/embeddings";
const MISTRAL_EMBED_MODEL = process.env.MISTRAL_EMBED_MODEL || "mistral-embed";

export const EMBED_DIMS = 1024;

const EMBED_BATCH_SIZE = 128;      // max inputs per embed call
const MAX_RETRY_WAIT_MS = 30_000;
const MAX_RETRIES = 4;

function hasMistralKey() { return !!process.env.MISTRAL_API_KEY; }

/** True if an embedding provider is available. */
export function hasEmbeddings() { return hasMistralKey(); }

// Serialized rate gate. mistral-embed is capped per-minute — bursting past it
// via Promise.all previously produced 429 storms (and the occasional
// generation_failed when a batch's retrieval retries were exhausted).
// Concurrency 1 + a minimum interval keeps every embed call strictly under
// the ceiling so 429s effectively never happen, no matter how many parallel
// callers (library lookup + retrieval across all sub-batches) hit the
// endpoint at once.
const EMBED_MAX_CONCURRENCY = Number(process.env.EMBED_MAX_CONCURRENCY ?? 1);
const EMBED_MIN_INTERVAL_MS = Number(process.env.EMBED_MIN_INTERVAL_MS ?? 1050);
let embedInFlight = 0;
const embedWaiters: Array<() => void> = [];
let lastEmbedAt = 0;

async function acquireEmbedSlot(): Promise<void> {
  if (embedInFlight >= EMBED_MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => embedWaiters.push(resolve));
  } else {
    embedInFlight++;
  }
  const wait = EMBED_MIN_INTERVAL_MS - (Date.now() - lastEmbedAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastEmbedAt = Date.now();
}

function releaseEmbedSlot(): void {
  const next = embedWaiters.shift();
  if (next) next();
  else embedInFlight--;
}

// Shared POST with retry/backoff on 429, paced through the concurrency gate
// above so a burst of parallel callers can't overshoot the provider's actual
// per-second limit before the 429 handler even gets a chance to back off.
async function embedApiFetch(url: string, body: any, apiKey: string): Promise<Response> {
  await acquireEmbedSlot();
  try {
    return await embedApiFetchInner(url, body, apiKey);
  } finally {
    releaseEmbedSlot();
  }
}

async function embedApiFetchInner(url: string, body: any, apiKey: string): Promise<Response> {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "5");
      const base = Math.max(1_000, retryAfter * 1000);
      const backoff = Math.min(MAX_RETRY_WAIT_MS, base * Math.pow(2, attempt));
      if (attempt < MAX_RETRIES) {
        const jitter = backoff * (0.7 + Math.random() * 0.6);
        console.warn(`[embeddings] 429 on ${url} (attempt ${attempt + 1}) — retrying in ${Math.round(jitter / 1000)}s`);
        await new Promise((r) => setTimeout(r, jitter));
        attempt++;
        continue;
      }
      throw new Error(`Mistral embed 429 on ${url} after ${MAX_RETRIES} retries`);
    }

    return res;
  }
}

// ─── Embeddings ──────────────────────────────────────────────

async function embedMistralBatch(batch: string[]): Promise<number[][]> {
  const res = await embedApiFetch(MISTRAL_EMBED_URL, {
    model: MISTRAL_EMBED_MODEL,
    input: batch,
  }, process.env.MISTRAL_API_KEY!);

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Mistral embed failed: ${res.status} ${t.slice(0, 300)}`);
  }

  const j = (await res.json()) as {
    data: { embedding: number[]; index: number }[];
  };
  const result: number[][] = new Array(batch.length);
  j.data
    .sort((a, b) => a.index - b.index)
    .forEach((d, localIdx) => {
      result[localIdx] = d.embedding;
    });
  return result;
}

/**
 * Embed a list of texts.
 * Throws if Mistral is not configured or the call fails. Callers must catch
 * and mark the document/chunk as failed.
 */
export async function embedTexts(
  texts: string[],
  inputType: "document" | "query" = "document"
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!hasEmbeddings()) {
    throw new Error("Embeddings unavailable: set MISTRAL_API_KEY in .env.local.");
  }

  const out: number[][] = new Array(texts.length);
  const batches: { start: number; texts: string[] }[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    batches.push({ start: i, texts: texts.slice(i, i + EMBED_BATCH_SIZE) });
  }

  await Promise.all(
    batches.map(async ({ start, texts: batch }) => {
      const embs = await embedMistralBatch(batch);
      embs.forEach((e, i) => {
        out[start + i] = e;
      });
    })
  );

  return out;
}
