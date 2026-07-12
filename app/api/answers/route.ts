import { NextResponse } from "next/server";
import { requireGuest, AuthError } from "@/utils/auth";

export async function GET(req: Request) {
  let ctx;
  try { ctx = await requireGuest(); }
  catch (e) { return NextResponse.json({ error: "No session" }, { status: e instanceof AuthError ? e.status : 401 }); }
  const { supabase } = ctx;

  const dealId = new URL(req.url).searchParams.get("deal_id");
  if (!dealId) return NextResponse.json({ error: "deal_id required" }, { status: 400 });

  // RLS scopes everything to the guest's org; a foreign deal_id returns [].
  const { data: docs } = await supabase.from("documents").select("id").eq("deal_id", dealId);
  const docIds = (docs ?? []).map((d) => d.id);
  if (docIds.length === 0) return NextResponse.json({ questions: [] });

  // Schema note: responses.question_id -> questions.id (reverse embed), and
  // citations are denormalized onto the response directly (document_filename,
  // page) rather than joined through document_chunks/knowledge_documents —
  // see migrations/0001_init.sql (responses, questions) and
  // migrations/0002_rag.sql (citations, responses.draft_text/confidence/gap_flag).
  const { data: questions } = await supabase
    .from("questions")
    .select("id, question_text, status, responses(id, draft_text, confidence, gap_flag, citations(chunk_id, document_filename, page))")
    .in("document_id", docIds)
    .order("created_at", { ascending: true });

  return NextResponse.json({
    questions: (questions ?? []).map((q: any) => {
      const r = Array.isArray(q.responses) ? q.responses[0] : q.responses;
      return {
        id: q.id, question_text: q.question_text, status: q.status,
        response: r ? {
          answer_text: r.draft_text, confidence: r.confidence, gap_flag: r.gap_flag,
          citations: (r.citations ?? []).map((c: any) => ({
            chunk_id: c.chunk_id,
            filename: c.document_filename ?? null,
            page_start: c.page ?? null,
          })),
        } : null,
      };
    }),
  });
}
