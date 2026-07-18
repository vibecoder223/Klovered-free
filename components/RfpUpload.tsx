"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "./PublicShell";
import { api } from "@/lib/api";

// Real processing_status values, verified against lib/jobs.ts (deriveDocStatus)
// and lib/agents.ts (setStatus) — NOT the brief's guessed stage names:
//   uploaded -> queued -> extracting -> analyzing -> structured -> completed
//   failures: failed / extraction_failed / generation_failed
type Phase = { label: string; match: string[]; sub: string };
const PHASES: Phase[] = [
  { label: "Queued", match: ["uploaded", "queued"], sub: "waiting" },
  { label: "Reading your RFP", match: ["extracting"], sub: "parsing pages" },
  { label: "Extracting requirements", match: ["analyzing"], sub: "structuring" },
  { label: "Drafting answers", match: ["structured"], sub: "matching knowledge" },
  { label: "Done", match: ["completed"], sub: "complete" },
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
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [doc, setDoc] = useState<{ id: string; status: string; error?: string | null } | null>(null);
  const [rfpFile, setRfpFile] = useState<{ name: string; size: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [daily, setDaily] = useState<{ used: number; cap: number } | null>(null);

  // Show remaining RFP quota for the day (advisory; the backend enforces it).
  useEffect(() => {
    let cancelled = false;
    api
      .limits()
      .then((l) => {
        if (!cancelled) setDaily(l.rfp);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Resume: if this session already has a processed RFP, jump to answers.
  useEffect(() => {
    if (!dealId) return;
    let cancelled = false;
    api
      .dealAnswers(dealId)
      .then(({ questions }: { questions?: unknown[] }) => {
        if (!cancelled && questions?.length) router.push("/answers");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dealId, router]);

  // Poll processing status until a terminal state, then advance to answers.
  useEffect(() => {
    if (!doc || doc.status === "completed" || isFailed(doc.status)) return;
    const t = setInterval(async () => {
      try {
        const document: { id: string; processing_status: string; error_message?: string | null } =
          await api.documentStatus(doc.id);
        setDoc({ id: document.id, status: document.processing_status, error: document.error_message });
        if (document.processing_status === "completed") router.push("/answers");
      } catch {
        /* transient network error, keep polling */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [doc, router]);

  const handleFile = useCallback(
    async (f: File | null) => {
      if (!f || !dealId || busy) return;
      setErr(null);
      setBusy(true);
      setRfpFile({ name: f.name, size: f.size });
      try {
        const fd = new FormData();
        fd.append("file", f);
        fd.append("deal_id", dealId);
        const up = await api.fetch("/api/pipeline/documents/upload", { method: "POST", body: fd });
        const j = await up.json().catch(() => ({}));
        if (!up.ok) {
          setErr(j.error || "Upload failed. Please try again.");
          setBusy(false);
          setRfpFile(null);
          return;
        }
        const id = j.document?.id;
        // The backend's process route takes document_id as a form field.
        const pfd = new FormData();
        pfd.append("document_id", id);
        const proc = await api.fetch("/api/pipeline/documents/process", { method: "POST", body: pfd });
        const pj = await proc.json().catch(() => ({}));
        if (pj?.skipped) {
          setErr(
            pj.reason === "llm_key_missing"
              ? "The AI pipeline is not configured for this environment."
              : "Processing is unavailable right now."
          );
          setBusy(false);
          setRfpFile(null);
          return;
        }
        setDoc({ id, status: "queued" });
      } catch {
        setErr("Something went wrong. Please try again.");
        setRfpFile(null);
      }
      setBusy(false);
    },
    [dealId, busy]
  );

  const failed = !!doc && isFailed(doc.status);
  const processing = !!doc && !failed;
  const idx = doc ? phaseIndex(doc.status) : 0;
  const pct = Math.max(6, Math.round((idx / (PHASES.length - 1)) * 100));

  return (
    <div className="kf-page">
      <div className="kf-head">
        <h1>{processing ? "Reading your RFP" : "Upload your RFP"}</h1>
        <p>
          {processing
            ? "Every requirement is being extracted and structured, including the ones buried in appendices. This usually takes a couple of minutes."
            : "Upload the questionnaire you need answered. Klovered extracts each requirement and drafts a grounded response from your knowledge."}
        </p>
      </div>

      {/* Idle: dropzone */}
      {!doc && (
        <>
          <div
            className={`kf-drop${dragging ? " dragging" : ""}`}
            role="button"
            tabIndex={0}
            aria-disabled={busy}
            aria-label="Upload an RFP file"
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
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
            <div className="kf-up"><UploadIcon /></div>
            <div className="kf-t">{busy ? "Uploading your RFP" : "Drop your RFP here"}</div>
            <div className="kf-s">
              {busy ? "One moment." : <>or <b>browse</b> to choose a file</>}
            </div>
            <div className="kf-fmt">
              pdf or docx, up to 50 MB, one per session
              {daily && (
                <> · <b>{Math.max(0, daily.cap - daily.used)} of {daily.cap}</b> RFP uploads left this week</>
              )}
            </div>
          </div>
          {err && (
            <div className="kf-gap-note" role="alert" style={{ marginTop: 14 }}>
              <WarnIcon />
              <span>{err}</span>
            </div>
          )}
        </>
      )}

      {/* Processing: file + meter + phase list */}
      {processing && (
        <div className="kf-card">
          <div className="kf-rfp-file">
            <span className="kf-fic"><FileIcon color="var(--accent-3)" /></span>
            <div className="kf-fn" style={{ flex: 1, minWidth: 0 }}>
              <div className="kf-nm">{rfpFile?.name ?? "Your RFP"}</div>
              {rfpFile && <div className="kf-meta">{formatSize(rfpFile.size)}</div>}
            </div>
            <span className="kf-badge warn"><span className="kf-d" />Extracting</span>
          </div>
          <div className="kf-meter" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Extraction progress">
            <div className="kf-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="kf-phase-list" role="status" aria-live="polite">
            {PHASES.map((p, i) => {
              const state = i < idx ? "done" : i === idx ? "run" : "";
              return (
                <div key={p.label} className={`kf-phase ${state}`}>
                  <span className="kf-ic">
                    {state === "done" ? <CheckIcon /> : state === "run" ? <span className="kf-spin" /> : null}
                  </span>
                  {p.label}
                  <span className="kf-sub">{i < idx ? "done" : i === idx ? p.sub : "waiting"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Failed */}
      {failed && (
        <div className="kf-card">
          <div className="kf-gap-note" role="alert" style={{ margin: 16, marginTop: 16 }}>
            <WarnIcon />
            <span>{doc?.error || "The RFP could not be processed. Please try a different file."}</span>
          </div>
        </div>
      )}

      {/* Footer */}
      {processing && (
        <div className="kf-foot">
          <span className="kf-hint">Safe to leave this tab open in the background. We will keep going.</span>
          <button className="btn btn-primary btn-lg" disabled>Continue to answers</button>
        </div>
      )}
    </div>
  );
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function formatSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/* ── icons ────────────────────────────────────────────────────────────────── */

function UploadIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 16V4M12 4L7 9M12 4l5 5" stroke="var(--accent-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2" stroke="var(--accent-2)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function FileIcon({ color = "currentColor" }: { color?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14 3H7a1 1 0 00-1 1v16a1 1 0 001 1h10a1 1 0 001-1V8l-4-5z" stroke={color} strokeWidth="1.7" />
      <path d="M14 3v5h4" stroke={color} strokeWidth="1.7" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12l4 4 10-10" stroke="var(--accent-3)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flex: "none", marginTop: 1 }} aria-hidden="true">
      <path d="M12 3L2.5 20h19L12 3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12 10v4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="17.2" r="1" fill="currentColor" />
    </svg>
  );
}
