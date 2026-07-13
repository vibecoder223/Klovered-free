"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";

type GuestSession = { ready: boolean; orgId: string | null; dealId: string | null };

// Retry a flaky async step a few times with linear backoff. The guest-session
// bootstrap runs the instant the app mounts, which in dev races the Next server
// still compiling and in prod races cold starts / brief network blips — any of
// which surface as a one-off "Failed to fetch". Without retry a single hiccup
// permanently strands the visitor on the loading skeleton (never signed in),
// with no recovery short of a manual reload. Bounded retry lets it self-heal.
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${String(lastErr)}`);
}

// Lazily establishes an anonymous guest session on first mount: signs in
// anonymously if there's no existing session, then POSTs /api/session to
// provision (idempotently) the guest's org + hidden deal. The route reads the
// cookie-bound JWT; supabase-js writes those cookies via the browser client, so
// no token is passed by hand here.
export function useGuestSession(): GuestSession {
  const [state, setState] = useState<GuestSession>({
    ready: false,
    orgId: null,
    dealId: null,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) {
          // This client-side call is NOT rate-limited by this app — anonymous
          // auth.users creation is throttled only by Supabase-side controls
          // (dashboard anonymous sign-in rate limits / CAPTCHA), which are the
          // real defense against signup spam here. The 48h guest-cleanup scan
          // is the backstop that reaps any orgs that slip through. See README
          // (added in a later task) for how to configure those Supabase settings.
          await withRetry("anonymous sign-in", async () => {
            const { error } = await supabase.auth.signInAnonymously();
            if (error) throw error;
          });
        }
        const { org_id, deal_id } = await withRetry("provision session", async () => {
          const res = await fetch("/api/session", { method: "POST" });
          if (!res.ok) throw new Error(`/api/session ${res.status}`);
          return res.json();
        });
        if (!cancelled) setState({ ready: true, orgId: org_id, dealId: deal_id });
      } catch (e) {
        // All retries exhausted — surface it so the user isn't silently stuck
        // on the skeleton forever. PublicShell renders a retry affordance when
        // the session never becomes ready.
        if (!cancelled) console.error("Guest session bootstrap failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
