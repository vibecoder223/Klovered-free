"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useSession } from "./PublicShell";

type KDoc = {
  id: string;
  filename: string;
  doc_type: string;
  ingestion_status: string;
  page_count: number | null;
  file_size: number | null;
  created_at: string;
  error_message: string | null;
  is_sample?: boolean;
};

const DOC_TYPES: Array<{ value: string; label: string }> = [
  { value: "past_proposal", label: "Past proposal" },
  { value: "security_doc",  label: "Security" },
  { value: "policy",        label: "Policy" },
  { value: "other",         label: "Other" },
];

// The knowledge ingestion pipeline, in the order the backend runs it. Labels
// match the draft's inline tracker; STAGE_TO_STEP maps a live `stage` value to
// an index here.
const PIPE = ["Upload", "Fetch", "Parse", "Chunk", "Embed", "Index", "Ready"];
const STAGE_TO_STEP: Record<string, number> = {
  uploading: 0, downloading: 1, parsing: 2, chunking: 3, embedding: 4, storing: 5, ready: 6,
};
const STEP_COUNT = PIPE.length;

// Which ingestion states read as "still working" (warn badge + processing).
const PROCESSING_STATES = new Set([
  "pending", "uploading", "downloading", "parsing", "chunking", "embedding", "storing",
]);

// Free-tier upload quota: 3 per calendar week, matching the backend
// WEEKLY_UPLOAD_CAP. Used for both the dropzone hint and the documents counter.
const FREE_TIER_CAP = 3;

