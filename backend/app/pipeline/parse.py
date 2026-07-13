"""Page-aware document parsing. Returns a sequence of typed blocks with page
numbers. PDF uses PyMuPDF; DOCX uses mammoth with style hints; TXT is treated
as one page.

Python port of ``lib/parse.ts``. Kept behavior-compatible so downstream
pipeline code can be ported incrementally.
"""

from __future__ import annotations

import base64
import io
import os
import re
from dataclasses import dataclass, field

import httpx

from app.config import get_settings

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------


@dataclass
class Block:
    type: str  # "heading" | "paragraph" | "list_item" | "table"
    text: str
    page: int
    level: int | None = None


@dataclass
class ParsedDoc:
    blocks: list[Block] = field(default_factory=list)
    page_count: int = 1
    raw_text: str = ""


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def parse_document(data: bytes, mime: str | None, filename: str) -> ParsedDoc:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if mime == "application/pdf" or ext == "pdf":
        return _parse_pdf_robust(data)
    if (
        mime
        == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        or ext == "docx"
    ):
        return _parse_docx(data)
    if mime == "text/plain" or ext == "txt":
        return _parse_txt(data)
    raise ValueError(f"Unsupported file type for parsing: {mime or ext}")


# Minimum extracted characters per page below which we treat a PDF as scanned
# (image-only) and escalate to OCR.
SCANNED_CHARS_PER_PAGE = 80

_WS_RE = re.compile(r"\s+")
_LIST_RE = re.compile(r"^\s*(?:[-•●◦*]|\d+[.)]|[a-z][.)])\s+")
_MD_LIST_RE = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+")
_MD_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")


def _parse_pdf_robust(data: bytes) -> ParsedDoc:
    text_parsed: ParsedDoc | None = None
    text_err: str | None = None
    try:
        text_parsed = _parse_pdf(data)
    except Exception as e:  # noqa: BLE001 - mirror TS catch-all
        text_err = str(e)

    chars = (
        len(re.sub(r"\s", "", text_parsed.raw_text)) if text_parsed is not None else 0
    )
    pages = text_parsed.page_count if text_parsed and text_parsed.page_count else 1
    looks_scanned = text_parsed is None or chars < SCANNED_CHARS_PER_PAGE * pages

    if not looks_scanned and text_parsed is not None:
        return text_parsed

    if _has_ocr():
        try:
            ocr = _ocr_pdf(data)
            if len(re.sub(r"\s", "", ocr.raw_text)) > 0:
                return ocr
        except Exception as e:  # noqa: BLE001
            text_err = f"OCR fallback failed: {e}"

    if text_parsed is not None and chars > 0:
        return text_parsed

    if text_err:
        raise ValueError(
            f"Could not read this PDF ({text_err}). If it is a scanned document, "
            "set MISTRAL_API_KEY to enable OCR."
        )
    raise ValueError(
        "This PDF appears to be scanned (no text layer) and OCR is not configured. "
        "Set MISTRAL_API_KEY to enable OCR."
    )


def _has_ocr() -> bool:
    return bool(get_settings().llm_key)


# ---------- OCR fallback (Mistral OCR) ----------


def _ocr_pdf(data: bytes) -> ParsedDoc:
    settings = get_settings()
    key = settings.llm_key
    model = os.getenv("MISTRAL_OCR_MODEL", "mistral-ocr-latest")
    data_url = f"data:application/pdf;base64,{base64.b64encode(data).decode()}"

    resp = httpx.post(
        "https://api.mistral.ai/v1/ocr",
        headers={"content-type": "application/json", "authorization": f"Bearer {key}"},
        json={
            "model": model,
            "document": {"type": "document_url", "document_url": data_url},
        },
        timeout=120,
    )
    if resp.status_code >= 400:
        raise ValueError(f"Mistral OCR {resp.status_code}: {resp.text[:200]}")
    j = resp.json()
    pages = j.get("pages") or []

    blocks: list[Block] = []
    raw_parts: list[str] = []
    for i, pg in enumerate(pages):
        page_no = (pg.get("index") if pg.get("index") is not None else i) + 1
        md = pg.get("markdown") or ""
        for line in re.split(r"\n+", md):
            text = _WS_RE.sub(" ", line).strip()
            if not text:
                continue
            raw_parts.append(text)
            h = _MD_HEADING_RE.match(text)
            if h:
                blocks.append(
                    Block(type="heading", text=h.group(2), page=page_no, level=len(h.group(1)))
                )
            elif _MD_LIST_RE.match(text):
                blocks.append(
                    Block(
                        type="list_item",
                        text=_MD_LIST_RE.sub("", text),
                        page=page_no,
                    )
                )
            else:
                blocks.append(Block(type="paragraph", text=text, page=page_no))

    return ParsedDoc(
        blocks=blocks, page_count=len(pages) or 1, raw_text="\n".join(raw_parts)
    )


