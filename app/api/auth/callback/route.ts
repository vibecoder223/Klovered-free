import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { getSiteUrl } from "@/utils/site-url";

// OAuth return leg for linkIdentity (Google). Adapted from Propello's callback:
// the free tool has no /dashboard or /auth/login, so success and failure both
// land on the 3-step flow. On error we send the visitor back to /answers with a
// flag rather than to a login page (the anonymous session still works — the
// upgrade just didn't complete).
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/answers";

  const safeNext = next.startsWith("/") ? next : "/" + next;
  const redirectTo = `${getSiteUrl()}${safeNext}`;

  if (!code) {
    return NextResponse.redirect(`${getSiteUrl()}/answers?link=missing`);
  }

  const supabase = createClient(await cookies());
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const url = new URL(redirectTo);
    url.searchParams.set("link", "error");
    return NextResponse.redirect(url.toString());
  }

  const url = new URL(redirectTo);
  url.searchParams.set("link", "ok");
  return NextResponse.redirect(url.toString());
}
