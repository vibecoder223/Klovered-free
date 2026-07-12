import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { getClaimsUser } from "@/utils/auth";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

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
  const { data: existing } = await admin
    .from("team_members")
    .select("org_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (existing) {
    const { data: deal } = await admin
      .from("deals")
      .select("id")
      .eq("org_id", existing.org_id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    return NextResponse.json({ org_id: existing.org_id, deal_id: deal?.id ?? null });
  }

  // Rate limit only the create path (existing sessions are cheap idempotent
  // reads). Keyed per client IP: 10 new guest workspaces per hour per IP.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!rateLimit(`session:${ip}`, 10, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many sessions" }, { status: 429 });
  }

  const slug = `guest-${crypto.randomUUID().slice(0, 12)}`;
  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .insert({ name: "Guest workspace", slug })
    .select()
    .single();
  if (orgErr) return NextResponse.json({ error: orgErr.message }, { status: 500 });

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

  await admin.from("org_settings").insert({ org_id: org.id });

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
  if (dealErr) return NextResponse.json({ error: dealErr.message }, { status: 500 });

  return NextResponse.json({ org_id: org.id, deal_id: deal.id });
}
