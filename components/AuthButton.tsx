"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { ACTIVE_DEAL_KEY } from "@/lib/use-session";
import AuthModal from "./AuthModal";

// Header auth control.
//  • Anonymous guest → a button that opens the sign-in / sign-up modal.
//  • Permanent account → the email shown as a "saved" badge that opens a small
//    menu with Sign out. Signing out drops the permanent session; on reload the
//    app bootstraps a fresh anonymous guest (see useGuestSession), so the tool
//    stays usable without an account.
export default function AuthButton() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [anon, setAnon] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"signup" | "signin">("signup");
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Deep-link support: the marketing site's "Sign in" / "Start free trial"
  // CTAs point here with ?auth=signin / ?auth=signup so a visitor lands
  // straight in the right tab of the modal instead of on a bare tool screen.
  // The param is stripped right after so back/reload doesn't reopen it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const auth = params.get("auth");
    if (auth === "signin" || auth === "signup") {
      setModalMode(auth);
      setModalOpen(true);
      params.delete("auth");
      const rest = params.toString();
      window.history.replaceState(
        null,
        "",
        window.location.pathname + (rest ? `?${rest}` : "")
      );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((s) => {
        if (cancelled) return;
        setEmail(s.email ?? null);
        setAnon(s.is_anonymous);
      })
      .catch(() => {
        // No session yet (bootstrap in flight) — treat as anonymous.
        if (!cancelled) setAnon(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Invite acceptance: someone opened /app/knowledge?invite=<token>.
  //  • Signed in  → join the shared workspace, remember the shared deal, and go
  //    to the answers screen.
  //  • Anonymous  → open the sign-up modal first; the ?invite stays in the URL,
  //    so after they sign in (page reload) this runs again and accepts.
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("invite");
    if (!token) return;
    let cancelled = false;
    (async () => {
      let s;
      try {
        s = await api.me();
      } catch {
        s = null;
      }
      if (cancelled) return;
      if (!s || s.is_anonymous) {
        setModalMode("signup");
        setModalOpen(true);
        return;
      }
      try {
        const { deal_id } = await api.acceptInvite(token);
        if (deal_id) {
          try {
            sessionStorage.setItem(ACTIVE_DEAL_KEY, deal_id);
          } catch {
            /* sessionStorage blocked — the answers screen still works via its own deal */
          }
        }
        const params = new URLSearchParams(window.location.search);
        params.delete("invite");
        const rest = params.toString();
        window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
        router.push("/answers");
      } catch {
        // invalid / expired / full — strip the param so it doesn't retry forever
        const params = new URLSearchParams(window.location.search);
        params.delete("invite");
        const rest = params.toString();
        window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

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
    try {
      await api.logout();
    } catch {
      // Even if the call fails, reload — the cookie is httpOnly and the next
      // bootstrap will re-establish a guest session either way.
    }
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
      <button
        className="btn pub-signin"
        onClick={() => {
          setModalMode("signup");
          setModalOpen(true);
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
          <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
        </svg>
        Sign in to keep your work
      </button>
      {modalOpen && (
        <AuthModal initialMode={modalMode} onClose={() => setModalOpen(false)} />
      )}
    </>
  );
}
