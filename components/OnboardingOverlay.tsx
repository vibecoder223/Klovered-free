"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// One-time first-run intro. Shows a small carousel over a dimmed backdrop on the
// visitor's first arrival, then never again (remembered in localStorage). It's
// purely explanatory — no backend, no session coupling — so it can mount at the
// shell level and sit above whatever screen is underneath. Dismissing it (Skip,
// Escape, backdrop click, or finishing) all count as "seen".
//
// Each slide's hero is a "product peek": a real-looking slice of the tool that
// step produces, so the intro previews the actual thing instead of describing
// it. The peek bleeds off the bottom of the hero (mask fade) to read as the top
// of a live screen rather than a boxed screenshot.
const SEEN_KEY = "kf_onboarding_seen_v1";

type Slide = {
  peek: React.ReactNode;
  title: string;
  body: string;
};

const SLIDES: Slide[] = [
  {
    peek: <PeekKnowledge />,
    title: "Add your knowledge",
    body: "Upload past proposals, product docs and security policies — the source of truth every answer is drawn from.",
  },
  {
    peek: <PeekRfp />,
    title: "Upload the RFP",
    body: "Drop in the questionnaire. Klovered pulls out every question automatically, so nothing gets missed.",
  },
  {
    peek: <PeekCited />,
    title: "Answers, every one cited",
    body: "Each answer is drafted only from your documents, linked back to the source. Never invented.",
  },
  {
    peek: <PeekReady />,
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
    <div className="kf-ob-backdrop" onClick={dismiss} role="presentation">
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

        <div className="kf-ob-hero">
          <div className="kf-ob-peek" key={i} aria-hidden="true">
            {slide.peek}
          </div>
        </div>

        <div className="kf-ob-content">
          <div className="kf-ob-copy" key={i}>
            <div className="kf-ob-kicker">
              {last ? "Ready" : `Step ${i + 1} of ${SLIDES.length - 1}`}
            </div>
            <h2 id="kf-ob-title" className="kf-ob-title">
              {slide.title}
            </h2>
            <p className="kf-ob-text">{slide.body}</p>
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
    </div>
  );
}

/* ── product-peek heroes: realistic slices of each step's screen ───────────── */

function PeekKnowledge() {
  return (
    <div className="kf-pk">
      <div className="kf-pk-drop">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 15V5m0 0l-4 4m4-4l4 4" stroke="var(--fg-4)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5 17h14" stroke="var(--border-strong)" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
        <span>Drop files to add knowledge</span>
      </div>
      <div className="kf-pk-doc">
        <span className="kf-pk-fic"><FileGlyph /></span>
        <span className="kf-pk-fn">
          Acme_proposal_2025.pdf
          <span className="kf-pk-meta">1.2 MB</span>
        </span>
        <span className="kf-pk-status"><span className="kf-pk-dot" />Ready</span>
      </div>
      <div className="kf-pk-doc kf-pk-dim">
        <span className="kf-pk-fic"><FileGlyph /></span>
        <span className="kf-pk-fn">
          Security_policy.docx
          <span className="kf-pk-meta">340 KB</span>
        </span>
      </div>
    </div>
  );
}

function PeekRfp() {
  return (
    <div className="kf-pk">
      <div className="kf-pk-head">
        <span className="kf-pk-title">Security questionnaire</span>
        <span className="kf-pk-chip">24 questions found</span>
      </div>
      <div className="kf-pk-q">
        <span className="kf-pk-qn">Q1</span>
        <span>Describe your data encryption at rest.</span>
      </div>
      <div className="kf-pk-q">
        <span className="kf-pk-qn">Q2</span>
        <span>Do you support SSO / SAML?</span>
      </div>
      <div className="kf-pk-q kf-pk-dim">
        <span className="kf-pk-qn">Q3</span>
        <span className="kf-pk-skel" />
      </div>
    </div>
  );
}

function PeekCited() {
  return (
    <div className="kf-pk">
      <div className="kf-pk-ask">Do you support SSO / SAML?</div>
      <p className="kf-pk-ans">
        Yes. Klovered supports SAML 2.0 and OIDC single sign-on with all major
        identity providers, including Okta and Azure AD.
      </p>
      <div className="kf-pk-cites">
        <span className="kf-pk-cite"><CiteGlyph />Security_policy.pdf · p.4</span>
        <span className="kf-pk-cite"><CiteGlyph />SSO_setup.docx</span>
      </div>
    </div>
  );
}

function PeekReady() {
  return (
    <div className="kf-pk kf-pk-center">
      <span className="kf-pk-check">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5 13l4 4L19 7" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="kf-pk-ready-t">Ready to answer your RFP</div>
      <div className="kf-pk-ready-s">3 files free · minutes to a draft</div>
    </div>
  );
}

function FileGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M13 3H7a1 1 0 00-1 1v16a1 1 0 001 1h10a1 1 0 001-1V8l-5-5z" stroke="var(--fg-4)" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M13 3v5h5" stroke="var(--fg-4)" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

function CiteGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" stroke="var(--fg-4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
