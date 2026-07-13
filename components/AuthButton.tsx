"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import AuthModal from "./AuthModal";

// Header auth control.
//  • Anonymous guest → a button that opens the sign-in / sign-up modal.
//  • Permanent account → the email shown as a "saved" badge that opens a small
//    menu with Sign out. Signing out drops the permanent session; on reload the
//    app bootstraps a fresh anonymous guest (see useGuestSession), so the tool
//    stays usable without an account.
export default function AuthButton() {
  const [email, setEmail] = useState<string | null>(null);
  const [anon, setAnon] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data: { session } }) => {
      setEmail(session?.user?.email ?? null);
      setAnon(session?.user?.is_anonymous ?? true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setEmail(session?.user?.email ?? null);
      setAnon(session?.user?.is_anonymous ?? true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Close the account menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    // Reload so useGuestSession provisions a fresh anonymous session on the
    // same page — the visitor keeps using the tool, just no longer signed in.
    window.location.reload();
  }

  if (!anon && email) {
    return (
      <div className="pub-account" ref={menuRef}>
        <button
          className="pub-saved pub-saved-btn"
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={`Signed in as ${email}`}
        >
          <span className="pub-saved-dot" aria-hidden="true" />
          <span className="pub-saved-email">{email}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" className="pub-saved-caret">
            <path fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {menuOpen && (
          <div className="pub-menu" role="menu">
            <div className="pub-menu-head">
              <span className="pub-menu-label">Signed in as</span>
              <span className="pub-menu-email">{email}</span>
            </div>
            <button className="pub-menu-item" role="menuitem" onClick={signOut} disabled={signingOut}>
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <button className="btn pub-signin" onClick={() => setModalOpen(true)}>
        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
          <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
        </svg>
        Sign in to keep your work
      </button>
      {modalOpen && <AuthModal onClose={() => setModalOpen(false)} />}
    </>
  );
}
