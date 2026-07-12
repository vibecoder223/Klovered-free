import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { getClaimsUser } from "@/utils/auth";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper used both on the happy path and on the slug-conflict fallback below:
// look up the caller's own membership + earliest deal, scoped strictly to
// user.id so it can never return another guest's data.
async function lookupExisting(admin: ReturnType<typeof createAdminClient>, userId: string) {
  const { data: member } = await admin
    .from("team_members")
    .select("org_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (!member) return null;
  const { data: deal } = await admin
    .from("deals")
    .select("id")
    .eq("org_id", member.org_id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return { org_id: member.org_id, deal_id: deal?.id ?? null };
}

// Provisions (idempotently) a throwaway org + one hidden deal for the current
// anonymous guest. The guest is identified ONLY by their own cookie-bound JWT
// (getClaimsUser verifies the signature locally) — a caller can never attach
// themselves to someone else's org because every write is keyed to user.id
// derived from that verified token, never from request input.
export async function POST(req: Request) {
  const supabase = createClient(await cookies());
  const user = await getClaimsUser(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Idempotent: if this user already has a membership, return it (never create
  // a second org). Scoped to user.id so this can only ever return the caller's
  // own org — the service-role client is used solely to look up rows keyed by
  // the verified caller, never to expose another guest's data.
  const existing = await lookupExisting(admin, user.id);
  if (existing) return NextResponse.json(existing);

  // Rate limit only the create path (existing sessions are cheap idempotent
  // reads). Keyed per client IP: 10 new guest workspaces per hour per IP.
  //
  // Rate-limit keying: x-vercel-forwarded-for / x-real-ip are set by the platform
  // proxy and not client-forgeable there; bare x-forwarded-for is trusted only
  // behind a proxy that rewrites it. Self-hosting without such a proxy weakens
  // this limiter to per-request-header granularity.
  const ip =
    req.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip")?.trim() ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "local";
  if (!rateLimit(`session:${ip}`, 10, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many sessions" }, { status: 429 });
  }

  // Deterministic per-user slug: the UNIQUE constraint on organizations.slug is
  // the serialization point that makes concurrent provisioning race-safe
  // without any schema change. If two requests from the same user race here,
  // exactly one insert wins; the loser detects the unique violation below and
  // falls back to reading the winner's rows instead of creating a duplicate org.
  const slug = `guest-${user.id}`;
  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .insert({ name: "Guest workspace", slug })
    .select()
    .single();

  if (orgErr) {
    const isUniqueViolation =
      orgErr.code === "23505" || orgErr.message?.toLowerCase().includes("duplicate key");
    if (!isUniqueViolation) {
      return NextResponse.json({ error: orgErr.message }, { status: 500 });
    }

    // Lost the race: another concurrent request for this same user already
    // created the org. The winner is still finishing its member/deal inserts,
    // so poll briefly for the member row to appear before giving up.
    for (let attempt = 0; attempt < 3; attempt++) {
      const winner = await lookupExisting(admin, user.id);
      if (winner) return NextResponse.json(winner);
      await sleep(300);
    }
    return NextResponse.json(
      { error: "Session is still being provisioned, please retry" },
      { status: 503 }
    );
  }

  const { error: memberErr } = await admin.from("team_members").insert({
    org_id: org.id,
    user_id: user.id,
    role: "owner",
    email: user.email ?? "",
    name: "Guest",
  });
  if (memberErr) {
    await admin.from("organizations").delete().eq("id", org.id);
    return NextResponse.json({ error: memberErr.message }, { status: 500 });
  }

  await admin.from("org_settings").insert({ org_id: org.id }); // non-fatal: org is still usable without settings

  const { data: deal, error: dealErr } = await admin
    .from("deals")
    .insert({
      org_id: org.id,
      name: "Free tool session",
      status: "in_progress",
      owner_id: user.id,
    })
    .select("id")
    .single();
  if (dealErr) {
    // Mirror the member-failure rollback: leave nothing orphaned behind.
    await admin.from("team_members").delete().eq("org_id", org.id).eq("user_id", user.id);
    await admin.from("organizations").delete().eq("id", org.id);
    return NextResponse.json({ error: dealErr.message }, { status: 500 });
  }

  return NextResponse.json({ org_id: org.id, deal_id: deal.id });
}
