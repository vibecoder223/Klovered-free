"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";

type GuestSession = { ready: boolean; orgId: string | null; dealId: string | null };

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
        const { error } = await supabase.auth.signInAnonymously();
        if (error) {
          console.error(error);
          return;
        }
      }
      const res = await fetch("/api/session", { method: "POST" });
      if (!res.ok) return;
      const { org_id, deal_id } = await res.json();
      if (!cancelled) setState({ ready: true, orgId: org_id, dealId: deal_id });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
