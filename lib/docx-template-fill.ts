/**
 * .docx template fill engine — golden template mode.
 *
 * Pipeline:
 *  1. Walk every <w:p> paragraph. Concatenate the visible text inside (across
 *     runs, because Word loves to split "[Client Name]" into 4 chunks).
 *  2. Run replacements at paragraph level: hard map → fuzzy slug → AI fill.
 *  3. If a paragraph is a heading like "Questions and Answers" / "Q&A" /
 *     "Responses" with nothing under it, inject the full Q&A block right
 *     after that paragraph.
 *  4. Apply rewritten text back to each paragraph, preserving paragraph
 *     properties (alignment, numbering, style) by reusing <w:pPr>.
 *  5. Docxtemplater pass for {{var}} + {{#questions}}…{{/questions}} loops.
 *
 *  Failsafe — any unrecoverable error throws so caller falls back to default.
 */

import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { callMistralJson, callMistralText } from "./mistral";

export type FillQuestion = {
  requirement_id: string;
  question_text: string;
  answer: string;
  citations: string;
};

export type FillContext = {
  [key: string]: string | number | null | undefined | FillQuestion[];
  questions?: FillQuestion[];
};

// ---------- Token registry ----------

const HARD_MAP: Record<string, string> = {
  // Client
  "client name": "client_name",
  "client": "client_name",
  "customer": "client_name",
  "customer name": "client_name",
  "buyer": "client_name",
  "name of client": "client_name",
  // Company / org
  "company name": "company_name",
  "company": "company_name",
  "your company": "company_name",
  "your company name": "company_name",
  "org": "company_name",
  "organization": "company_name",
  "vendor": "company_name",
  "supplier": "company_name",
  // RFP title
  "rfp title": "rfp_title",
  "rfp": "rfp_title",
  "rfp name": "rfp_title",
  "project name": "rfp_title",
  "deal name": "rfp_title",
  "title": "rfp_title",
  "subject": "rfp_title",
  // Dates
  "date": "date",
  "today": "date",
  "submission date": "date",
  "due date": "due_date",
  "deadline": "due_date",
  "submission deadline": "due_date",
  "response due": "due_date",
  "closing date": "due_date",
  // Bid metadata
  "bid reference": "bid_reference",
  "reference": "bid_reference",
  "reference number": "bid_reference",
  "ref": "bid_reference",
  "rfp number": "bid_reference",
  "tender reference": "bid_reference",
  "bid type": "bid_type",
  "sector": "sector",
  "industry": "sector",
  "region": "region",
  "country": "region",
  "value": "value",
  "deal value": "value",
  "contract value": "value",
  "estimated value": "value",
  "total value": "value",
  "contract type": "contract_type",
  "contract duration": "contract_duration",
  "duration": "contract_duration",
  "submission method": "submission_method",
  // People
  "owner": "owner_name",
  "your name": "owner_name",
  "author": "owner_name",
  "prepared by": "owner_name",
  // Answers — single placeholder that becomes the whole block
  "answer": "primary_answer",
  "response": "primary_answer",
  "answers": "answers_block",
  "responses": "answers_block",
  "q&a": "answers_block",
  "q & a": "answers_block",
  "q and a": "answers_block",
  "questions and answers": "answers_block",
  "questions & answers": "answers_block",
  "insert q&a": "answers_block",
  "insert questions and answers": "answers_block",
  "insert responses": "answers_block",
  "all responses": "answers_block",
};

// Headings that should have the Q&A block injected immediately after them.
const QA_HEADING_RE = /^\s*(questions?\s*(and|&)\s*answers?|q\s*&\s*a|q\s*and\s*a|responses?|answers?\s+section|response\s+section|proposed\s+responses?)\s*[:.\-]?\s*$/i;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------- Paragraph helpers ----------

/** Extract the visible text from one <w:p>…</w:p> XML chunk. */
function paragraphText(paraXml: string): string {
  const parts: string[] = [];
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(paraXml)) !== null) parts.push(m[1]);
  // Word inserts <w:br/> and <w:tab/> too — preserve them as spaces for matching
  return parts.join("");
}

/**
 * Replace ALL <w:r> runs in a paragraph with a single fresh run that contains
 * `newText`. Keeps <w:pPr> at the top so paragraph formatting (alignment,
 * numbering, style, list level) survives. Inline run-level formatting inside
 * the paragraph is collapsed — that's the trade-off for cross-run matching.
 */
function rewriteParagraphText(paraXml: string, newText: string): string {
  // Capture <w:pPr> if present so we keep the paragraph's formatting.
  const pPrMatch = paraXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
  const pPr = pPrMatch ? pPrMatch[0] : "";

  // Preserve the <w:p> opening tag (attributes carry rsid etc — keep them)
  const openTagMatch = paraXml.match(/^<w:p(?:\s[^>]*)?>/);
  const openTag = openTagMatch ? openTagMatch[0] : "<w:p>";

  // Build new body
  const lines = newText.split("\n");
  const runs = lines
    .map((line, i) => {
      const safe = escapeXml(line);
      // Use xml:space="preserve" so leading/trailing spaces don't collapse
      const t = `<w:r><w:t xml:space="preserve">${safe}</w:t></w:r>`;
      if (i < lines.length - 1) return `${t}<w:r><w:br/></w:r>`;
      return t;
    })
    .join("");

  return `${openTag}${pPr}${runs}</w:p>`;
}

