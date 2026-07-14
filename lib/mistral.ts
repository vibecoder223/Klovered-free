/**
 * Mistral AI client — OpenAI-compatible chat completions.
 *
 * Talks to Mistral's OpenAI-compatible endpoint. Still env-driven, so it can be
 * pointed at any OpenAI-compatible provider without code changes:
 *   LLM_BASE_URL    base URL (default: https://api.mistral.ai/v1)
 *   LLM_API_KEY / MISTRAL_API_KEY   bearer key (first set wins)
 *   LLM_MODEL       quality model id  (default: mistral-large-latest)
 *   LLM_MODEL_FAST  fast/cheap model id (default: mistral-small-2603)
 */

const BASE_URL = (process.env.LLM_BASE_URL ?? "https://api.mistral.ai/v1").replace(/\/+$/, "");
const CHAT_URL = `${BASE_URL}/chat/completions`;

// Quality model — response generation, complex extraction.
export const MODEL      = process.env.LLM_MODEL ?? "mistral-large-latest";
// Fast/cheap — extraction batches, query expansion, confidence scoring.
export const MODEL_FAST = process.env.LLM_MODEL_FAST ?? "mistral-small-2603";

// Rough USD/MTok for cost display only (Mistral Large pricing; generation on
// the small model is cheaper, so this over-estimates slightly).
const INPUT_PRICE_PER_MTOK  = 0.50;
const OUTPUT_PRICE_PER_MTOK = 1.50;

export function estimateCost(input: number, output: number): number {
  return (input / 1_000_000) * INPUT_PRICE_PER_MTOK + (output / 1_000_000) * OUTPUT_PRICE_PER_MTOK;
}

export type Usage = { input_tokens: number; output_tokens: number };

export class RateLimitError extends Error {
  constructor(message: string, public retryAfterMs: number) {
    super(message);
    this.name = "RateLimitError";
  }
}

function getKey(): string {
  const k = process.env.LLM_API_KEY ?? process.env.MISTRAL_API_KEY;
  if (!k) throw new Error("No LLM API key set (LLM_API_KEY / MISTRAL_API_KEY).");
  return k;
}

// True if a Mistral API key is configured. Use this for "is the AI pipeline
// enabled" checks instead of testing a single env var.
export function hasLlmKey(): boolean {
  return Boolean(process.env.LLM_API_KEY || process.env.MISTRAL_API_KEY);
}

// 429 handling: the async jobs queue (lib/jobs.ts) already retries failed jobs
// with its own backoff, but a couple of in-call retries smooth over transient
// rate limits without bouncing the whole job. Honour the `retry-after` header.
const MAX_RETRY_WAIT_MS = 30_000;
const MAX_RETRIES = 2;

// ---- Per-model rate gate -----------------------------------------------------
// Mistral enforces rate limits PER MODEL, not account-wide, and the two models
// this app uses have very different shapes. Defaults below match our current
// paid Mistral tier (override any via env):
//   mistral-large-latest (MODEL, extraction — few big calls):    15 RPM / 400,000 TPM
//   mistral-small-2603   (MODEL_FAST, generation — many small):  100 RPM / 100,000 TPM
// A single shared gate tuned for one model starves or over-trusts the other,
// so gate state is keyed by model id and each gets its own rolling window.
//
// The gate is per PROCESS (one Next server / one `npm run drain`). Running more
// than one drainer at once means each keeps its own counter, so their combined
// request rate can exceed the real per-minute cap and trip 429s — enforce a
// single active drain, or move this state to Redis (shared INCR on a per-minute
// key) for multiple workers. Tune via env; set any limit to 0 to disable it.
//
//   LLM_RPM / LLM_TPM / LLM_MAX_CONCURRENCY / LLM_MIN_INTERVAL_MS
//     — apply to MODEL (quality/extraction)
//   LLM_RPM_FAST / LLM_TPM_FAST / LLM_MAX_CONCURRENCY_FAST / LLM_MIN_INTERVAL_MS_FAST
//     — apply to MODEL_FAST (fast/generation)
type ModelGateConfig = { rpm: number; tpm: number; maxConcurrency: number; minIntervalMs: number };

