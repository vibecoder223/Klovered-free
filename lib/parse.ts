/**
 * Page-aware document parsing. Returns a sequence of typed blocks with page
 * numbers and detected section paths. PDF uses pdfjs-dist; DOCX uses mammoth
 * with style hints; TXT is treated as one page.
 *
 * The boundary is `parseDocument()` — swapping in a Python `unstructured`
 * sidecar later is a drop-in replacement for this single function.
 */

import mammoth from "mammoth";

export type Block = {
  type: "heading" | "paragraph" | "list_item" | "table";
  text: string;
  page: number;
  /** Heading depth (1..6) when type==='heading'. */
  level?: number;
};

export type ParsedDoc = {
  blocks: Block[];
  page_count: number;
  /** Plain concatenated text — kept for fallback paths. */
  raw_text: string;
};

export async function parseDocument(
  buf: Buffer,
  mime: string | null,
  filename: string
): Promise<ParsedDoc> {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (mime === "application/pdf" || ext === "pdf") return parsePdfRobust(buf);
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    return parseDocx(buf);
  }
  if (mime === "text/plain" || ext === "txt") return parseTxt(buf);
  throw new Error(`Unsupported file type for parsing: ${mime || ext}`);
}

// Minimum extracted characters per page below which we treat a PDF as scanned
// (image-only) and escalate to OCR. A digital PDF yields hundreds+ per page;
// a scanned one yields ~0 from the text layer.
const SCANNED_CHARS_PER_PAGE = 80;

/**
 * PDF entry point with graceful degradation so an upload never hard-fails:
 *   1. Try the fast text-layer parser (pdfjs).
 *   2. If it throws (corrupt/encrypted) OR yields almost no text (scanned),
 *      fall back to Mistral OCR when a key is configured.
 *   3. If OCR is unavailable or also yields nothing, surface a clear,
 *      actionable error instead of a generic crash.
 */
async function parsePdfRobust(buf: Buffer): Promise<ParsedDoc> {
  let textParsed: ParsedDoc | null = null;
  let textErr: string | null = null;
  try {
    textParsed = await parsePdf(buf);
  } catch (e: any) {
    textErr = e?.message ?? String(e);
  }

  const chars = textParsed?.raw_text.replace(/\s/g, "").length ?? 0;
  const pages = textParsed?.page_count || 1;
  const looksScanned = !textParsed || chars < SCANNED_CHARS_PER_PAGE * pages;

  if (!looksScanned && textParsed) return textParsed;

  // Escalate to OCR.
  if (hasOcr()) {
    try {
      const ocr = await ocrPdf(buf);
      if (ocr.raw_text.replace(/\s/g, "").length > 0) return ocr;
    } catch (e: any) {
      // fall through to the error below with OCR context
      textErr = `OCR fallback failed: ${e?.message ?? String(e)}`;
    }
  }

  // If the text layer produced *something* usable, return it rather than fail.
  if (textParsed && chars > 0) return textParsed;

  throw new Error(
    textErr
      ? `Could not read this PDF (${textErr}). If it is a scanned document, set MISTRAL_API_KEY to enable OCR.`
      : "This PDF appears to be scanned (no text layer) and OCR is not configured. Set MISTRAL_API_KEY to enable OCR."
  );
}

function hasOcr(): boolean {
  return Boolean(process.env.MISTRAL_API_KEY || process.env.LLM_API_KEY);
}

// ---------- OCR fallback (Mistral OCR) ----------

