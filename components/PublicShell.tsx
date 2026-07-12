"use client";
import { createContext, useContext } from "react";
import StepNav from "./StepNav";
import { Page } from "./ui";
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
    <div className="section-card" style={{ padding: 16 }}>
      <div className="pub-skel" aria-hidden="true">
        <div className="pub-skel-line" style={{ width: "38%" }} />
        <div className="pub-skel-line" style={{ width: "62%" }} />
        <div className="pub-skel-line" style={{ width: "52%" }} />
      </div>
      <p className="pub-skel-note" style={{ marginTop: 16 }} role="status">
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
        {/* Google sign-in button mounts here in Task 9. */}
        <div className="pub-authslot" id="auth-slot" />
      </header>

      <main className="pub-main">
        <Page>{session.ready ? children : <PreparingSession />}</Page>
      </main>

      <footer className="pub-footer">
        Your files are private to this session and auto-delete after 48 hours.
        Sign in to keep them.
      </footer>
    </SessionCtx.Provider>
  );
}
