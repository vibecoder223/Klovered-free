"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type GuestSession = {
  ready: boolean;
  orgId: string | null;
  dealId: string | null;
  isAnonymous: boolean;
  email: string | null;
};

// Key under which an accepted invite stashes the SHARED deal id, so the invitee
// works on the shared deal for the rest of the tab rather than their own.
const ACTIVE_DEAL_KEY = "klovered:activeDeal";

// Establishes the session on first mount via the backend's shared cookie:
//  • GET /api/auth/me — reuse an existing session (returning guest or account).
//  • otherwise POST /api/auth/guest — mint a fresh anonymous guest.
// If an invite has been accepted this tab, the shared deal overrides the
// session's default deal.
export function useGuestSession(): GuestSession {
  const [state, setState] = useState<GuestSession>({
    ready: false,
    orgId: null,
    dealId: null,
    isAnonymous: true,
    email: null,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let s;
        try {
          s = await api.me();
        } catch {
          s = await api.guest();
        }
        if (cancelled) return;
        let dealId = s.deal_id ?? null;
        try {
          const active = sessionStorage.getItem(ACTIVE_DEAL_KEY);
          if (active) dealId = active;
        } catch {
          // sessionStorage unavailable — fall back to the default deal.
        }
        setState({
          ready: true,
          orgId: s.org_id,
          dealId,
          isAnonymous: s.is_anonymous,
          email: s.email ?? null,
        });
      } catch (e) {
        if (!cancelled) console.error("Guest session bootstrap failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

export { ACTIVE_DEAL_KEY };