async function ocrPdf(buf: Buffer): Promise<ParsedDoc> {
  const key = process.env.MISTRAL_API_KEY || process.env.LLM_API_KEY!;
  const model = process.env.MISTRAL_OCR_MODEL || "mistral-ocr-latest";
  const dataUrl = `data:application/pdf;base64,${buf.toString("base64")}`;

  const res = await fetch("https://api.mistral.ai/v1/ocr", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      document: { type: "document_url", document_url: dataUrl },
    }),
  });
  if (!res.ok) {
    throw new Error(`Mistral OCR ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const j = (await res.json()) as { pages?: { index?: number; markdown?: string }[] };
  const pages = j.pages ?? [];

  const blocks: Block[] = [];
  const rawParts: string[] = [];
  pages.forEach((pg, i) => {
    const pageNo = (pg.index ?? i) + 1;
    const md = pg.markdown ?? "";
    for (const line of md.split(/\n+/)) {
      const text = line.replace(/\s+/g, " ").trim();
      if (!text) continue;
      rawParts.push(text);
      const h = text.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        blocks.push({ type: "heading", text: h[2], page: pageNo, level: h[1].length });
      } else if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(text)) {
        blocks.push({ type: "list_item", text: text.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""), page: pageNo });
      } else {
        blocks.push({ type: "paragraph", text, page: pageNo });
      }
    }
  });

  return { blocks, page_count: pages.length || 1, raw_text: rawParts.join("\n") };
}

// ---------- PDF (pdfjs-dist, page-aware) ----------

async function parsePdf(buf: Buffer): Promise<ParsedDoc> {
  // pdfjs-dist 4.x ships ESM. Use the legacy build to stay Node-friendly.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Do NOT set GlobalWorkerOptions.workerSrc here. Assigning `undefined` throws
  // "Invalid `workerSrc` type" in pdfjs 4.x and broke every PDF upload. Left
  // unset, the legacy build runs parsing on the main thread (no worker), which
  // is exactly what we want on the server.

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    useSystemFonts: true,
    // Avoid pdfjs trying to fetch standard fonts over HTTP in a serverless env.
    disableFontFace: true,
    standardFontDataUrl: undefined,
  });
  const pdf = await loadingTask.promise;

  const blocks: Block[] = [];
  const rawParts: string[] = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    // Group items into visual lines by their y-coordinate.
    const lines: { y: number; height: number; text: string }[] = [];
    for (const item of tc.items as any[]) {
      if (!("str" in item) || !item.str) continue;
      const transform = item.transform as number[];
      const y = transform[5];
      const h = item.height || 10;
      const existing = lines.find((l) => Math.abs(l.y - y) <= 1);
      if (existing) {
        existing.text += " " + item.str;
        existing.height = Math.max(existing.height, h);
      } else {
        lines.push({ y, height: h, text: item.str });
      }
    }
    // Sort lines top-to-bottom (pdfjs y grows upward).
    lines.sort((a, b) => b.y - a.y);

    const heightStats = lines.map((l) => l.height).sort((a, b) => a - b);
    const medianHeight = heightStats[Math.floor(heightStats.length / 2)] || 10;

    let buffer = "";
    const flushParagraph = () => {
      const t = buffer.replace(/\s+/g, " ").trim();
      if (t) blocks.push({ type: "paragraph", text: t, page: p });
      buffer = "";
    };

    for (const line of lines) {
      const text = line.text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      rawParts.push(text);

      const isHeading =
        line.height >= medianHeight * 1.15 &&
        text.length <= 140 &&
        !/[.;]$/.test(text);
      if (isHeading) {
        flushParagraph();
        // Heading level: bigger heights → smaller h-level
        const level = Math.max(
          1,
          Math.min(6, 7 - Math.round(line.height / medianHeight))
        );
        blocks.push({ type: "heading", text, page: p, level });
        continue;
      }

      if (/^\s*(?:[-•●◦*]|\d+[.)]|[a-z][.)])\s+/.test(text)) {
        flushParagraph();
        blocks.push({
          type: "list_item",
          text: text.replace(/^\s*(?:[-•●◦*]|\d+[.)]|[a-z][.)])\s+/, ""),
          page: p,
        });
        continue;
      }

      buffer = buffer ? `${buffer} ${text}` : text;
      // Break paragraph on full stop near line end.
      if (/[.!?]\s*$/.test(text) && buffer.length > 60) flushParagraph();
    }
    flushParagraph();
  }

  return {
    blocks,
    page_count: pdf.numPages,
    raw_text: rawParts.join("\n"),
  };
}

// ---------- DOCX (mammoth + style hints) ----------

async function parseDocx(buf: Buffer): Promise<ParsedDoc> {
  // Convert to HTML so we keep heading/list information; one synthetic page.
  const html = await mammoth.convertToHtml({ buffer: buf });
  const blocks: Block[] = [];
  const rawParts: string[] = [];

  const re = /<(h([1-6])|p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html.value)) !== null) {
    const tag = m[1].toLowerCase();
    const inner = m[3]
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
    if (!inner) continue;
    rawParts.push(inner);
    if (tag.startsWith("h")) {
      blocks.push({ type: "heading", text: inner, page: 1, level: Number(m[2]) });
    } else if (tag === "li") {
      blocks.push({ type: "list_item", text: inner, page: 1 });
    } else {
      blocks.push({ type: "paragraph", text: inner, page: 1 });
    }
  }
  return { blocks, page_count: 1, raw_text: rawParts.join("\n") };
}

// ---------- TXT ----------

function parseTxt(buf: Buffer): ParsedDoc {
  const text = buf.toString("utf8");
  const blocks: Block[] = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map<Block>((t) => ({ type: "paragraph", text: t, page: 1 }));
  return { blocks, page_count: 1, raw_text: text };
}
