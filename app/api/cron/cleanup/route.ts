import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

// 48h expiry for anonymous guest data. A scheduler (pg_cron / GitHub Action /
// Vercel cron) POSTs this hourly with the shared CRON_SECRET. It purges guest
// orgs older than the window whose members are ALL still anonymous — any org
// where a member upgraded to Google (is_anonymous=false) is exempt and kept.
//
// Order per org: storage first (no FK cascade covers Storage), then the org row
// (every child table FKs to organizations with ON DELETE CASCADE — verified
// against migrations 0001/0002/0006/0010/0016), then the anonymous auth.users.
const WINDOW_MS = 48 * 60 * 60 * 1000;

async function emptyBucketFolder(
  admin: ReturnType<typeof createAdminClient>,
  bucket: string,
  prefix: string
): Promise<number> {
  const { data: objects } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
  if (!objects?.length) return 0;
  const paths = objects.map((o) => `${prefix}/${o.name}`);
  await admin.storage.from(bucket).remove(paths);
  return paths.length;
}

// Shared body — authorization is enforced by the POST/GET wrappers below.
async function runCleanup(): Promise<NextResponse> {
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();

  const { data: orgs, error } = await admin
    .from("organizations")
    .select("id, slug, created_at")
    .like("slug", "guest-%")
    .lt("created_at", cutoff);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let purged = 0;
  let skippedUpgraded = 0;
  let filesRemoved = 0;
  const errors: string[] = [];

  for (const org of orgs ?? []) {
    try {
      const { data: members } = await admin
        .from("team_members")
        .select("user_id")
        .eq("org_id", org.id);

      // Exempt: any member upgraded to a permanent (Google) account.
      let allAnonymous = true;
      for (const m of members ?? []) {
        const { data } = await admin.auth.admin.getUserById(m.user_id);
        if (data?.user && (data.user as { is_anonymous?: boolean }).is_anonymous === false) {
          allAnonymous = false;
          break;
        }
      }
      if (!allAnonymous) {
        skippedUpgraded++;
        continue;
      }

      // Storage: knowledge/<org_id>/* and documents/<deal_id>/* (RFP + exports).
      filesRemoved += await emptyBucketFolder(admin, "knowledge", org.id);
      const { data: deals } = await admin.from("deals").select("id").eq("org_id", org.id);
      for (const d of deals ?? []) {
        filesRemoved += await emptyBucketFolder(admin, "documents", d.id);
      }

      // DB: one delete, FK cascade clears deals, documents, chunks, questions,
      // responses, citations, knowledge_documents, jobs, exports, org_settings,
      // team_members, invites, templates.
      const { error: delErr } = await admin.from("organizations").delete().eq("id", org.id);
      if (delErr) throw delErr;

      // Auth users last (not covered by the org cascade).
      for (const m of members ?? []) {
        await admin.auth.admin.deleteUser(m.user_id).catch(() => {});
      }
      purged++;
    } catch (e) {
      errors.push(`${org.slug}: ${(e as Error).message}`);
    }
  }

  return NextResponse.json({
    ok: true,
    scanned: orgs?.length ?? 0,
    purged,
    skippedUpgraded,
    filesRemoved,
    ...(errors.length ? { errors } : {}),
  });
}

// Two authorized entry points, same body:
//   POST — pg_cron / GitHub Action / manual curl: shared secret in x-cron-secret.
//   GET  — Vercel Cron: the platform sends `Authorization: Bearer $CRON_SECRET`
//          automatically for scheduled invocations (see vercel.json `crons`).
// A blank CRON_SECRET disables both — never run an unauthenticated purge.
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (
    req.headers.get("x-cron-secret") === secret ||
    req.headers.get("authorization") === `Bearer ${secret}`
  );
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return runCleanup();
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return runCleanup();
}
