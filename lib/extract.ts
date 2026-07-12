// Server-only text extraction for PDF/DOCX/TXT.

export async function extractText(buf: Buffer, mime: string | null, filename: string): Promise<string> {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  if (mime === "application/pdf" || ext === "pdf") {
    return extractPdf(buf);
  }
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    return extractDocx(buf);
  }
  if (mime === "text/plain" || ext === "txt") {
    return buf.toString("utf8");
  }
  throw new Error(`Unsupported file type: ${mime || ext}`);
}

async function extractPdf(buf: Buffer): Promise<string> {
  // pdf-parse has a self-test on import that reads ./test/data/05-versions-space.pdf
  // We require it from the inner module to skip that test harness.
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default as (
    b: Buffer
  ) => Promise<{ text: string }>;
  const out = await pdfParse(buf);
  return cleanText(out.text);
}

async function extractDocx(buf: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const out = await mammoth.extractRawText({ buffer: buf });
  return cleanText(out.value);
}

function cleanText(t: string): string {
  return t
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