function gateConfigFor(model: string): ModelGateConfig {
  if (model === MODEL_FAST) {
    return {
      rpm: Number(process.env.LLM_RPM_FAST ?? 100),
      tpm: Number(process.env.LLM_TPM_FAST ?? 100_000),
      maxConcurrency: Number(process.env.LLM_MAX_CONCURRENCY_FAST ?? 12),
      // Anti-burst spacing only — the rolling RPM/TPM windows above are the
      // real caps. 600ms here made spacing the bottleneck (it serialized every
      // fast-model call to ≤100/min even when the minute budget had room);
      // 150ms just breaks up thundering herds, and the in-call 429 retry
      // covers whatever slips through.
      minIntervalMs: Number(process.env.LLM_MIN_INTERVAL_MS_FAST ?? 150),
    };
  }
  // Default bucket covers MODEL and any model not explicitly MODEL_FAST.
  return {
    rpm: Number(process.env.LLM_RPM ?? 15),
    tpm: Number(process.env.LLM_TPM ?? 400_000),
    maxConcurrency: Number(process.env.LLM_MAX_CONCURRENCY ?? 8),
    minIntervalMs: Number(process.env.LLM_MIN_INTERVAL_MS ?? 0),
  };
}

type GateState = {
  inFlight: number;
  waiters: Array<() => void>;
  tokenWindow: Array<{ t: number; tokens: number }>;
  requestWindow: number[];
  lastRequestAt: number;
};
const gateStates = new Map<string, GateState>();
function stateFor(model: string): GateState {
  let s = gateStates.get(model);
  if (!s) {
    s = { inFlight: 0, waiters: [], tokenWindow: [], requestWindow: [], lastRequestAt: 0 };
    gateStates.set(model, s);
  }
  return s;
}

async function acquireConcurrency(model: string): Promise<void> {
  const cfg = gateConfigFor(model);
  const s = stateFor(model);
  if (!cfg.maxConcurrency) return;
  if (s.inFlight < cfg.maxConcurrency) {
    s.inFlight++;
    return;
  }
  await new Promise<void>((resolve) => s.waiters.push(resolve));
}

function releaseConcurrency(model: string): void {
  const cfg = gateConfigFor(model);
  const s = stateFor(model);
  if (!cfg.maxConcurrency) return;
  const next = s.waiters.shift();
  if (next) next(); // transfer slot, inFlight unchanged
  else s.inFlight--;
}

function windowTokens(s: GateState, now: number): number {
  s.tokenWindow = s.tokenWindow.filter((e) => now - e.t < 60_000);
  return s.tokenWindow.reduce((sum, e) => sum + e.tokens, 0);
}

// Block until BOTH the rolling 60s request budget (RPM) and token budget (TPM)
// have room for this call on THIS model's gate, then reserve a slot in each.
// Returns the token-window entry so the caller can reconcile the reservation
// with ACTUAL usage once the response arrives: the estimate reserves the full
// max_tokens, but real completions are typically far smaller, and without
// reconciliation the window "spends" several times the tokens the provider
// actually counted — throttling concurrent documents minutes early.
async function reserveSlot(model: string, est: number): Promise<{ t: number; tokens: number } | null> {
  const cfg = gateConfigFor(model);
  const s = stateFor(model);
  if (!cfg.rpm && !cfg.tpm && !cfg.minIntervalMs) return null;
  for (;;) {
    const now = Date.now();
    s.requestWindow = s.requestWindow.filter((t) => now - t < 60_000);
    const reqOk = !cfg.rpm || s.requestWindow.length < cfg.rpm;
    // A single call larger than the whole token budget would deadlock — exempt.
    const tokOk = !cfg.tpm || est >= cfg.tpm || windowTokens(s, now) + est <= cfg.tpm;
    const gapOk = !cfg.minIntervalMs || now - s.lastRequestAt >= cfg.minIntervalMs;
    if (reqOk && tokOk && gapOk) {
      s.requestWindow.push(now);
      s.lastRequestAt = now;
      if (cfg.tpm) {
        const entry = { t: now, tokens: est };
        s.tokenWindow.push(entry);
        return entry;
      }
      return null;
    }
    if (reqOk && tokOk && !gapOk) {
      // Only the spacing gate is binding — short sleep until the gap elapses.
      await new Promise((r) => setTimeout(r, cfg.minIntervalMs - (now - s.lastRequestAt)));
      continue;
    }
    // Sleep until the oldest entry in the binding window ages out of the minute.
    const oldestReq = s.requestWindow[0];
    const oldestTok = s.tokenWindow[0]?.t;
    const oldest = Math.min(oldestReq ?? now, oldestTok ?? now);
    const wait = Math.max(250, 60_000 - (now - oldest));
    await new Promise((r) => setTimeout(r, Math.min(wait, 5_000)));
  }
}

