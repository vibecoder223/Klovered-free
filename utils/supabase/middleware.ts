import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

type CookieToSet = { name: string; value: string; options: CookieOptions };

export async function updateSession(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  // If env vars are missing in this deploy, don't crash the edge function.
  // Pass the request through and let the page render — server components will
  // surface a clearer error than a generic MIDDLEWARE_INVOCATION_FAILED 500.
  if (!supabaseUrl || !supabaseKey) {
    console.error(
      "[middleware] Supabase env vars missing. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in Vercel → Project Settings → Environment Variables, then redeploy."
    );
    return NextResponse.next({ request: { headers: request.headers } });
  }

  let supabaseResponse = NextResponse.next({ request: { headers: request.headers } });

  // Fast path: no Supabase auth cookie means no session — skip client creation
  // and the auth check entirely (this runs on every request, incl. health checks).
  const hasAuthCookie = request.cookies
    .getAll()
    .some((c) => c.name.startsWith("sb-") && c.name.includes("-auth-token"));

  let user: { sub?: string } | null = null;

  if (hasAuthCookie) {
    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    });

    // getClaims verifies the JWT locally against the project's public signing
    // keys (JWKS, cached in-process) instead of a network round-trip to the
    // auth server on every request. Expired sessions are still refreshed over
    // the network, and the refreshed cookies land via setAll above.
    const { data } = await supabase.auth.getClaims();
    user = data?.claims ?? null;
  }

  const path = request.nextUrl.pathname;
  const isPublic =
    path === "/" ||
    // Public GTM tool: the 3-step shell pages must render for a first-time,
    // not-yet-signed-in visitor. The shell then signs in anonymously (setting
    // the sb-*-auth-token cookie) BEFORE any screen fetches an API, so the API
    // routes below stay protected — they always carry the cookie by the time
    // they are called (fetches are gated on the session being `ready`).
    path === "/knowledge" ||
    path === "/rfp" ||
    path === "/answers" ||
    path.startsWith("/auth") ||
    path.startsWith("/api/auth") ||
    path.startsWith("/api/jobs/drain") ||
    // CRON_SECRET-gated, called server-to-server by a scheduler with no user
    // session — same exemption rationale as /api/jobs/drain.
    path.startsWith("/api/cron") ||
    path.startsWith("/design-drafts") ||
    path.startsWith("/_next") ||
    path.startsWith("/fonts") ||
    path.startsWith("/favicon") ||
    path.startsWith("/icon");

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/auth/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  // Already-authenticated users have no business on the login or signup screens —
  // send them into the app (or to their intended ?next= target). Other /auth
  // pages are intentionally reachable while signed in: reset-password (recovery
  // session), onboarding (authed but no org yet), and accept (invite).
  if (user && (path === "/auth/login" || path === "/auth/signup")) {
    const url = request.nextUrl.clone();
    const next = request.nextUrl.searchParams.get("next");
    url.pathname = next && next.startsWith("/") ? next : "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
