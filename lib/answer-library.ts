/**
 * Answer Library — capture approved answers + suggest reuse for new questions.
 *
 * Matching is question -> question: an incoming RFP question is compared against
 * stored questions. So we embed `question_text` only (never the answer prose,
 * which dilutes question similarity). Mirrors the KB retrieval asymmetry:
 * stored questions are embedded as "document" (passage), incoming as "query".
 *
 * Spec: docs/superpowers/specs/2026-06-03-answer-library-design.md
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { embedTexts, hasEmbeddings } from "./embeddings";

/**
 * Show a Reuse suggestion at/above this question similarity. Jina v3 lands
 * genuine RFP paraphrases around 0.78–0.90, so this is intentionally permissive
 * — the human decides via the Reuse card. (Verbatim auto-reuse uses the much
 * stricter LIBRARY_REUSE_MIN below.)
 */
export const LIBRARY_SUGGEST_MIN = 0.78;
/** On capture, update an existing row instead of inserting at/above this. */
export const LIBRARY_DEDUPE_MIN = 0.92;
/**
 * At/above this similarity the generator skips the LLM entirely and drafts the
 * stored approved answer verbatim — it's a near-identical question a human
 * already signed off on. Still routed to review so a person confirms the match.
 */
export const LIBRARY_REUSE_MIN = 0.9;

export type AnswerMatch = {
  id: string;
  question_text: string | null;
  response_text: string;
  usage_count: number;
  last_used_at: string | null;
  source_question_id: string | null;
  similarity: number;
};

export type CaptureResult = { id: string; action: "inserted" | "updated" } | null;

/**
 * Capture an approved answer into the library. Best-effort: returns null (and
 * never throws) when embeddings are unavailable or the write fails, so the
 * approval flow is never blocked.
 *
 * `writer` should be a privileged client (admin) so the library write is not
 * gated by the caller's row-level visibility — org_id is supplied explicitly.
 */
export async function captureApprovedAnswer(
  writer: SupabaseClient,
  args: {
    org_id: string;
    question_id: string;
    question_text: string;
    answer_text: string;
    created_by?: string | null;
  }
): Promise<CaptureResult> {
  const question = args.question_text?.trim();
  const answer = args.answer_text?.trim();
  if (!question || !answer || !hasEmbeddings()) return null;

  try {
    const [embedding] = await embedTexts([question], "document");
    if (!embedding) return null;

    // Dedupe: does a near-identical question already exist for this org?
    const { data: top } = await writer.rpc("match_answers", {
      p_org_id: args.org_id,
      p_embedding: embedding,
      p_match_count: 1,
    });
    const best = (top ?? [])[0] as AnswerMatch | undefined;

    if (best && best.similarity >= LIBRARY_DEDUPE_MIN) {
      await writer
        .from("response_library")
        .update({
          response_text: answer,
          question_text: question,
          embedding,
          source: "approved",
          source_question_id: args.question_id,
        })
        .eq("id", best.id);
      return { id: best.id, action: "updated" };
    }

    const { data: inserted, error } = await writer
      .from("response_library")
      .insert({
        org_id: args.org_id,
        question_text: question,
        response_text: answer,
        embedding,
        source: "approved",
        source_question_id: args.question_id,
        created_by: args.created_by ?? null,
      })
      .select("id")
      .single();
    if (error || !inserted) return null;
    return { id: inserted.id, action: "inserted" };
  } catch {
    return null; // best-effort — never block approval
  }
}

/**
 * Nearest stored questions for an incoming question. Returns [] when embeddings
 * are unavailable or nothing matches. Caller applies LIBRARY_SUGGEST_MIN.
 */
export async function suggestAnswers(
  supabase: SupabaseClient,
  args: { org_id: string; question_text: string; limit?: number }
): Promise<AnswerMatch[]> {
  const question = args.question_text?.trim();
  if (!question || !hasEmbeddings()) return [];

  try {
    const [embedding] = await embedTexts([question], "query");
    if (!embedding) return [];
    const { data, error } = await supabase.rpc("match_answers", {
      p_org_id: args.org_id,
      p_embedding: embedding,
      p_match_count: args.limit ?? 3,
    });
    if (error) return [];
    return (data ?? []) as AnswerMatch[];
  } catch {
    return [];
  }
}

/**
 * Batched library lookup from precomputed query embeddings — one match_answers
 * RPC per embedding (DB only, no provider calls). Lets a batch of questions
 * share a single embed call instead of embedding one question per suggestAnswers
 * invocation, which was another source of embed-endpoint bursts. Returns the top
 * match per input embedding, aligned 1:1 (null where none). Never throws.
 */
export async function suggestAnswersByEmbeddings(
  supabase: SupabaseClient,
  args: { org_id: string; embeddings: (number[] | undefined)[] }
): Promise<(AnswerMatch | null)[]> {
  return Promise.all(
    args.embeddings.map(async (embedding) => {
      if (!embedding) return null;
      try {
        const { data, error } = await supabase.rpc("match_answers", {
          p_org_id: args.org_id,
          p_embedding: embedding,
          p_match_count: 1,
        });
        if (error) return null;
        return ((data ?? [])[0] as AnswerMatch | undefined) ?? null;
      } catch {
        return null;
      }
    })
  );
}

/**
 * Record that a library answer was reused: bump usage_count and last_used_at.
 * Best-effort — never throws, never blocks the caller.
 */
export async function recordReuse(supabase: SupabaseClient, id: string): Promise<void> {
  try {
    const { data } = await supabase
      .from("response_library")
      .select("usage_count")
      .eq("id", id)
      .maybeSingle();
    await supabase
      .from("response_library")
      .update({
        usage_count: ((data?.usage_count as number) ?? 0) + 1,
        last_used_at: new Date().toISOString(),
      })
      .eq("id", id);
  } catch {
    // ignore
  }
}
