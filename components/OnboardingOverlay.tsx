"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// One-time first-run intro. Shows a small carousel over a dimmed backdrop on the
// visitor's first arrival, then never again (remembered in localStorage). It's
// purely explanatory — no backend, no session coupling — so it can mount at the
// shell level and sit above whatever screen is underneath. Dismissing it (Skip,
// Escape, backdrop click, or finishing) all count as "seen".
const SEEN_KEY = "kf_onboarding_seen_v1";

type Slide = {
  icon: React.ReactNode;
  title: string;
  body: string;
};

const SLIDES: Slide[] = [
  {
    icon: <KnowledgeIcon />,
    title: "Add your knowledge",
    body: "Upload past proposals, product docs and security policies — the source of truth every answer is drawn from.",
  },
  {
    icon: <RfpIcon />,
    title: "Upload the RFP",
    body: "Drop in the questionnaire. Klovered pulls out every question automatically, so nothing gets missed.",
  },
  {
    icon: <CitedIcon />,
    title: "Get answers, every one cited",
    body: "Each answer is drafted only from your documents, with citations back to the source — never invented.",
  },
  {
    icon: <CloverIcon />,
    title: "You're all set",
    body: "Three files free, answers drafted in minutes. Add your first document to begin.",
  },
];

export default function OnboardingOverlay() {
  // Start closed; a first-run check in the effect decides whether to open. This
  // avoids a flash of the modal on repeat visits (and any SSR/hydration mismatch,
  // since localStorage isn't available on the server).
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Deciding visibility from localStorage must happen post-mount: it's a
    // browser-only API, and reading it during render would break SSR hydration.
    // The setState fires at most once, on first visit, so the cascading-render
    // caution doesn't apply here.
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!localStorage.getItem(SEEN_KEY)) setOpen(true);
    } catch {
      // localStorage blocked (private mode / embedded) — just don't show it.
    }
  }, []);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
    setOpen(false);
  }, []);

  const last = i === SLIDES.length - 1;
  const next = useCallback(() => {
    if (last) dismiss();
    else setI((n) => Math.min(n + 1, SLIDES.length - 1));
  }, [last, dismiss]);
  const back = useCallback(() => setI((n) => Math.max(n - 1, 0)), []);

  // Keyboard: Escape dismisses, arrows page. Focus moves to the dialog on open
  // so screen readers announce it and keys are captured immediately.
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dismiss, next, back]);

  if (!open) return null;

  const slide = SLIDES[i];

  return (
    <div
      className="kf-ob-backdrop"
      onClick={dismiss}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className="kf-ob-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kf-ob-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="kf-ob-skip"
          onClick={dismiss}
          aria-label="Skip introduction"
        >
          Skip
        </button>

        <div className="kf-ob-stage">
          <div className="kf-ob-body" key={i}>
            <div className="kf-ob-icon">{slide.icon}</div>
            <div className="kf-ob-kicker">
              {last ? "Ready" : `Step ${i + 1} of ${SLIDES.length - 1}`}
            </div>
            <h2 id="kf-ob-title" className="kf-ob-title">
              {slide.title}
            </h2>
            <p className="kf-ob-text">{slide.body}</p>
          </div>
        </div>

        <div className="kf-ob-foot">
          <div className="kf-ob-dots" role="tablist" aria-label="Introduction progress">
            {SLIDES.map((_, n) => (
              <button
                key={n}
                type="button"
                className={`kf-ob-dot${n === i ? " on" : ""}`}
                aria-label={`Go to slide ${n + 1}`}
                aria-selected={n === i}
                role="tab"
                onClick={() => setI(n)}
              />
            ))}
          </div>
          <div className="kf-ob-btns">
            {i > 0 && (
              <button type="button" className="kf-ob-btn ghost" onClick={back}>
                Back
              </button>
            )}
            <button type="button" className="kf-ob-btn primary" onClick={next}>
              {last ? "Get started" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── slide icons (24px grid, accent stroke, matches the tool's icon set) ────── */

function KnowledgeIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 15V4M12 4L8 8M12 4l4 4" stroke="var(--accent-2)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 15v3a1 1 0 001 1h14a1 1 0 001-1v-3" stroke="var(--accent-2)" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function RfpIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14 3H7a1 1 0 00-1 1v16a1 1 0 001 1h10a1 1 0 001-1V8l-4-5z" stroke="var(--accent-2)" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M14 3v5h4" stroke="var(--accent-2)" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M9 12h6M9 15h6M9 18h3" stroke="var(--accent-2)" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function CitedIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 5h16M4 9h10" stroke="var(--accent-2)" strokeWidth="1.7" strokeLinecap="round" />
      <rect x="4" y="13" width="9" height="6" rx="1.4" stroke="var(--accent-2)" strokeWidth="1.7" />
      <path d="M16.5 15.5l2 2 3.5-3.5" stroke="var(--accent-2)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloverIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 13l4 4L19 7" stroke="var(--accent-2)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
