"""Token-aware chunker over parsed blocks. Produces 400-600 token chunks
that never split mid-paragraph and never split a list across chunks.
Carries section_path (from the heading stack) and page_start/end.

Python port of ``lib/chunk.ts``. Pure (no I/O); consumes ``app.pipeline.parse.Block``.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

from app.pipeline.parse import Block

TARGET_MIN = 400
TARGET_MAX = 600
# Approximation: 1 token ~= 4 chars of typical English business prose.
CHAR_PER_TOKEN = 4


def _approx_tokens(s: str) -> int:
    return math.ceil(len(s) / CHAR_PER_TOKEN)


@dataclass
class ProducedChunk:
    text: str
    text_for_embedding: str
    section_path: str
    page_start: int
    page_end: int
    sparse_terms: list[str]


@dataclass
class _HeadingEntry:
    level: int
    text: str


@dataclass
class _Accum:
    parts: list[str] = field(default_factory=list)
    section_path: str = ""
    page_start: int = 1
    page_end: int = 1
    tokens: int = 0
    in_list: bool = False


def _section_path(stack: list[_HeadingEntry]) -> str:
    return " > ".join(h.text for h in stack)


STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "at", "by",
    "is", "are", "was", "were", "be", "been", "being", "this", "that", "these", "those",
    "it", "its", "as", "from", "into", "than", "then", "so", "such", "not", "no", "do",
    "does", "did", "done", "has", "have", "had", "will", "would", "should", "could", "may",
    "might", "must", "can", "shall", "we", "you", "they", "i", "he", "she", "our", "your",
    "their", "my", "his", "her", "us", "them", "also", "more", "most", "any", "all", "each",
}

_NON_WORD_RE = re.compile(r"[^a-z0-9\s\-]")


def _tokenize_for_sparse(text: str) -> list[str]:
    lowered = text.lower()
    cleaned = _NON_WORD_RE.sub(" ", lowered)
    toks = [t for t in cleaned.split() if len(t) >= 3 and t not in STOPWORDS]
    seen: set[str] = set()
    out: list[str] = []
    for t in toks:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out[:200]


def chunk_blocks(*, blocks: list[Block], filename: str) -> list[ProducedChunk]:
    heading_stack: list[_HeadingEntry] = []
    chunks: list[ProducedChunk] = []
    # Holder mirroring the TS single-element mutable box.
    acc_holder: dict[str, _Accum | None] = {"acc": None}

    def push() -> None:
        a = acc_holder["acc"]
        if a is None:
            return
        text = "\n".join(a.parts).strip()
        acc_holder["acc"] = None
        if not text:
            return
        section = a.section_path or "Body"
        header = f"[{filename} > {section}, p.{a.page_start}]"
        chunks.append(
            ProducedChunk(
                text=text,
                text_for_embedding=f"{header}\n{text}",
                section_path=section,
                page_start=a.page_start,
                page_end=a.page_end,
                sparse_terms=_tokenize_for_sparse(text),
            )
        )

    def ensure(b: Block) -> None:
        if acc_holder["acc"] is not None:
            return
        acc_holder["acc"] = _Accum(
            parts=[],
            section_path=_section_path(heading_stack),
            page_start=b.page,
            page_end=b.page,
            tokens=0,
            in_list=False,
        )

    for b in blocks:
        if b.type == "heading":
            level = b.level or 1
            while heading_stack and heading_stack[-1].level >= level:
                heading_stack.pop()
            heading_stack.append(_HeadingEntry(level=level, text=b.text))
            push()
            continue

        is_list = b.type == "list_item"
        segment = f"• {b.text}" if is_list else b.text
        seg_tok = _approx_tokens(segment)

        # If the accumulator is in the middle of a list and the new block is
        # not a list_item, finish the list first to keep it whole.
        cur1 = acc_holder["acc"]
        if cur1 is not None and cur1.in_list and not is_list and cur1.tokens >= TARGET_MIN:
            push()

        ensure(b)
        cur = acc_holder["acc"]
        assert cur is not None
        cur.section_path = cur.section_path or _section_path(heading_stack)

        # If adding this segment would blow past TARGET_MAX, flush first.
        if cur.tokens + seg_tok > TARGET_MAX and cur.tokens >= TARGET_MIN:
            push()
            ensure(b)
            cur = acc_holder["acc"]
            assert cur is not None

        cur.parts.append(segment)
        cur.tokens += seg_tok
        cur.page_end = max(cur.page_end, b.page)
        cur.in_list = is_list

        # Hard cap: never exceed 1.5x TARGET_MAX even if we'd split a
        # paragraph, because the paragraph itself was oversized. Rare in practice.
        if cur.tokens > TARGET_MAX * 1.5:
            push()

    push()
    return chunks
