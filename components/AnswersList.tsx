"use client";

import { useEffect, useState } from "react";
import { useSession } from "./PublicShell";
import { PageHeader, SectionCard, StatusBadge, Meter, EmptyState } from "./ui";
import CitationChips from "./CitationChips";

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

const SUB = "Review each drafted answer, its confidence, and its sources. Export when you are ready.";

export default function AnswersList() {
  const { dealId, ready } = useSession();
  const [qs, setQs] = useState<Q[] | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !dealId) return;
    fetch(`/api/answers?deal_id=${dealId}`)
      .then((r) => r.json())
      .then((d) => setQs(d.questions ?? []))
      .catch(() => setQs([]));
  }, [ready, dealId]);

  async function exportDocx() {
    if (exporting) return;
    setExporting(true);
    setExportErr(null);
    try {
      const r = await fetch("/api/exports/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deal_id: dealId, format: "docx", citation_style: "inline" }),
      });
      const j = await r.json().catch(() => ({}));
      // The generate route returns { exportId, format }; download is addressed
      // by exportId at /api/exports/[id]/download.
      if (!r.ok || !j.exportId) {
        setExportErr(j.error || "Export failed. Please try again.");
        setExporting(false);
        return;
      }
      window.location.href = `/api/exports/${j.exportId}/download`;
    } catch {
      setExportErr("Export failed. Please try again.");
    }
    setExporting(false);
  }

  // Loading — skeleton rows, no spinner.
  if (qs === null) {
    return (
      <>
        <PageHeader title="Answers" sub={SUB} />
        <SectionCard title="Requirements">
          <div>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="ans-row" style={{ display: "block" }}>
                <div className="pub-skel-line" style={{ width: "46%" }} />
                <div className="pub-skel-line" style={{ width: "92%", marginTop: 10 }} />
                <div className="pub-skel-line" style={{ width: "74%", marginTop: 8 }} />
              </div>
            ))}
          </div>
        </SectionCard>
      </>
    );
  }

  // Empty — teach the next step.
  if (qs.length === 0) {
    return (
      <>
        <PageHeader title="Answers" sub={SUB} />
        <EmptyState
          title="No RFP processed yet"
          hint="Upload an RFP and Klovered will extract its requirements and draft an answer for each, grounded in your knowledge base."
          action="Upload an RFP"
          actionHref="/rfp"
        />
      </>
    );
  }

  const drafted = qs.filter((q) => q.response).length;

  return (
    <>
      <PageHeader title="Answers" sub={SUB} />

      <div className="toolbar">
        <span style={{ fontSize: 12.5, color: "var(--fg-4)" }}>
          {qs.length} {qs.length === 1 ? "requirement" : "requirements"}, {drafted} drafted
        </span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {exportErr && <span style={{ fontSize: 12, color: "var(--err)" }}>{exportErr}</span>}
          <button className="btn btn-primary" onClick={exportDocx} disabled={exporting}>
            {exporting ? "Exporting" : "Export .docx"}
          </button>
        </div>
      </div>

      <SectionCard title="Requirements" count={qs.length}>
        <div>
          {qs.map((q, i) => {
            const r = q.response;
            const conf = r?.confidence != null ? Math.round(r.confidence * 100) : null;
            return (
              <div key={q.id} className="ans-row">
                <span className="ans-index num">{String(i + 1).padStart(2, "0")}</span>
                <div className="ans-body">
                  <div className="ans-q">{q.question_text}</div>
                  {r ? (
                    <>
                      <p className="ans-a">{r.answer_text}</p>
                      <div className="ans-meta">
                        {conf != null && (
                          <span className="ans-conf">
                            Confidence
                            <Meter pct={conf} width={64} />
                          </span>
                        )}
                        {r.gap_flag === "no_source" && <StatusBadge tone="err" label="No source" />}
                      </div>
                      <CitationChips citations={r.citations} />
                    </>
                  ) : (
                    <div className="ans-drafting">Draft pending</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </SectionCard>
    </>
  );
}
