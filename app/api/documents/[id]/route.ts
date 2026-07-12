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
    .from("documents")
    .select("id, processing_status, error_message")
    .eq("id", id)
    .maybeSingle();
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ document: data });
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

  const { data: doc } = await supabase
    .from("documents")
    .select("id, file_path, deal_id, deals(org_id)")
    .eq("id", id)
    .maybeSingle();
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const writer = tryCreateAdminClient() ?? supabase;

  // Storage cleanup first (best-effort)
  if (doc.file_path) {
    await writer.storage.from("documents").remove([doc.file_path]);
  }

  // Cascade deletes happen via FK on questions/extracted_requirements/etc.
  const { error } = await writer.from("documents").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
