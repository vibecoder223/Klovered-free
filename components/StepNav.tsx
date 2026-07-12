"use client";
import Link from "next/link";

// The public flow's progress indicator. Three numbered steps, sentence case,
// Geist (no monospace). State is carried by color plus an icon, never color
// alone: active = accent-tint pill + accent label + green numeral; completed =
// green check numeral; upcoming = muted. Steps are links; the active one gets
// aria-current="page". Styling lives in globals.css (.stepnav*).
const STEPS = [
  { n: 1, href: "/knowledge", label: "Add knowledge" },
  { n: 2, href: "/rfp", label: "Upload RFP" },
  { n: 3, href: "/answers", label: "Answers" },
] as const;

type Status = "done" | "active" | "upcoming";

function CheckMark() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2.4 6.3 4.8 8.7 9.6 3.3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function StepNav({ current }: { current: 1 | 2 | 3 }) {
  return (
    <nav className="stepnav" aria-label="Progress">
      {STEPS.map((s, i) => {
        const status: Status =
          s.n < current ? "done" : s.n === current ? "active" : "upcoming";
        return (
          <span className="stepnav-item" key={s.n}>
            {i > 0 && <span className="stepnav-rule" aria-hidden="true" />}
            <Link
              href={s.href}
              className={`stepnav-step is-${status}`}
              aria-current={status === "active" ? "page" : undefined}
            >
              <span className="stepnav-num">
                {status === "done" ? <CheckMark /> : s.n}
              </span>
              <span className="stepnav-label">{s.label}</span>
            </Link>
          </span>
        );
      })}
    </nav>
  );
}
