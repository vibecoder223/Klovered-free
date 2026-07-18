"use client";

import { useState } from "react";
import { api } from "@/lib/api";

// Header "Invite" control, shown to signed-in users on every step (not just the
// answers screen). Mints a single-use link for the workspace and copies it.
export default function InviteButton() {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function invite() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setCopied(false);
    try {
      const { token } = await api.createInvite();
      const link = `${window.location.origin}/app/knowledge?invite=${token}`;
      try {
        await navigator.clipboard.writeText(link);
        setCopied(true);
        setTimeout(() => setCopied(false), 2600);
      } catch {
        window.prompt("Copy this single-use invite link — share it with one teammate:", link);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create an invite.");
    }
    setBusy(false);
  }

  return (
    <button
      className="btn pub-invite"
      onClick={invite}
      disabled={busy}
      title={err ?? "Invite one teammate to view and edit with you"}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.8" />
        <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M19 8v6M22 11h-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      {busy ? "Creating…" : copied ? "Link copied ✓" : err ? "Try again" : "Invite"}
    </button>
  );
}
