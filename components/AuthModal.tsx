"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";

// Auth modal for upgrading the anonymous guest to a permanent account. Two
// paths, both of which keep the visitor on the current page:
//
//  • Google  — linkIdentity() attaches a Google identity to the SAME auth.users
//    row, so the org + all uploaded data carry over untouched. This leg does a
//    full OAuth round-trip; we send `next` = the current path so the callback
//    returns here rather than to a fixed page.
//  • Email / password
//      – Sign up: updateUser({ email, password }) converts the current anon
//        user in place (same id → same org → data preserved). If the project
//        requires email confirmation, Supabase sends a verification mail and the
//        upgrade completes when the visitor clicks it.
//      – Sign in: signInWithPassword() logs into an EXISTING account. That
//        replaces the current guest session, so we reload the page to load that
//        account's own data.
type Mode = "signup" | "signin";

export default function AuthModal({
  onClose,
  initialMode = "signup",
}: {
  onClose: () => void;
  initialMode?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const currentPath =
    typeof window !== "undefined"
      ? window.location.pathname + window.location.search
      : "/";

  async function googleSignIn() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const next = encodeURIComponent(currentPath);
    const { error } = await supabase.auth.linkIdentity({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/api/auth/callback?next=${next}` },
    });
    if (error) {
      setError(error.message);
      setBusy(false);
    }
    // On success the browser is redirected to Google; nothing more to do here.
  }

  async function emailSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);

    if (!email.trim() || !password) {
      setError("Enter your email and a password.");
      return;
    }
    if (mode === "signup" && password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setBusy(true);
    const supabase = createClient();

    if (mode === "signup") {
      // Convert the anonymous guest in place — keeps the same org + data.
      const { data, error } = await supabase.auth.updateUser({
        email: email.trim(),
        password,
      });
      if (error) {
        setError(error.message);
        setBusy(false);
        return;
      }
      // If the project requires email confirmation, the address lands in
      // new_email until the link is clicked; otherwise it's live immediately.
      const confirmed = data.user?.email === email.trim() && !data.user?.new_email;
      if (confirmed) {
        window.location.reload();
      } else {
        setNotice(
          `Almost there — we sent a confirmation link to ${email.trim()}. Click it to finish securing your account. Your work stays here in the meantime.`
        );
        setBusy(false);
      }
      return;
    }

    // Sign in to an existing account — replaces the current guest session.
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    window.location.reload();
  }

  return (
    <div className="auth-overlay" role="dialog" aria-modal="true" aria-label="Sign in" onClick={onClose}>
      <div className="auth-modal" onClick={(e) => e.stopPropagation()}>
        <button className="auth-close" onClick={onClose} aria-label="Close">
          ×
        </button>

        <h2 className="auth-title">
          {mode === "signup" ? "Keep your work" : "Welcome back"}
        </h2>
        <p className="auth-sub">
          {mode === "signup"
            ? "Create an account so your documents and answers don't disappear after 48 hours."
            : "Sign in to your existing account."}
        </p>

        <button className="auth-google" onClick={googleSignIn} disabled={busy}>
          <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
          </svg>
          Continue with Google
        </button>

        <div className="auth-divider"><span>or</span></div>

        <form onSubmit={emailSubmit} className="auth-form">
          <label className="auth-field">
            <span>Email</span>
            <input
              ref={emailRef}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </label>
          <label className="auth-field">
            <span>Password</span>
            <input
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "signup" ? "At least 8 characters" : "Your password"}
            />
          </label>

          {error && <p className="auth-error">{error}</p>}
          {notice && <p className="auth-notice">{notice}</p>}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy
              ? "Working…"
              : mode === "signup"
              ? "Create account"
              : "Sign in"}
          </button>
        </form>

        <p className="auth-switch">
          {mode === "signup" ? (
            <>
              Already have an account?{" "}
              <button type="button" onClick={() => { setMode("signin"); setError(null); setNotice(null); }}>
                Sign in
              </button>
            </>
          ) : (
            <>
              New here?{" "}
              <button type="button" onClick={() => { setMode("signup"); setError(null); setNotice(null); }}>
                Create an account
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