// ---------- Token detection ----------

/**
 * Find token-like substrings inside a piece of text:
 *   [Bracket Tokens], <<angle>>, {{mustache (non-loop)}}
 * AI tokens [AI: ...] are excluded here — handled separately.
 */
function detectTokens(text: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /\[(?!AI:)([^\[\]\n]{1,80})\]/g,
    /<<([^<>\n]{1,80})>>/g,
    /\{\{([^{}\n#\/][^{}\n]{0,80})\}\}/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.add(m[0]);
  }
  return Array.from(out);
}

/** Detect [AI: <instruction>] tokens that trigger Mistral generation. */
function detectAiTokens(text: string): string[] {
  const out = new Set<string>();
  const re = /\[AI:\s*([^\]]{1,600})\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[0]);
  return Array.from(out);
}

/** Generate content for [AI: <instruction>] tokens using the deal context. */
async function resolveAiTokens(
  tokens: string[],
  context: FillContext
): Promise<Record<string, string>> {
  if (!tokens.length) return {};
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(context)) {
    if (k === "questions") continue;
    if (v != null && v !== "") flat[k] = String(v);
  }

  const contextSummary = [
    flat.client_name && `Client: ${flat.client_name}`,
    flat.rfp_title && `RFP: ${flat.rfp_title}`,
    flat.company_name && `Company: ${flat.company_name}`,
    flat.sector && `Sector: ${flat.sector}`,
    flat.region && `Region: ${flat.region}`,
    flat.owner_name && `Prepared by: ${flat.owner_name}`,
  ].filter(Boolean).join("\n");

  const results: Record<string, string> = {};
  for (const token of tokens) {
    const m = token.match(/^\[AI:\s*([\s\S]+)\]$/);
    if (!m) continue;
    // Expand known bracket tokens in the instruction itself
    let instruction = m[1].trim();
    for (const [k, v] of Object.entries(flat)) {
      instruction = instruction.replace(new RegExp(`\\[${escapeRegex(k)}\\]`, "gi"), v);
    }
    instruction = instruction
      .replace(/\[Client Name\]/gi, flat.client_name ?? "")
      .replace(/\[Company Name\]/gi, flat.company_name ?? "")
      .replace(/\[RFP Title\]/gi, flat.rfp_title ?? "")
      .replace(/\[Sector\]/gi, flat.sector ?? "")
      .replace(/\[Region\]/gi, flat.region ?? "");
    try {
      const { text } = await callMistralText({
        system: `You are writing a section of a professional RFP proposal response.
Write in formal business English. 2-3 concise paragraphs. Be persuasive and outcome-focused.
Never invent facts not supported by context. Do not include section headings in the output.

Deal context:
${contextSummary}`,
        user: instruction,
        maxTokens: 500,
      });
      results[token] = text.trim();
    } catch (e: any) {
      console.warn(`[template-fill] AI section generation failed: ${e.message}`);
      results[token] = "";
    }
  }
  return results;
}

function resolveHardOrFuzzy(token: string, context: FillContext): string | null {
  const inside = token
    .replace(/^[\[\{<]+/, "")
    .replace(/[\]\}>]+$/, "")
    .trim()
    .toLowerCase();

  if (HARD_MAP[inside]) {
    const key = HARD_MAP[inside];
    const v = context[key];
    return v != null && v !== "" ? String(v) : "";
  }
  const sluggified = slug(inside);
  const direct = context[sluggified];
  if (typeof direct === "string" || typeof direct === "number") {
    return direct === "" ? "" : String(direct);
  }
  return null;
}

async function aiFillTokens(
  tokens: string[],
  context: FillContext,
  templateText: string
): Promise<Record<string, string>> {
  if (tokens.length === 0) return {};
  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) {
    if (k === "questions") continue;
    if (v != null && v !== "") flat[k] = v;
  }
  const system = `You fill placeholders in an RFP proposal template using a fixed context bag.
- Only return values you can justify from the context. Never invent facts.
- If context has no usable value, return empty string for that token.
- Return JSON {<token>: <value>} for every token. Keep values short.
- Do not include surrounding brackets in the value.`;
  const user = `Context (JSON):
${JSON.stringify(flat, null, 2)}

Template excerpt:
"""
${templateText.slice(0, 4000)}
"""

Tokens (return JSON for every one):
${JSON.stringify(tokens)}`;
  try {
    const { data } = await callMistralJson<Record<string, string>>({ system, user, maxTokens: 1200 });
    if (!data || typeof data !== "object") return {};
    const out: Record<string, string> = {};
    for (const t of tokens) {
      const v = (data as any)[t];
      if (typeof v === "string" && v.trim()) out[t] = v.trim();
    }
    return out;
  } catch (e: any) {
    console.warn(`[template-fill] AI step failed: ${e.message}`);
    return {};
  }
}

