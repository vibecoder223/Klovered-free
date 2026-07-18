"use client";
import { createContext, useContext, useEffect, useState } from "react";
import StepNav from "./StepNav";
import AuthButton from "./AuthButton";
import InviteButton from "./InviteButton";
import OnboardingOverlay from "./OnboardingOverlay";
import { useGuestSession } from "@/lib/use-session";

// The public 3-step shell. No sidebar, no AppShell — a linear flow. It mounts
// useGuestSession() exactly once (here, via context) so the anonymous session +
// org exist before any screen calls an API. Screens read it with useSession().
// Until the session is ready, the content area shows a calm skeleton rather than
// a spinner, and no child fetch fires (children are only mounted once ready).
type Session = {
  ready: boolean;
  orgId: string | null;
  dealId: string | null;
  isAnonymous: boolean;
  email: string | null;
};

const SessionCtx = createContext<Session>({
  ready: false,
  orgId: null,
  dealId: null,
  isAnonymous: true,
  email: null,
});

export const useSession = () => useContext(SessionCtx);

const MARKETING_URL = process.env.NEXT_PUBLIC_MARKETING_URL ?? "/";

function PreparingSession() {
  // If bootstrap is still not ready after a grace period, the retries in
  // useGuestSession have almost certainly been exhausted — offer a manual
  // reload so the visitor is never permanently stranded on the skeleton.
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setStalled(true), 9000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="kf-card" style={{ padding: 16 }}>
      <div aria-hidden="true">
        <div className="kf-skel-line" style={{ width: "38%" }} />
        <div className="kf-skel-line" style={{ width: "62%", marginTop: 10 }} />
        <div className="kf-skel-line" style={{ width: "52%", marginTop: 10 }} />
      </div>
      {stalled ? (
        <p style={{ marginTop: 16, fontSize: 12.5, color: "var(--fg-3)" }} role="alert">
          This is taking longer than usual.{" "}
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              font: "inherit",
              color: "var(--accent-3)",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload
          </button>{" "}
          to retry.
        </p>
      ) : (
        <p style={{ marginTop: 16, fontSize: 12.5, color: "var(--fg-4)" }} role="status">
          Preparing your private session.
        </p>
      )}
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
      <OnboardingOverlay />
      <header className="pub-topbar">
        <a className="pub-wordmark" href={MARKETING_URL}>
          klovered
        </a>
        <div className="pub-nav-center">
          <StepNav current={step} />
        </div>
        <div className="pub-authslot">
          {session.ready && !session.isAnonymous && <InviteButton />}
          <AuthButton />
        </div>
      </header>

      <main className="pub-main">
        {session.ready ? children : <div className="kf-page"><PreparingSession /></div>}
      </main>

      <footer className="pub-footer">
        {session.isAnonymous
          ? "Your files are private to this session and auto-delete after 48 hours. Sign in to keep them."
          : "Your work is saved to your account."}
      </footer>
    </SessionCtx.Provider>
  );
}
