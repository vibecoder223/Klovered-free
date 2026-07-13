"use client";
import { createContext, useContext } from "react";
import StepNav from "./StepNav";
import AuthButton from "./AuthButton";
import { useGuestSession } from "@/lib/use-session";

// The public 3-step shell. No sidebar, no AppShell — a linear flow. It mounts
// useGuestSession() exactly once (here, via context) so the anonymous session +
// org exist before any screen calls an API. Screens read it with useSession().
// Until the session is ready, the content area shows a calm skeleton rather than
// a spinner, and no child fetch fires (children are only mounted once ready).
type Session = { ready: boolean; orgId: string | null; dealId: string | null };

const SessionCtx = createContext<Session>({
  ready: false,
  orgId: null,
  dealId: null,
});

export const useSession = () => useContext(SessionCtx);

const MARKETING_URL = process.env.NEXT_PUBLIC_MARKETING_URL ?? "/";

function PreparingSession() {
  return (
    <div className="kf-card" style={{ padding: 16 }}>
      <div aria-hidden="true">
        <div className="kf-skel-line" style={{ width: "38%" }} />
        <div className="kf-skel-line" style={{ width: "62%", marginTop: 10 }} />
        <div className="kf-skel-line" style={{ width: "52%", marginTop: 10 }} />
      </div>
      <p style={{ marginTop: 16, fontSize: 12.5, color: "var(--fg-4)" }} role="status">
        Preparing your private session.
      </p>
    </div>
  );
}

export default function PublicShell({
  step,
  children,
}: {
  step: 1 | 2 | 3;
  children: React.ReactNode;
}) {
  const session = useGuestSession();

  return (
    <SessionCtx.Provider value={session}>
      <header className="pub-topbar">
        <a className="pub-wordmark" href={MARKETING_URL}>
          klovered
          <span className="pub-free">free</span>
        </a>
        <div className="pub-nav-center">
          <StepNav current={step} />
        </div>
        <div className="pub-authslot">
          <a className="pub-fullplatform" href={MARKETING_URL}>
            Full platform
          </a>
          <AuthButton />
        </div>
      </header>

      <main className="pub-main">
        {session.ready ? children : <div className="kf-page"><PreparingSession /></div>}
      </main>

      <footer className="pub-footer">
        Your files are private to this session and auto-delete after 48 hours.
        Sign in to keep them.
      </footer>
    </SessionCtx.Provider>
  );
}
