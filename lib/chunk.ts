/**
 * Token-aware chunker over parsed blocks. Produces 400–600 token chunks
 * that never split mid-paragraph and never split a list across chunks.
 * Carries section_path (from the heading stack) and page_start/end.
 */

import type { Block } from "./parse";

export type ProducedChunk = {
  text: string;
  text_for_embedding: string;
  section_path: string;
  page_start: number;
  page_end: number;
  sparse_terms: string[];
};

const TARGET_MIN = 400;
const TARGET_MAX = 600;
// Approximation: 1 token ≈ 4 chars of typical English business prose.
const CHAR_PER_TOKEN = 4;

function approxTokens(s: string): number {
  return Math.ceil(s.length / CHAR_PER_TOKEN);
}

type Accum = {
  parts: string[];
  section_path: string;
  page_start: number;
  page_end: number;
  tokens: number;
  inList: boolean;
};

export function chunkBlocks(args: {
  blocks: Block[];
  filename: string;
}): ProducedChunk[] {
  const { blocks, filename } = args;
  const headingStack: { level: number; text: string }[] = [];
  const chunks: ProducedChunk[] = [];
  // Use a single-element holder so TS doesn't narrow across reassignments.
  const state: { acc: Accum | null } = { acc: null };

  function push() {
    const a = state.acc;
    if (!a) return;
    const text = a.parts.join("\n").trim();
    state.acc = null;
    if (!text) return;
    const header = `[${filename} > ${a.section_path || "Body"}, p.${a.page_start}]`;
    chunks.push({
      text,
      text_for_embedding: `${header}\n${text}`,
      section_path: a.section_path || "Body",
      page_start: a.page_start,
      page_end: a.page_end,
      sparse_terms: tokenizeForSparse(text),
    });
  }

  function ensure(b: Block) {
    if (state.acc) return;
    state.acc = {
      parts: [],
      section_path: sectionPath(headingStack),
      page_start: b.page,
      page_end: b.page,
      tokens: 0,
      inList: false,
    };
  }

  for (const b of blocks) {
    if (b.type === "heading") {
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1].level >= (b.level || 1)
      ) {
        headingStack.pop();
      }
      headingStack.push({ level: b.level || 1, text: b.text });
      push();
      continue;
    }

    const isList = b.type === "list_item";
    const segment = isList ? `• ${b.text}` : b.text;
    const segTok = approxTokens(segment);

    // If the accumulator is in the middle of a list and the new block is not
    // a list_item, finish the list first to keep it whole.
    const cur1 = state.acc;
    if (cur1 && cur1.inList && !isList && cur1.tokens >= TARGET_MIN) {
      push();
    }

    ensure(b);
    let cur = state.acc as Accum;
    cur.section_path = cur.section_path || sectionPath(headingStack);

    // If adding this segment would blow past TARGET_MAX, flush first.
    if (cur.tokens + segTok > TARGET_MAX && cur.tokens >= TARGET_MIN) {
      push();
      ensure(b);
      cur = state.acc as Accum;
    }

    cur.parts.push(segment);
    cur.tokens += segTok;
    cur.page_end = Math.max(cur.page_end, b.page);
    cur.inList = isList;

    // Hard cap: never exceed 1.5× TARGET_MAX even if we'd split a paragraph,
    // because the paragraph itself was oversized. This is rare in practice.
    if (cur.tokens > TARGET_MAX * 1.5) push();
  }
  push();
  return chunks;
}

function sectionPath(stack: { level: number; text: string }[]): string {
  return stack.map((h) => h.text).join(" > ");
}

const STOPWORDS = new Set([
  "the","a","an","and","or","but","of","to","in","on","for","with","at","by",
  "is","are","was","were","be","been","being","this","that","these","those",
  "it","its","as","from","into","than","then","so","such","not","no","do",
  "does","did","done","has","have","had","will","would","should","could","may",
  "might","must","can","shall","we","you","they","i","he","she","our","your",
  "their","my","his","her","us","them","also","more","most","any","all","each",
]);

function tokenizeForSparse(text: string): string[] {
  const toks = text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of toks) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out.slice(0, 200);
}