export default function KnowledgeView({ initial }: { initial: KDoc[] }) {
  const { isAnonymous } = useSession();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [items, setItems] = useState<KDoc[]>(initial);
  const [loaded, setLoaded] = useState(false);
  const [daily, setDaily] = useState<{ used: number; cap: number } | null>(null);
  const [docType, setDocType] = useState("past_proposal");
  const [dragging, setDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [currentFile, setCurrentFile] = useState<string>("");
  const [stepIdx, setStepIdx] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const readyCount = items.filter((d) => d.ingestion_status === "ready").length;

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);
  useEffect(() => () => stopPolling(), [stopPolling]);

  function pollDoc(id: string): Promise<void> {
    return new Promise((resolve) => {
      pollRef.current = setInterval(async () => {
        try {
          const res = await api.fetch(`/api/knowledge/${id}`);
          if (!res.ok) return;
          const doc = await res.json();
          if (doc.stage) setStepIdx(STAGE_TO_STEP[doc.stage] ?? stepIdx);
          if (doc.ingestion_status === "ready") {
            setStepIdx(STEP_COUNT - 1); stopPolling(); resolve();
          } else if (doc.ingestion_status === "failed") {
            stopPolling(); setErr(doc.error_message || "Ingestion failed"); resolve();
          }
        } catch { /* transient */ }
      }, 1200);
    });
  }

  async function refreshList() {
    const r = await api.fetch("/api/knowledge");
    if (r.ok) setItems((await r.json()).knowledge_documents ?? []);
    try {
      const lim = await api.limits();
      setDaily(lim.knowledge);
    } catch {
      // limits are advisory — a failure here shouldn't block the list
    }
    setLoaded(true);
  }

  useEffect(() => {
    refreshList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setErr(null);
    setProcessing(true);
    for (const file of Array.from(files)) {
      setCurrentFile(file.name);
      setStepIdx(0);
      const fd = new FormData();
      fd.append("file", file);
      fd.append("doc_type", docType);
      const res = await api.fetch("/api/knowledge/upload", { method: "POST", body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(json.error || `Failed to upload ${file.name}`); continue; }
      const docId = json.knowledge_document?.id;
      if (docId) await pollDoc(docId);
    }
    setProcessing(false);
    setCurrentFile("");
    await refreshList();
  }

  async function remove(id: string) {
    if (!confirm("Delete this document and its chunks?")) return;
    const res = await api.fetch(`/api/knowledge/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "Failed" }));
      setErr(error || "Delete failed");
      return;
    }
    setItems((xs) => xs.filter((x) => x.id !== id));
  }

  const canContinue = readyCount > 0;

  return (
    <div className="kf-page">
      <div className="kf-head">
        <h1>Add your knowledge</h1>
        <p>
          Upload past proposals, product docs, and security policies. Answers will be
          drafted from these files only, with citations.
        </p>
      </div>

      {/* Dropzone */}
      <div
        className={`kf-drop${dragging ? " dragging" : ""}`}
        role="button"
        tabIndex={0}
        aria-label="Upload knowledge documents"
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
        onClick={() => !processing && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !processing) {
            e.preventDefault(); inputRef.current?.click();
          }
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.txt"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        <div className="kf-up"><UploadIcon /></div>
        <div className="kf-t">Drop files to add knowledge</div>
        <div className="kf-s">or <b>browse</b> your computer</div>
        <div className="kf-fmt">
          pdf, docx and txt, up to 50 MB each
          {daily ? (
            <> · <b>{Math.max(0, daily.cap - daily.used)} of {daily.cap}</b> uploads left this week</>
          ) : (
            <> · <b>{FREE_TIER_CAP} uploads per week</b> on the free tier</>
          )}
        </div>
      </div>

      {/* Add-as segmented control */}
      <div className="kf-addas">
        <span className="kf-lbl" id="kf-addas-l">Add as</span>
        <div className="kf-seg" role="group" aria-labelledby="kf-addas-l">
          {DOC_TYPES.map((t) => (
            <button
              key={t.value}
              className={docType === t.value ? "on" : ""}
              aria-pressed={docType === t.value}
              onClick={() => setDocType(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <div className="kf-gap-note" role="alert" style={{ marginTop: 14 }}>
          <WarnIcon />
          <span>{err}</span>
        </div>
      )}

      {/* Documents card */}
      <div className="kf-card kf-mt">
        <div className="kf-card-head">
          <span className="kf-ttl">
            Your documents <span className="kf-cnt">{items.length} of {FREE_TIER_CAP}</span>
          </span>
          {readyCount > 0 && <span className="kf-act">{readyCount} ready</span>}
        </div>

        {items.length === 0 && !processing ? (
          <div style={{ padding: "28px 16px", textAlign: "center", fontSize: 12.5, color: "var(--fg-4)" }}>
            {loaded
              ? "No documents yet. Drop a past proposal, security policy, or product doc above to get started."
              : "Loading your documents…"}
          </div>
        ) : (
          <>
            {items.map((d) => {
              const st = d.ingestion_status;
              const tone = st === "ready" ? "ok" : st === "failed" ? "err" : PROCESSING_STATES.has(st) ? "warn" : "dim";
              const label = st === "ready" ? "Ready" : st === "failed" ? "Failed" : PROCESSING_STATES.has(st) ? "Processing" : st;
              return (
                <div className="kf-doc" key={d.id}>
                  <span className="kf-fic"><FileIcon /></span>
                  <div className="kf-fn">
                    <div className="kf-nm">{d.filename}</div>
                    <div className="kf-meta">
                      {docMeta(d)}
                      {d.error_message && st === "failed" ? ` · ${d.error_message}` : ""}
                    </div>
                  </div>
                  <span className={`kf-badge ${tone}`}><span className="kf-d" />{label}</span>
                  <button className="kf-x" aria-label={`Remove ${d.filename}`} onClick={() => remove(d.id)}>
                    <XIcon />
                  </button>
                </div>
              );
            })}

            {/* Live pipeline for the file currently ingesting */}
            {processing && currentFile && (
              <>
                <div className="kf-doc">
                  <span className="kf-fic"><FileIcon /></span>
                  <div className="kf-fn">
                    <div className="kf-nm">{currentFile}</div>
                    <div className="kf-meta">Processing · step {Math.min(stepIdx + 1, STEP_COUNT)} of {STEP_COUNT}</div>
                  </div>
                  <span className="kf-badge warn"><span className="kf-d" />Processing</span>
                </div>
                <div className="kf-pipe" aria-label={`Processing ${currentFile}`}>
                  <div className="kf-pipe-steps">
                    {PIPE.map((label, i) => {
                      const state = i < stepIdx ? "done" : i === stepIdx ? "run" : "";
                      return (
                        <div key={label} style={{ display: "contents" }}>
                          {i > 0 && <span className={`kf-ps-line${i <= stepIdx ? " fill" : ""}`} />}
                          <span className={`kf-ps ${state}`}>
                            <span className="kf-pd">
                              {state === "done" ? <CheckIcon size={8} /> : state === "run" ? <span className="kf-spin" /> : null}
                            </span>
                            <span className="kf-pl">{label}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* Step footer */}
      <div className="kf-foot">
        <span className="kf-hint">
          You can add more later. {canContinue ? "Two ready documents is enough to start." : "Add at least one document to continue."}
        </span>
        <Link
          href="/rfp"
          className="btn btn-primary btn-lg"
          aria-disabled={!canContinue}
          onClick={(e) => { if (!canContinue) e.preventDefault(); }}
          style={canContinue ? undefined : { opacity: 0.5, pointerEvents: "none" }}
        >
          Continue to RFP
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      </div>

      {/* Keep-it notice — guests only; a signed-in account's uploads persist. */}
      {isAnonymous && (
        <div className="kf-keep">
          <div className="kf-kt">
            <span className="kf-clock"><ClockIcon /></span>
            <span>Everything you upload <b>auto-deletes in 48 hours</b>. Sign in with Google to keep it.</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function docMeta(d: KDoc): string {
  const parts: string[] = [];
  if (d.file_size) parts.push(formatSize(d.file_size));
  if (d.page_count) parts.push(`${d.page_count} pages`);
  return parts.length ? parts.join(", ") : "—";
}

function formatSize(bytes: number): string {
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

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14 3H7a1 1 0 00-1 1v16a1 1 0 001 1h10a1 1 0 001-1V8l-4-5z" stroke="currentColor" strokeWidth="1.7" />
      <path d="M14 3v5h4" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon({ size = 9 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12l4 4 10-10" stroke="var(--accent-3)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 7v5l3 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
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
