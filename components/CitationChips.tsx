"use client";

// Grounding sources for a drafted answer. The /api/answers shape gives us
// denormalized citations: { chunk_id, filename, page_start }. Rendered as quiet
// pill chips (design tokens, no monospace, sentence case) below each answer.
export type Citation = {
  chunk_id: string;
  filename: string | null;
  page_start: number | null;
};

export default function CitationChips({ citations }: { citations: Citation[] }) {
  if (!citations || citations.length === 0) return null;
  return (
    <div className="cite-row">
      <span className="cite-label">Sources</span>
      {citations.map((c, i) => (
        <span key={c.chunk_id || i} className="cite-chip">
          {c.filename ?? "source"}
          {c.page_start != null && <span className="cite-page">p.{c.page_start}</span>}
        </span>
      ))}
    </div>
  );
}