// ~4 chars/token; count the prompt we send plus the output we've reserved.
function estimateTokens(system: string, user: string, maxTokens: number): number {
  return Math.ceil((system.length + user.length) / 4) + maxTokens;
}

/**
 * Read-only saturation probe for the fast lane. True when MODEL_FAST's rolling
 * RPM or TPM window has no room for a call of ~`estTokens` right now — i.e. the
 * call would sit in reserveSlot waiting for the minute to roll over. Callers
 * use this to spill work to MODEL (huge TPM budget, mostly idle outside
 * extraction) instead of queueing behind the fast lane under concurrent load.
 * Racy by design (no reservation happens here): a wrong answer just means one
 * call lands in the slower lane — both lanes still enforce their own gates.
 */
export function fastLaneSaturated(estTokens: number): boolean {
  const cfg = gateConfigFor(MODEL_FAST);
  const s = stateFor(MODEL_FAST);
  const now = Date.now();
  s.requestWindow = s.requestWindow.filter((t) => now - t < 60_000);
  const rpmFull = Boolean(cfg.rpm) && s.requestWindow.length >= cfg.rpm;
  const tpmFull =
    Boolean(cfg.tpm) && estTokens < cfg.tpm && windowTokens(s, now) + estTokens > cfg.tpm;
  return rpmFull || tpmFull;
}

async function call(opts: {
  system: string;
  user: string;
  maxTokens?: number;
  json?: boolean;
  model?: string;
}): Promise<{ raw: string; usage: Usage }> {
  const model     = opts.model ?? MODEL;
  const maxTokens = opts.maxTokens ?? 1500;
  const body: any = {
    model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user",   content: opts.user },
    ],
    max_tokens:  maxTokens,
    temperature: 0.2,
  };
  if (opts.json) body.response_format = { type: "json_object" };
  // Reasoning models otherwise spend the whole token budget on hidden reasoning
  // before emitting an answer — slow, and the visible content can come back
  // empty. "low" keeps them fast and answering. Ignored by non-reasoning models.
  if (process.env.LLM_REASONING_EFFORT) {
    body.reasoning_effort = process.env.LLM_REASONING_EFFORT;
  }

  // Rate gate: cap simultaneous calls, then wait for token budget — scoped to
  // THIS model's own gate (see gateConfigFor). Held for the whole call
  // (including in-call 429 retries) so retries don't re-burst.
  await acquireConcurrency(model);
  try {
    const reservation = await reserveSlot(model, estimateTokens(opts.system, opts.user, maxTokens));
    const result = await sendWithRetries(body, model);
    // Reconcile the token reservation with what the provider actually counted
    // (mutating the entry in place updates the shared rolling window). Only
    // when usage came back — on a missing usage block keep the conservative
    // estimate rather than treating the call as free.
    const actual = result.usage.input_tokens + result.usage.output_tokens;
    if (reservation && actual > 0) reservation.tokens = actual;
    return result;
  } finally {
    releaseConcurrency(model);
  }
}

