"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type GuestSession = { ready: boolean; orgId: string | null; dealId: string | null };

// Establishes the session on first mount, entirely via the Python backend's
// shared cookie:
//  • GET /api/auth/me — if a session cookie already exists (a returning guest or
//    a signed-in account), reuse it.
//  • otherwise POST /api/auth/guest — mint a fresh anonymous guest + throwaway
//    workspace so the tool is usable with no account.
// Both return org_id + deal_id, which every screen reads via useSession().
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
        let s;
        try {
          s = await api.me(); // existing cookie session?
        } catch {
          s = await api.guest(); // none yet -> provision a guest
        }
        if (!cancelled) setState({ ready: true, orgId: s.org_id, dealId: s.deal_id ?? null });
      } catch (e) {
        // Surface it so PublicShell can offer a manual reload rather than
        // leaving the visitor stranded on the skeleton forever.
        if (!cancelled) console.error("Guest session bootstrap failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
