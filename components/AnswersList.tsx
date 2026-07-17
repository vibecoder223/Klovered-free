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
  const { dealId, ready } = useSession();
  const [qs, setQs] = useState<Q[] | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

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
                    <div className="kf-qt">{q.question_text}</div>
                    {r ? (
                      <>
                        <p className={`kf-qa${b === "gaps" ? " dim" : ""}`}>{r.answer_text}</p>
                        {b === "gaps" ? (
                          <div className="kf-gap-note">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flex: "none", marginTop: 1 }} aria-hidden="true">
                              <path d="M12 3L2.5 20h19L12 3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                              <path d="M12 10v4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                              <circle cx="12" cy="17.2" r="1" fill="currentColor" />
                            </svg>
                            <span>Gap: no source found. Add this to your knowledge, or write it yourself in the export.</span>
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
                      </>
                    ) : (
                      <p className="kf-qa dim">Draft pending.</p>
                    )}
                  </div>
                  <span className={`kf-qstat kf-badge ${badge.tone}`}><span className="kf-d" />{badge.label}</span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Keep strip */}
      <div className="kf-keepstrip">
        <span className="kf-t">
          <b>These answers auto-delete in 48 hours.</b> Sign in with Google to keep them and raise your limits.
        </span>
        <AuthButton />
      </div>
    </div>
  );
}
