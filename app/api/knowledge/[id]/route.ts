import { requireGuest, AuthError } from "@/utils/auth";
import { NextResponse } from "next/server";
import { tryCreateAdminClient } from "@/utils/supabase/admin";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requireGuest();
  } catch (e) {
    const s = e instanceof AuthError ? e.status : 401;
    return NextResponse.json({ error: "No session" }, { status: s });
  }
  const { supabase } = ctx;

  const { data } = await supabase
    .from("knowledge_documents")
    .select("id, ingestion_status, error_message, page_count")
    .eq("id", id)
    .maybeSingle();
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Extract stage from error_message if it has STAGE: prefix.
  const errMsg = data.error_message ?? "";
  const stage = errMsg.startsWith("STAGE:") ? errMsg.slice(6) : null;
  const errorMessage = stage ? null : data.error_message;

  return NextResponse.json({
    knowledge_document: {
      id: data.id,
      ingestion_status: data.ingestion_status,
      stage,
      error_message: errorMessage,
      page_count: data.page_count,
    },
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requireGuest();
  } catch (e) {
    const s = e instanceof AuthError ? e.status : 401;
    return NextResponse.json({ error: "No session" }, { status: s });
  }
  const { supabase } = ctx;

  // Look up the file_path under RLS first to confirm access
  const { data: kdoc } = await supabase
    .from("knowledge_documents")
    .select("id, file_path")
    .eq("id", id)
    .maybeSingle();
  if (!kdoc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const writer = tryCreateAdminClient() ?? supabase;

  // Chunks cascade via FK on knowledge_document_id; row delete also removes them.
  const { error } = await writer.from("knowledge_documents").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Best-effort storage purge — leave a stale object rather than fail the delete.
  await (tryCreateAdminClient() ?? supabase).storage.from("knowledge").remove([kdoc.file_path]);

  return NextResponse.json({ ok: true });
}
