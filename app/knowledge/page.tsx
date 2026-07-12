"use client";
import PublicShell, { useSession } from "@/components/PublicShell";
import KnowledgeView from "@/components/KnowledgeView";

// Step 1. Body is the ported product KnowledgeView (upload → progress → docs table).
export default function KnowledgePage() {
  return (
    <PublicShell step={1}>
      <Inner />
    </PublicShell>
  );
}

function Inner() {
  const { ready } = useSession();
  if (!ready) return <div className="text-sm" style={{ color: "var(--fg-4)" }}>Preparing your private session…</div>;
  return <KnowledgeView initial={[]} />;
}