async function sendWithRetries(body: any, model: string): Promise<{ raw: string; usage: Usage }> {
  let attempt = 0;
  while (true) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    let res: Response;
    try {
      res = await fetch(CHAT_URL, {
        method:  "POST",
        headers: {
          Authorization:  `Bearer ${getKey()}`,
          "Content-Type": "application/json",
        },
        body:   JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "5");
      const base = Math.max(1_000, retryAfter * 1000);

      if (attempt < MAX_RETRIES && base <= MAX_RETRY_WAIT_MS) {
        // Jitter so parallel callers don't all retry on the same tick.
        const jitter = base * (0.7 + Math.random() * 0.6);
        console.warn(`[llm] 429 on ${model} (attempt ${attempt + 1}) — retrying in ${Math.round(jitter / 1000)}s`);
        await new Promise((r) => setTimeout(r, jitter));
        attempt++;
        continue;
      }
      throw new RateLimitError(
        `LLM 429 on ${model} after ${MAX_RETRIES} retries — last retry-after ${Math.round(base / 1000)}s`,
        base,
      );
    }

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`LLM ${res.status}: ${txt.slice(0, 300)}`);
    }

    const j   = await res.json();
    const msg = j.choices?.[0]?.message ?? {};
    // Fall back to the reasoning field if a reasoning model emitted its answer
    // there with an empty content (happens when reasoning consumes the budget).
    const raw = (msg.content && msg.content.trim()) ? msg.content : (msg.reasoning ?? "");
    const inTok = j.usage?.prompt_tokens ?? 0;
    const outTok = j.usage?.completion_tokens ?? 0;
    // Opt-in call metrics for load testing (inert unless LLM_METRICS_FILE set).
    if (process.env.LLM_METRICS_FILE) {
      try {
        const fs = await import("node:fs");
        fs.appendFileSync(
          process.env.LLM_METRICS_FILE,
          JSON.stringify({ t: Date.now(), model, in: inTok, out: outTok }) + "\n"
        );
      } catch {}
    }
    return {
      raw,
      usage: {
        input_tokens:  inTok,
        output_tokens: outTok,
      },
    };
  }
}

export async function callMistralJson<T = unknown>(opts: {
  system: string;
  user: string;
  maxTokens?: number;
  model?: string;
  /**
   * Output mode. Default "json_object" forces `response_format`. Use "text"
   * when you want an array — some models misbehave under json_object mode for
   * arrays and return either a schema descriptor like {"type":"object"} or a
   * single object instead of the requested array.
   */
  mode?: "json_object" | "text";
}): Promise<{ data: T; usage: Usage; raw: string }> {
  const mode = opts.mode ?? "json_object";
  const sys = /json/i.test(opts.system)
    ? opts.system
    : `${opts.system}\n\nReturn valid JSON.`;

  const { raw, usage } = await call({
    ...opts,
    system:    sys,
    json:      mode === "json_object",
    maxTokens: opts.maxTokens ?? 4096,
  });

  const cleaned = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/[\[{][\s\S]*[\]}]/);
    if (!m) throw new Error(`LLM response not valid JSON: ${cleaned.slice(0, 200)}`);
    try {
      parsed = JSON.parse(m[0]);
    } catch (e: any) {
      // Truncated-array salvage: trim back to the last well-formed object and
      // close the array. The model sometimes hits max_tokens mid-array.
      const salvaged = salvageTruncatedArray(m[0]);
      if (salvaged !== null) {
        parsed = salvaged;
      } else {
        throw new Error(`LLM response not parseable JSON (${e.message}): ${m[0].slice(0, 200)}`);
      }
    }
  }

  // Unwrap object → array. Some models return { "type": "object",
  // "requirements": [...] } or similar. Find the first array value and use it.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const arrayValues = Object.values(parsed).filter((v) => Array.isArray(v));
    if (arrayValues.length === 1) parsed = arrayValues[0];
  }

  return { data: parsed as T, usage, raw };
}

/**
 * Best-effort recovery for an unterminated JSON array — walk backwards to the
 * last balanced object and close the array. Returns null if nothing usable.
 */
function salvageTruncatedArray(s: string): any[] | null {
  if (!s.startsWith("[")) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let lastGoodEnd = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 1 && c === "}") lastGoodEnd = i; // top-level object closed
    }
  }
  if (lastGoodEnd < 0) return null;
  const candidate = s.slice(0, lastGoodEnd + 1) + "]";
  try {
    const v = JSON.parse(candidate);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export async function callMistralText(opts: {
  system: string;
  user: string;
  maxTokens?: number;
  model?: string;
}): Promise<{ text: string; usage: Usage }> {
  const { raw, usage } = await call(opts);
  return { text: raw.trim(), usage };
}
