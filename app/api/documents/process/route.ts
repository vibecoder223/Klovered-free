import { requireGuest, AuthError } from "@/utils/auth";
import { NextResponse } from "next/server";
import { tryCreateAdminClient } from "@/utils/supabase/admin";
import { enqueueIngest } from "@/lib/jobs";

export const runtime = "nodejs";
export const maxDuration = 30;

// Enqueue-only. The pipeline runs asynchronously: this just queues the first
// stage and returns immediately. A drain driver (pg_cron / npm run drain)
// advances the document through ingest → extract → structure → generate.
// Also serves as "retry": it clears prior job rows and re-queues from the top.
export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await requireGuest();
  } catch (e) {
    const s = e instanceof AuthError ? e.status : 401;
    return NextResponse.json({ error: "No session" }, { status: s });
  }
  const { supabase } = ctx;

  const body = await req.json().catch(() => ({} as { document_id?: string }));
  const { document_id } = body as { document_id?: string };
  if (!document_id) return NextResponse.json({ error: "document_id required" }, { status: 400 });

  const { data: doc } = await supabase
    .from("documents")
    .select("id, deal_id, deals(org_id)")
    .eq("id", document_id)
    .maybeSingle();
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const orgId =
    (doc as any).deals?.org_id ?? (doc as any).deals?.[0]?.org_id ?? null;
  if (!orgId) return NextResponse.json({ error: "Org not resolved for document" }, { status: 400 });

  // If the LLM key is missing, mark the document and return success — upload
  // UX shouldn't error out.
  // Must match the key resolution in lib/mistral.ts (LLM_API_KEY ?? MISTRAL_API_KEY).
  if (!process.env.LLM_API_KEY && !process.env.MISTRAL_API_KEY) {
    await supabase
      .from("documents")
      .update({
        processing_status: "uploaded",
        error_message:
          "No LLM API key configured. The file is stored, but the AI pipeline is disabled until LLM_API_KEY or MISTRAL_API_KEY is set in .env.local.",
      })
      .eq("id", document_id);
    return NextResponse.json({ ok: true, skipped: true, reason: "llm_key_missing" });
  }

  const admin = tryCreateAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY required to run the pipeline." },
      { status: 503 }
    );
  }

  // Clean slate for (re)processing: drop any prior job rows, then queue ingest.
  await admin.from("jobs").delete().eq("document_id", document_id);
  await enqueueIngest(admin, { documentId: document_id, orgId });
  await admin
    .from("documents")
    .update({ processing_status: "queued", error_message: null })
    .eq("id", document_id);

  // Kick the drain immediately (fire-and-forget) so the pipeline starts now
  // instead of on the next cron tick. The drain push-chains all successor
  // stages within its own time budget; the interval driver stays as recovery.
  if (process.env.CRON_SECRET) {
    const origin = new URL(req.url).origin;
    void fetch(`${origin}/api/jobs/drain`, {
      method: "POST",
      headers: { "x-cron-secret": process.env.CRON_SECRET },
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true, queued: true });
}
