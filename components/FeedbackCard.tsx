"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

// One-time feedback card, shown at the bottom-right of the Answers screen after
// a visitor has seen their drafted answers. Not a blocking modal — it slides in,
// and dismissing (×, "Not now", or submitting) marks it seen so it never
// returns. The parent decides WHEN to mount this (post-value trigger); this
// component owns the "seen" guard, the states, and the submit.
const SEEN_KEY = "kf_feedback_seen_v1";

// localStorage is the client-side "don't show again" guard (covers guests, who
// are ephemeral). The backend also keys feedback unique per user, so a repeat
// submit upserts rather than duplicating — "once" holds even if this is cleared.
export function feedbackAlreadyGiven(): boolean {
  try {
    return !!localStorage.getItem(SEEN_KEY);
  } catch {
    // localStorage blocked (private mode) — treat as "seen" so we never nag.
    return true;
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* ignore */
  }
}

type Phase = "ask" | "rated" | "sending" | "thanks";

export default function FeedbackCard({
  dealId,
  answeredCount,
  canReply,
  onClose,
}: {
  dealId: string | null;
  answeredCount: number;
  // Guests get an optional email field (so they can be reached for a reply);
  // signed-in accounts already have one on file, so it's hidden for them.
  canReply: boolean;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("ask");
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // Escape dismisses, matching the tool's other overlays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function dismiss() {
    markSeen();
    onClose();
  }

  function pick(n: number) {
    setRating(n);
    setPhase("rated");
    setErr(null);
  }

  async function send() {
    if (phase === "sending" || rating < 1) return;
    setPhase("sending");
    setErr(null);
    try {
      await api.submitFeedback({
        rating,
        comment: comment.trim() || undefined,
        email: canReply ? email.trim() || undefined : undefined,
        deal_id: dealId,
      });
      markSeen();
      setPhase("thanks");
      // The thank-you lingers briefly, then the card retires itself.
      setTimeout(onClose, 2600);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not send. Please try again.");
      setPhase("rated");
    }
  }

  if (phase === "thanks") {
    return (
      <div className="kf-fb kf-fb-thanks" role="status">
        <div className="kf-fb-check">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 12.5l4.2 4.2L19 7" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="kf-fb-thx-t">Thanks — this genuinely helps.</div>
        <div className="kf-fb-thx-s">We read every note as we shape what Klovered does next.</div>
      </div>
    );
  }

  const rated = phase !== "ask";
  const shown = hover || rating;

  return (
    <div className="kf-fb" role="dialog" aria-label="Leave feedback">
      <button className="kf-fb-close" onClick={dismiss} aria-label="Dismiss">×</button>
      <div className="kf-fb-eyebrow">
        <svg className="kf-fb-spark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" fill="var(--accent)" />
        </svg>
        Quick question
      </div>
      <div className="kf-fb-title">How did Klovered do?</div>
      {!rated && (
        <div className="kf-fb-sub">
          You just turned an RFP into {answeredCount} drafted answer{answeredCount === 1 ? "" : "s"}. How was the quality?
        </div>
      )}

      <div className="kf-fb-stars" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            className={`kf-fb-star${n <= shown ? " on" : ""}`}
            aria-label={`${n} star${n === 1 ? "" : "s"}`}
            aria-pressed={rating === n}
            onMouseEnter={() => setHover(n)}
            onFocus={() => setHover(n)}
            onClick={() => pick(n)}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 3.5l2.6 5.6 6 .7-4.5 4 1.3 6-5.4-3.1L6.6 19.8l1.3-6-4.5-4 6-.7L12 3.5z"
                fill={n <= shown ? "var(--accent)" : "none"}
                stroke={n <= shown ? "var(--accent)" : "var(--fg-4)"}
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ))}
      </div>
      {!rated && <div className="kf-fb-scale"><span>Not useful</span><span>Very useful</span></div>}

      {rated && (
        <>
          <div className="kf-fb-rated">Thanks. <b>Anything we could do better?</b></div>
          <textarea
            className="kf-fb-note"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What worked, what missed… (optional)"
            rows={3}
          />
          {canReply && (
            <input
              className="kf-fb-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email (optional, for a reply)"
            />
          )}
          {err && <div className="kf-fb-err" role="alert">{err}</div>}
          <div className="kf-fb-actions">
            <button type="button" className="kf-fb-ghost" onClick={dismiss}>Not now</button>
            <button type="button" className="kf-fb-btn primary" onClick={send} disabled={phase === "sending"}>
              {phase === "sending" ? "Sending…" : "Send feedback"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
