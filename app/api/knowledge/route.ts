import { requireGuest, AuthError } from "@/utils/auth";
import { NextResponse } from "next/server";

export async function GET() {
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
    .select("id, filename, doc_type, ingestion_status, page_count, file_size, created_at, error_message")
    .order("created_at", { ascending: false });

  return NextResponse.json({ items: data ?? [] });
}
