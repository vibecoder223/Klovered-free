// Shared layout primitives (DESIGN.md "Page anatomy" + "Layout primitives").
// Pages compose these; they do not hand-roll shells, cards, metrics, or tables.
// This is the mechanism that keeps every page looking like the same product.
import React from "react";
import Link from "next/link";

/* ── Page shell ─────────────────────────────────────────────────────────────
 * The one container: 1280px, fixed gutters, 20px vertical rhythm. Every page
 * body goes inside this. */
export function Page({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`page-shell ${className}`}>{children}</div>;
}

/* Page header — title + one optional sub line. No meta pill, no actions
 * (primary actions live in the Topbar). */
export function PageHeader({ title, sub }: { title: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="page-header">
      <h1 className="page-title">{title}</h1>
      {sub != null && <p className="page-sub">{sub}</p>}
    </div>
  );
}

/* ── Readings (metrics card) ────────────────────────────────────────────────
 * The single KPI treatment: a bordered white card of equal cells, big sans
 * numbers, state color only on the values that carry risk. Never a band. */
export type Reading = {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: "warn" | "err" | "ok";
};

export function Readings({ items }: { items: Reading[] }) {
  return (
    <div
      className="readings"
      role="list"
      aria-label="Summary"
      style={{ ["--cols" as any]: items.length }}
    >
      {items.map((r, i) => (
        <div className="reading" role="listitem" key={i}>
          <div className={`n${r.tone ? " " + r.tone : ""}`}>{r.value}</div>
          <div className="l">{r.label}</div>
        </div>
      ))}
    </div>
  );
}

/* ── SectionCard ────────────────────────────────────────────────────────────
 * The one card. Head = title + optional count + optional subtitle + optional
 * right link. Pass `flush` to drop the head (bare card). Everything boxed on a
 * page is this component. No bespoke cards, no nesting. */
export function SectionCard({
  title,
  count,
  subtitle,
  link,
  linkHref,
  children,
  className = "",
}: {
  title?: React.ReactNode;
  count?: React.ReactNode;
  subtitle?: React.ReactNode;
  link?: React.ReactNode;
  linkHref?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`section-card ${className}`} style={{ minWidth: 0 }}>
      {(title != null || link != null) && (
        <div className="section-card-head">
          <div>
            {title != null && <span className="section-card-title">{title}</span>}
            {count != null && <span className="section-card-count">{count}</span>}
            {subtitle != null && <div className="section-card-sub">{subtitle}</div>}
          </div>
          {link != null && linkHref && (
            <Link href={linkHref} className="block-more">{link}</Link>
          )}
        </div>
      )}
      {children}
    </section>
  );
}

/* ── Table ──────────────────────────────────────────────────────────────────
 * Restyled data table (sentence-case headers, hairline rows). Scrolls inside
 * its own container so it never breaks the page width. Compose thead/tbody. */
export function Table({ children, minWidth }: { children: React.ReactNode; minWidth?: number }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table" style={minWidth ? { minWidth } : undefined}>
        {children}
      </table>
    </div>
  );
}

/* ── StatusBadge ────────────────────────────────────────────────────────────
 * The one status vocabulary: dot + sentence label. Used by deals, questions,
 * documents, review. Never color alone. */
export function StatusBadge({
  label,
  tone,
}: {
  label: React.ReactNode;
  tone?: "accent" | "ok" | "warn" | "err";
}) {
  return <span className={`st${tone ? " st-" + tone : ""}`}>{label}</span>;
}

/* ── Meter ──────────────────────────────────────────────────────────────────
 * Completion track + green fill + sans percentage. */
export function Meter({ pct, width = 72 }: { pct: number | null; width?: number }) {
  if (pct == null) {
    return <span className="meter-pct" style={{ color: "var(--fg-4)" }}>not started</span>;
  }
  return (
    <div className="meter">
      <span className="meter-track" style={{ width }}>
        <span className={`meter-fill${pct >= 100 ? " full" : ""}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="meter-pct">{pct}%</span>
    </div>
  );
}

/* ── KeyValueRow ────────────────────────────────────────────────────────────
 * A labeled figure row inside a card (e.g. "Answers drafted   38"). */
export function KeyValueRow({
  k,
  v,
  tone,
}: {
  k: React.ReactNode;
  v: React.ReactNode;
  tone?: "warn" | "err" | "ok";
}) {
  return (
    <div className="trust-row">
      <span className="trust-k">{k}</span>
      <span className="trust-v" style={tone ? { color: `var(--${tone})` } : undefined}>{v}</span>
    </div>
  );
}

/* ── EmptyState ─────────────────────────────────────────────────────────────
 * The one zero-state: centered title + hint + optional action. */
export function EmptyState({
  title,
  hint,
  action,
  actionHref,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  actionHref?: string;
}) {
  return (
    <div className="empty-state">
      <div className="es-title">{title}</div>
      {hint != null && <div className="es-hint">{hint}</div>}
      {action != null && actionHref && (
        <Link href={actionHref} className="btn btn-primary" style={{ marginTop: 4 }}>{action}</Link>
      )}
    </div>
  );
}
