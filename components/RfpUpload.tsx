"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { useSession } from "./PublicShell";
import { PageHeader, SectionCard } from "./ui";

// Real processing_status values, verified against lib/jobs.ts (deriveDocStatus)
// and lib/agents.ts (setStatus) — NOT the brief's guessed stage names:
//   uploaded -> queued -> extracting -> analyzing -> structured -> completed
//   failures: failed / extraction_failed / generation_failed
type Phase = { label: string; match: string[] };
const PHASES: Phase[] = [
  { label: "Queued", match: ["uploaded", "queued"] },
  { label: "Reading your RFP", match: ["extracting"] },
  { label: "Extracting requirements", match: ["analyzing"] },
  { label: "Drafting answers", match: ["structured"] },
  { label: "Done", match: ["completed"] },
];

function isFailed(s: string) {
  return s === "failed" || s.endsWith("_failed");
}
function phaseIndex(status: string) {
  const i = PHASES.findIndex((p) => p.match.includes(status));
  return i === -1 ? 0 : i;
}

export default function RfpUpload() {
  const { dealId } = useSession();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [doc, setDoc] = useState<{ id: string; status: string; error?: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Resume: if this session already has a processed RFP, jump to answers.
  useEffect(() => {
    if (!dealId) return;
    let cancelled = false;
    fetch(`/api/answers?deal_id=${dealId}`)
      .then((r) => r.json())
      .then(({ questions }) => {
        if (!cancelled && questions?.length) window.location.href = "/answers";
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dealId]);

  // Poll processing status until a terminal state, then advance to answers.
  useEffect(() => {
    if (!doc || doc.status === "completed" || isFailed(doc.status)) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/documents/${doc.id}`);
        if (!r.ok) return;
        const { document } = await r.json();
        setDoc({ id: document.id, status: document.processing_status, error: document.error_message });
        if (document.processing_status === "completed") window.location.href = "/answers";
      } catch {
        /* transient network error, keep polling */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [doc]);

  const handleFile = useCallback(
    async (f: File | null) => {
      if (!f || !dealId || busy) return;
      setErr(null);
      setBusy(true);
      try {
        const fd = new FormData();
        fd.append("file", f);
        fd.append("deal_id", dealId);
        const up = await fetch("/api/documents/upload", { method: "POST", body: fd });
        const j = await up.json().catch(() => ({}));
        if (!up.ok) {
          setErr(j.error || "Upload failed. Please try again.");
          setBusy(false);
          return;
        }
        const id = j.document?.id;
        const proc = await fetch("/api/documents/process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ document_id: id }),
        });
        const pj = await proc.json().catch(() => ({}));
        if (pj?.skipped) {
          setErr(
            pj.reason === "llm_key_missing"
              ? "The AI pipeline is not configured for this environment."
              : "Processing is unavailable right now."
          );
          setBusy(false);
          return;
        }
        setDoc({ id, status: "queued" });
      } catch {
        setErr("Something went wrong. Please try again.");
      }
      setBusy(false);
    },
    [dealId, busy]
  );

  const failed = !!doc && isFailed(doc.status);
  const processing = !!doc && !failed;

  return (
    <>
      <PageHeader
        title="Upload RFP"
        sub="Upload the questionnaire you need answered. Klovered extracts each requirement and drafts a grounded response."
      />

      {processing && (
        <SectionCard
          title="Processing your RFP"
          subtitle="This usually takes a couple of minutes. You can keep this tab open."
        >
          <div className="rfp-phases" role="status" aria-live="polite">
            {PHASES.map((p, i) => {
              const idx = phaseIndex(doc!.status);
              const state = i < idx ? "done" : i === idx ? "active" : "upcoming";
              return (
                <div key={p.label} className={`rfp-phase is-${state}`}>
                  <span className={`rfp-dot ${state}`} aria-hidden="true" />
                  <span className="rfp-phase-label">{p.label}</span>
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}

      {failed && (
        <SectionCard title="Processing did not finish">
          <div className="rfp-error" role="alert" style={{ margin: 16 }}>
            {doc?.error || "The RFP could not be processed. Please try a different file."}
          </div>
        </SectionCard>
      )}

      {!doc && (
        <>
          <div
            className={`rfp-drop${dragging ? " dragging" : ""}`}
            role="button"
            tabIndex={0}
            aria-disabled={busy}
            aria-label="Upload an RFP file"
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              handleFile(e.dataTransfer.files?.[0] ?? null);
            }}
            onClick={() => !busy && inputRef.current?.click()}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !busy) {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.docx"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            />
            <div className="rfp-drop-title">{busy ? "Uploading your RFP" : "Drop your RFP here"}</div>
            <div className="rfp-drop-sub">
              {busy ? (
                "One moment."
              ) : (
                <>
                  or <span style={{ color: "var(--accent)", textDecoration: "underline" }}>browse</span> to choose a file
                </>
              )}
            </div>
            <div className="rfp-drop-hint">pdf or docx, up to 50 mb, one per session</div>
          </div>
          {err && (
            <div className="rfp-error" role="alert">
              {err}
            </div>
          )}
        </>
      )}
    </>
  );
}