// ---------- Q&A injection ----------

function formatQAblock(qs: FillQuestion[]): string {
  if (!qs.length) return "";
  const lines: string[] = [];
  qs.forEach((q, i) => {
    const id = q.requirement_id ? `${q.requirement_id}. ` : `${i + 1}. `;
    lines.push(`${id}${q.question_text}`);
    lines.push(q.answer || "(no response)");
    if (q.citations) lines.push(`Sources: ${q.citations}`);
    lines.push("");
  });
  return lines.join("\n").trim();
}

// ---------- Main ----------

export async function fillDocxTemplate(
  buf: Buffer,
  context: FillContext
): Promise<Buffer> {
  let zip: PizZip;
  try {
    zip = new PizZip(buf);
  } catch (e: any) {
    throw new Error(`Template is not a valid .docx file: ${e.message}`);
  }

  const qaBlock = formatQAblock((context.questions ?? []) as FillQuestion[]);
  // Override context.answers_block if not provided explicitly by caller
  if (!context.answers_block && qaBlock) {
    context.answers_block = qaBlock;
  }

  // 1. Collect ALL paragraph-level text across the parts we touch
  const parts = ["word/document.xml", "word/header1.xml", "word/footer1.xml"];
  type ParaHit = { part: string; raw: string; text: string };
  const paragraphs: ParaHit[] = [];

  for (const p of parts) {
    const f = zip.file(p);
    if (!f) continue;
    const xml = f.asText();
    const re = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      paragraphs.push({ part: p, raw: m[0], text: paragraphText(m[0]) });
    }
  }

  // 2. Detect all unique tokens across paragraphs
  const fullText = paragraphs.map((p) => p.text).join("\n");
  const tokens = detectTokens(fullText);
  const aiTokens = detectAiTokens(fullText);

  // 3. Resolve hard + fuzzy, collect unresolved for AI fill pass
  const resolved: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const t of tokens) {
    const v = resolveHardOrFuzzy(t, context);
    if (v != null) resolved[t] = v;
    else unresolved.push(t);
  }

  if (unresolved.length > 0) {
    const aiMap = await aiFillTokens(unresolved, context, fullText);
    for (const [tok, v] of Object.entries(aiMap)) resolved[tok] = v;
  }

  // Resolve [AI: ...] tokens via Mistral section generation
  if (aiTokens.length > 0) {
    const aiSectionMap = await resolveAiTokens(aiTokens, context);
    for (const [tok, v] of Object.entries(aiSectionMap)) resolved[tok] = v;
  }

  // 4. Rewrite each paragraph, also injecting Q&A after relevant headings.
  const rewrittenByPart: Record<string, { from: string; to: string }[]> = {};
  for (const para of paragraphs) {
    let newText = para.text;
    let changed = false;

    // Replace every resolved token in this paragraph's text
    for (const [tok, val] of Object.entries(resolved)) {
      if (!newText.includes(tok)) continue;
      newText = newText.split(tok).join(val);
      changed = true;
    }

    // Detect Q&A heading paragraphs → inject the block as a sibling paragraph
    let injected: string | null = null;
    if (qaBlock && QA_HEADING_RE.test(para.text.trim())) {
      injected = `<w:p><w:r><w:t xml:space="preserve">${escapeXml(qaBlock).replace(
        /\n/g,
        '</w:t></w:r><w:r><w:br/></w:r><w:r><w:t xml:space="preserve">'
      )}</w:t></w:r></w:p>`;
    }

    if (!changed && !injected) continue;

    let newRaw = changed ? rewriteParagraphText(para.raw, newText) : para.raw;
    if (injected) newRaw = `${newRaw}${injected}`;

    (rewrittenByPart[para.part] ??= []).push({ from: para.raw, to: newRaw });
  }

  // 5. Apply rewrites back to each part's xml
  for (const part of parts) {
    const f = zip.file(part);
    if (!f) continue;
    const hits = rewrittenByPart[part];
    if (!hits || hits.length === 0) continue;
    let xml = f.asText();
    // We have to do literal string replacements because `from` may contain
    // regex metachars in attribute strings.
    for (const { from, to } of hits) {
      const idx = xml.indexOf(from);
      if (idx === -1) continue;
      xml = xml.slice(0, idx) + to + xml.slice(idx + from.length);
    }
    zip.file(part, xml);
  }

  // 6. docxtemplater pass — handle {{var}} + loops
  let doc: Docxtemplater;
  try {
    doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: "{{", end: "}}" },
      nullGetter: () => "",
    });
  } catch (e: any) {
    throw new Error(`docxtemplater init failed: ${e.message}`);
  }
  try {
    doc.render(context as any);
  } catch (e: any) {
    const d = e?.properties?.errors
      ? JSON.stringify(e.properties.errors.slice(0, 3))
      : e.message;
    throw new Error(`Template render failed: ${d}`);
  }

  return doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
}

// Backwards-compat alias for older imports
export type FillVars = FillContext;