# ---------- PDF (PyMuPDF, page-aware) ----------


def _parse_pdf(data: bytes) -> ParsedDoc:
    import fitz  # PyMuPDF

    doc = fitz.open(stream=data, filetype="pdf")
    try:
        blocks: list[Block] = []
        raw_parts: list[str] = []

        for p in range(1, doc.page_count + 1):
            page = doc[p - 1]
            page_dict = page.get_text("dict")

            lines: list[dict] = []
            for block in page_dict.get("blocks", []):
                for line in block.get("lines", []):
                    spans = line.get("spans", [])
                    text = "".join(s.get("text", "") for s in spans).strip()
                    if not text:
                        continue
                    height = max((s.get("size", 10) for s in spans), default=10)
                    y = line.get("bbox", [0, 0, 0, 0])[1]
                    lines.append({"y": y, "height": height, "text": text})

            # Sort lines top-to-bottom.
            lines.sort(key=lambda l: l["y"])

            heights = sorted(l["height"] for l in lines)
            median_height = heights[len(heights) // 2] if heights else 10

            buffer = ""

            def flush_paragraph():
                nonlocal buffer
                t = _WS_RE.sub(" ", buffer).strip()
                if t:
                    blocks.append(Block(type="paragraph", text=t, page=p))
                buffer = ""

            for line in lines:
                text = _WS_RE.sub(" ", line["text"]).strip()
                if not text:
                    continue
                raw_parts.append(text)

                is_heading = (
                    line["height"] >= median_height * 1.15
                    and len(text) <= 140
                    and not re.search(r"[.;]$", text)
                )
                if is_heading:
                    flush_paragraph()
                    level = max(
                        1, min(6, 7 - round(line["height"] / median_height))
                    )
                    blocks.append(Block(type="heading", text=text, page=p, level=level))
                    continue

                if _LIST_RE.match(text):
                    flush_paragraph()
                    blocks.append(
                        Block(type="list_item", text=_LIST_RE.sub("", text), page=p)
                    )
                    continue

                buffer = f"{buffer} {text}" if buffer else text
                if re.search(r"[.!?]\s*$", text) and len(buffer) > 60:
                    flush_paragraph()
            flush_paragraph()

        return ParsedDoc(
            blocks=blocks, page_count=doc.page_count, raw_text="\n".join(raw_parts)
        )
    finally:
        doc.close()


# ---------- DOCX (mammoth + style hints) ----------

_DOCX_TAG_RE = re.compile(
    r"<(h([1-6])|p|li)[^>]*>([\s\S]*?)</\1>", re.IGNORECASE
)


def _parse_docx(data: bytes) -> ParsedDoc:
    import mammoth

    result = mammoth.convert_to_html(io.BytesIO(data))
    html = result.value

    blocks: list[Block] = []
    raw_parts: list[str] = []

    for m in _DOCX_TAG_RE.finditer(html):
        tag = m.group(1).lower()
        inner = m.group(3)
        inner = re.sub(r"<[^>]+>", "", inner)
        inner = (
            inner.replace("&nbsp;", " ")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
        )
        inner = _WS_RE.sub(" ", inner).strip()
        if not inner:
            continue
        raw_parts.append(inner)
        if tag.startswith("h"):
            blocks.append(Block(type="heading", text=inner, page=1, level=int(m.group(2))))
        elif tag == "li":
            blocks.append(Block(type="list_item", text=inner, page=1))
        else:
            blocks.append(Block(type="paragraph", text=inner, page=1))

    return ParsedDoc(blocks=blocks, page_count=1, raw_text="\n".join(raw_parts))


# ---------- TXT ----------


def _parse_txt(data: bytes) -> ParsedDoc:
    text = data.decode("utf-8")
    blocks: list[Block] = []
    for part in re.split(r"\n\s*\n+", text):
        t = part.strip()
        if t:
            blocks.append(Block(type="paragraph", text=t, page=1))
    return ParsedDoc(blocks=blocks, page_count=1, raw_text=text)
