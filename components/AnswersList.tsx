"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "./PublicShell";
import AuthButton from "./AuthButton";
import { api } from "@/lib/api";

type Q = {
  id: string;
  question_text: string;
  status: string;
  response: {
    id: string;
    answer_text: string;
    confidence: number | null;
    gap_flag: string | null;
    citations: { chunk_id: string; filename: string | null; page_start: number | null }[];
  } | null;
};

type Filter = "all" | "answered" | "low" | "gaps";
const LOW_CONF = 0.7;

// Classify a question into exactly one bucket. Order matters: a gap wins over
// low confidence, which wins over answered.
function bucket(q: Q): Exclude<Filter, "all"> | "pending" {
  const r = q.response;
  if (!r) return "pending";
  if (r.gap_flag === "no_source") return "gaps";
  if (r.confidence != null && r.confidence < LOW_CONF) return "low";
  return "answered";
}

export default function AnswersList() {
  const { dealId, ready, isAnonymous } = useSession();
  const [qs, setQs] = useState<Q[] | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  // Editing: every answer is a live textbox, no separate "edit mode" to enter.
  // drafts holds in-progress text per response id (only set once touched);
  // it saves on blur, so the field can be edited freely without a round-trip
  // per keystroke.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingIds, setSavingIds] = useState<Record<string, boolean>>({});
  const [savedIds, setSavedIds] = useState<Record<string, boolean>>({});
  const [rowErr, setRowErr] = useState<Record<string, string>>({});

  // Share: the single-use invite link, shown in a popup once minted.
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareErr, setShareErr] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  // Everyone can edit their own drafted answers (RLS scopes each edit to the
  // caller's org). Inviting a teammate still needs a real account.
  const canEdit = true;
  const canInvite = !isAnonymous;

  function editText(responseId: string, value: string) {
    setDrafts((d) => ({ ...d, [responseId]: value }));
    setRowErr((e) => (e[responseId] ? { ...e, [responseId]: "" } : e));
  }

  async function commitEdit(q: Q) {
    const r = q.response;
    if (!r) return;
    const value = drafts[r.id];
    // Untouched, or unchanged from what's already saved — nothing to do.
    if (value === undefined || value === r.answer_text) return;
    setSavingIds((s) => ({ ...s, [r.id]: true }));
    try {
      await api.editResponse(r.id, value);
      setQs((cur) =>
        cur
          ? cur.map((x) =>
              x.id === q.id && x.response ? { ...x, response: { ...x.response, answer_text: value } } : x,
            )
          : cur,
      );
      setSavedIds((s) => ({ ...s, [r.id]: true }));
      setTimeout(() => setSavedIds((s) => ({ ...s, [r.id]: false })), 1600);
    } catch (e) {
      setRowErr((err) => ({
        ...err,
        [r.id]: e instanceof Error ? e.message : "Could not save. Try again.",
      }));
    }
    setSavingIds((s) => ({ ...s, [r.id]: false }));
  }

  function openShare() {
    setShareOpen(true);
    setShareErr(null);
    if (!inviteLink && !inviting) mintInvite();
  }

  async function mintInvite() {
    if (inviting) return;
    setInviting(true);
    setShareErr(null);
    try {
      const { token } = await api.createInvite();
      setInviteLink(`${window.location.origin}/app/knowledge?invite=${token}`);
    } catch (e) {
      setShareErr(e instanceof Error ? e.message : "Could not create an invite.");
    }
    setInviting(false);
  }

  async function copyLink() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked — the link stays visible for manual copy
    }
  }

  useEffect(() => {
    if (!ready || !dealId) return;
    api
      .dealAnswers(dealId)
      .then((d: { questions?: Q[] }) => setQs(d.questions ?? []))
      .catch(() => setQs([]));
  }, [ready, dealId]);

  // Client-side export (v1): build a Markdown document from the loaded answers
  // and download it — no server round-trip. Full .docx export is a fast follow.
  function exportDocx() {
    if (exporting || !qs || qs.length === 0) return;
    setExporting(true);
    setExportErr(null);
    try {
      const lines: string[] = ["# Klovered — drafted answers", ""];
      qs.forEach((q, i) => {
        lines.push(`## ${i + 1}. ${q.question_text}`);
        const r = q.response;
        if (!r) {
          lines.push("", "_Draft pending._", "");
          return;
        }
        lines.push("", r.answer_text || "");
        if (r.gap_flag === "no_source") {
          lines.push("", "> Gap: no source found — add this to your knowledge base or write it yourself.");
        } else {
          if (r.citations?.length) {
            const srcs = r.citations
              .map((c) => (c.filename ?? "source") + (c.page_start != null ? ` p.${c.page_start}` : ""))
              .join("; ");
            lines.push("", `Sources: ${srcs}`);
          }
          if (r.confidence != null) lines.push(`Confidence: ${r.confidence.toFixed(2)}`);
        }
        lines.push("");
      });
      const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "klovered-answers.md";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportErr("Could not build the download. Please try again.");
    }
    setExporting(false);
  }

  const counts = useMemo(() => {
    const c = { total: 0, answered: 0, low: 0, gaps: 0 };
    (qs ?? []).forEach((q) => {
      c.total++;
      const b = bucket(q);
      if (b === "answered") c.answered++;
      else if (b === "low") c.low++;
      else if (b === "gaps") c.gaps++;
    });
    return c;
  }, [qs]);

  const visible = useMemo(() => {
    if (!qs) return [];
    const needle = query.trim().toLowerCase();
    return qs.filter((q) => {
      const b = bucket(q);
      if (filter === "answered" && b !== "answered") return false;
      if (filter === "low" && b !== "low") return false;
      if (filter === "gaps" && b !== "gaps") return false;
      if (needle && !q.question_text.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [qs, filter, query]);

  // Loading — skeleton rows, no spinner.
  if (qs === null) {
    return (
      <div className="kf-page kf-page-wide">
        <div className="kf-head">
          <h1>Your drafted answers</h1>
          <p>Reading your requirements and their drafted answers.</p>
        </div>
        <div className="kf-card">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="kf-qrow" style={{ padding: "13px 16px" }}>
              <div className="kf-skel-line" style={{ width: "46%" }} />
              <div className="kf-skel-line" style={{ width: "92%", marginTop: 10 }} />
              <div className="kf-skel-line" style={{ width: "74%", marginTop: 8 }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Empty — teach the next step.
  if (qs.length === 0) {
    return (
      <div className="kf-page kf-page-wide">
        <div className="kf-head">
          <h1>Your drafted answers</h1>
          <p>No RFP processed yet.</p>
        </div>
        <div className="kf-card">
          <div style={{ padding: "36px 16px", textAlign: "center" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>No RFP processed yet</div>
            <div style={{ fontSize: 12.5, color: "var(--fg-4)", marginTop: 4, maxWidth: 46 + "ch", marginInline: "auto" }}>
              Upload an RFP and Klovered will extract its requirements and draft an answer for each, grounded in your knowledge base.
            </div>
            <Link href="/rfp" className="btn btn-primary" style={{ marginTop: 16 }}>Upload an RFP</Link>
          </div>
        </div>
      </div>
    );
  }

  const filters: Array<{ id: Filter; label: string; n: number }> = [
    { id: "all", label: "All", n: counts.total },
    { id: "answered", label: "Answered", n: counts.answered },
    { id: "low", label: "Low confidence", n: counts.low },
    { id: "gaps", label: "Gaps", n: counts.gaps },
  ];

  return (
    <div className="kf-page kf-page-wide">
      <div className="kf-head">
        <h1>Your drafted answers</h1>
        <p>
          {counts.total} requirements answered from your knowledge base. Review the gaps, then export.
        </p>
      </div>

      {/* Summary strip */}
      <div className="kf-sum" aria-label="Answer summary">
        <div className="kf-cell"><div className="kf-n">{counts.total}</div><div className="kf-l">requirements</div></div>
        <div className="kf-cell"><div className="kf-n">{counts.answered}</div><div className="kf-l">answered with citations</div></div>
        <div className="kf-cell"><div className="kf-n">{counts.low}</div><div className="kf-l">low confidence</div></div>
        <div className="kf-cell"><div className="kf-n warn">{counts.gaps}</div><div className="kf-l">gaps need your input</div></div>
      </div>

      {/* Toolbar: search + filter chips + export */}
      <div className="kf-toolbar">
        <span className="kf-search">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
            <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search requirements"
            aria-label="Search requirements"
          />
        </span>
        {filters.map((f) => (
          <button
            key={f.id}
            className={`kf-chip${filter === f.id ? " on" : ""}`}
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
          >
            {f.label} {f.n}
          </button>
        ))}
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {shareErr && <span style={{ fontSize: 12, color: "var(--err)" }}>{shareErr}</span>}
          {canInvite && (
            <button className="btn" onClick={openShare} title="Invite one teammate to view and edit">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.8" />
                <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M19 8v6M22 11h-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              Share
            </button>
          )}
          {exportErr && <span style={{ fontSize: 12, color: "var(--err)" }}>{exportErr}</span>}
          <button className="btn btn-primary" onClick={exportDocx} disabled={exporting}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 4v10M12 14l-4-4M12 14l4-4" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M5 17v2a1 1 0 001 1h12a1 1 0 001-1v-2" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {exporting ? "Preparing…" : "Download answers"}
          </button>
        </span>
      </div>

      {!canInvite && qs.length > 0 && (
        <div className="kf-signin-note">Sign in to invite a teammate to this deal.</div>
      )}

      {/* Answer rows */}
      <div className="kf-card">
        {visible.length === 0 ? (
          <div style={{ padding: "28px 16px", textAlign: "center", fontSize: 12.5, color: "var(--fg-4)" }}>
            No requirements match this filter.
          </div>
        ) : (
          visible.map((q) => {
            const r = q.response;
            const n = (qs.indexOf(q) + 1);
            const b = bucket(q);
            const badge =
              b === "gaps" ? { tone: "warn", label: "Gap" } :
              b === "low" ? { tone: "dim", label: "Low confidence" } :
              b === "answered" ? { tone: "ok", label: "Answered" } :
              { tone: "dim", label: "Pending" };
            const conf = r?.confidence != null ? r.confidence.toFixed(2) : null;
            return (
              <div className="kf-qrow" key={q.id}>
                <div className="kf-qtop">
                  <span className="kf-qn">{n}</span>
                  <div className="kf-qbody">
                    {/* Title and status share one line, so the status pill never
                        steals width from the answer well below it — every answer
                        box spans the full column, identical width row to row. */}
                    <div className="kf-qhead-row">
                      <div className="kf-qt">{q.question_text}</div>
                      <span className={`kf-qstat kf-badge ${badge.tone}`}><span className="kf-d" />{badge.label}</span>
                    </div>
                    {r ? (
                      <>
                        <div className="kf-answer">
                          <textarea
                            className="kf-answer-box"
                            value={drafts[r.id] ?? r.answer_text ?? ""}
                            onChange={(e) => editText(r.id, e.target.value)}
                            onBlur={() => commitEdit(q)}
                            readOnly={!canEdit}
                            rows={5}
                            placeholder={b === "gaps" ? "Write this answer yourself…" : undefined}
                          />
                        </div>
                        {b === "gaps" ? (
                          <div className="kf-gap-note">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flex: "none", marginTop: 1 }} aria-hidden="true">
                              <path d="M12 3L2.5 20h19L12 3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                              <path d="M12 10v4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                              <circle cx="12" cy="17.2" r="1" fill="currentColor" />
                            </svg>
                            <span>Gap: no source found. Add this to your knowledge base, or write the answer yourself above.</span>
                          </div>
                        ) : (
                          <div className="kf-qmeta">
                            {r.citations?.map((c, ci) => (
                              <span className="kf-cite" key={c.chunk_id || ci}>
                                {c.filename ?? "source"}
                                {c.page_start != null && <span className="kf-pg">p. {c.page_start}</span>}
                              </span>
                            ))}
                            {conf != null && <span className="kf-conf">confidence {conf}</span>}
                          </div>
                        )}
                        {(savingIds[r.id] || savedIds[r.id] || rowErr[r.id]) && (
                          <div
                            className={`kf-answer-flag${rowErr[r.id] ? " err" : savedIds[r.id] ? " saved" : ""}`}
                            role={rowErr[r.id] ? "alert" : undefined}
                          >
                            {rowErr[r.id] || (savedIds[r.id] ? "Saved ✓" : "Saving…")}
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="kf-qa dim">Draft pending.</p>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {shareOpen && (
        <ShareModal
          link={inviteLink}
          loading={inviting}
          copied={copied}
          error={shareErr}
          onCopy={copyLink}
          onClose={() => setShareOpen(false)}
        />
      )}

      {/* Keep strip — only for guests; signed-in work is already saved. */}
      {isAnonymous && (
        <div className="kf-keepstrip">
          <span className="kf-t">
            <b>These answers auto-delete in 48 hours.</b> Sign in with Google to keep them and raise your limits.
          </span>
          <AuthButton />
        </div>
      )}
    </div>
  );
}

// Share popup — a focused modal (Canva / draw.io style) for the single-use
// invite link. Opens immediately with a "creating…" state, then reveals the
// link with a one-click copy. Closes on overlay click or Escape.
function ShareModal({
  link,
  loading,
  copied,
  error,
  onCopy,
  onClose,
}: {
  link: string | null;
  loading: boolean;
  copied: boolean;
  error: string | null;
  onCopy: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="kf-share-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Share this deal"
      onClick={onClose}
    >
      <div className="kf-share-modal" onClick={(e) => e.stopPropagation()}>
        <button className="kf-share-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h2 className="kf-share-title">Share this deal</h2>
        <p className="kf-share-sub">
          Invite <b>one</b> teammate to view and edit these answers with you. The link works once, then expires.
        </p>

        {error ? (
          <p className="kf-share-error" role="alert">{error}</p>
        ) : (
          <div className="kf-share-row">
            <input
              className="kf-share-input"
              readOnly
              value={loading ? "Creating your link…" : link ?? ""}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Invite link"
            />
            <button
              className="btn btn-primary kf-share-copy"
              onClick={onCopy}
              disabled={loading || !link}
            >
              {copied ? "Copied ✓" : "Copy link"}
            </button>
          </div>
        )}

        <p className="kf-share-foot">They sign in with Google, then land on this deal alongside you.</p>
      </div>
    </div>
  );
}
