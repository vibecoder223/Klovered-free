/**
 * Branded .docx export with inline citations or footnotes.
 * Uses `docx` (npm) — produces a real Word file that opens in MS Word + Google Docs.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Footer,
  PageNumber,
  ImageRun,
  BorderStyle,
} from "docx";

// Document typeface. Geist (the product UI font) isn't installed in Word or
// Google Docs, so we set the closest widely-available modern sans as the
// default and let the reader substitute gracefully. "Aptos" is the current
// Microsoft 365 default (clean geometric-humanist, very close to Geist in
// feel); Word/Docs without it fall back to their default sans. Kept in one
// place so the whole document stays typographically consistent.
const DOC_FONT = "Aptos";
const INK = "1A1A17"; // near-black body ink (matches the app's --fg ramp)
const MUTE = "6B6862"; // secondary text
const FAINT = "9B9A94"; // captions / footer

export type ExportQuestion = {
  requirement_id: string | null;
  question_text: string;
  citations: { document_filename: string; page: number | null }[];
  answer: string;
  gap_flag: "ok" | "partial" | "no_source" | null;
};

export type ExportOptions = {
  deal_name: string;
  client_name: string | null;
  org_name: string | null;
  citation_style: "inline" | "footnote";
  /** When provided, render each document as its own section heading + Q&A list. */
  sections?: { heading: string; items: ExportQuestion[] }[];
  /**
   * Proposal sections (Executive Summary, Client Understanding, etc.)
   * rendered BEFORE the Q&A block. Each has a heading + body text.
   */
  proposalSections?: { heading: string; content: string }[];
  /** Accent color hex (no #) for headings, defaults to 1F6F43 */
  accentColor?: string;
  /** Optional template logo (raw bytes + extension) rendered at top of doc. */
  logo?: { buffer: Buffer; ext: "png" | "jpg" } | null;
};

export async function renderDocx(
  questions: ExportQuestion[],
  opts: ExportOptions
): Promise<Buffer> {
  const titleParas: Paragraph[] = [];
  if (opts.logo) {
    titleParas.push(
      new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing: { after: 240 },
        children: [
          new ImageRun({
            type: opts.logo.ext === "png" ? "png" : "jpg",
            data: opts.logo.buffer,
            transformation: { width: 140, height: 60 },
            altText: { title: "Logo", description: "Template logo", name: "Logo" },
          }),
        ],
      })
    );
  }
  const accentCover = opts.accentColor ?? "1F6F43";
  // Kicker: small uppercase label in the accent, above the title.
  titleParas.push(
    new Paragraph({
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: "R F P   R E S P O N S E",
          bold: true,
          size: 18,
          color: accentCover,
        }),
      ],
    }),
    // Title: the deal name, large.
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.LEFT,
      spacing: { after: 80 },
      children: [new TextRun({ text: opts.deal_name, bold: true, size: 46, color: INK })],
    })
  );
  // Prepared for / submitted by, on one line each, tighter.
  if (opts.client_name) {
    titleParas.push(
      new Paragraph({
        spacing: { after: 20 },
        children: [
          new TextRun({ text: "Prepared for ", size: 22, color: FAINT }),
          new TextRun({ text: opts.client_name, size: 22, color: MUTE }),
        ],
      })
    );
  }
  if (opts.org_name) {
    titleParas.push(
      new Paragraph({
        spacing: { after: 20 },
        children: [
          new TextRun({ text: "Submitted by ", size: 22, color: FAINT }),
          new TextRun({ text: opts.org_name, size: 22, color: MUTE }),
        ],
      })
    );
  }
  titleParas.push(
    new Paragraph({
      spacing: { after: 200 },
      children: [
        new TextRun({
          text: new Date().toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
          }),
          size: 20,
          color: FAINT,
        }),
      ],
    }),
    // Accent divider rule under the cover block.
    new Paragraph({
      spacing: { after: 480 },
      border: {
        bottom: { style: BorderStyle.SINGLE, size: 12, space: 1, color: accentCover },
      },
      children: [new TextRun({ text: "", size: 2 })],
    })
  );

  const bodyParas: Paragraph[] = [];
  const accent = opts.accentColor ?? "1F6F43";
  // Footnote refs are numbered across the whole doc.
  let footnoteCounter = 0;
  let footnoteSourceList: ExportQuestion[] = [];

  // If sections were provided, emit a heading per document and iterate that;
  // otherwise fall back to the flat `questions` list.
  const groups: { heading?: string; items: ExportQuestion[] }[] =
    opts.sections && opts.sections.length > 0
      ? opts.sections.map((s) => ({ heading: s.heading, items: s.items }))
      : [{ items: questions }];

  // Render the Q&A block (heading + every question). Used inline when a
  // template section uses the __QA_BLOCK__ sentinel, OR appended at the end
  // when no such section exists.
  function renderQaBlock(): Paragraph[] {
    const out: Paragraph[] = [];
    for (const group of groups) {
      if (group.heading) {
        out.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: group.heading, bold: true, size: 32, color: accent })],
            spacing: { before: 360, after: 200 },
          })
        );
      }
      for (const q of group.items) {
        footnoteSourceList.push(q);
        if (q.requirement_id) {
          out.push(
            new Paragraph({
              children: [new TextRun({ text: q.requirement_id, bold: true, color: "1F6F43", size: 20 })],
              spacing: { before: 240, after: 60 },
            })
          );
        }
        out.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun({ text: q.question_text, bold: true, size: 24, color: "1A1A17" })],
            spacing: { after: 120 },
          })
        );
        if (q.gap_flag === "no_source") {
          out.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: "No source found in the knowledge base. This requirement requires human review before submission.",
                  italics: true,
                  color: "B0432F",
                  size: 22,
                }),
              ],
              spacing: { after: 240 },
            })
          );
          continue;
        }
        const answerRuns: TextRun[] = [new TextRun({ text: q.answer || "(no response)", size: 22 })];
        if (opts.citation_style === "inline") {
          const inline = q.citations
            .map((c) => `[Source: ${c.document_filename}${c.page != null ? `, p.${c.page}` : ""}]`)
            .join(" ");
          if (inline) answerRuns.push(new TextRun({ text: ` ${inline}`, size: 20, color: "6B6862" }));
        } else if (opts.citation_style === "footnote" && q.citations.length > 0) {
          const refs: string[] = [];
          for (const _c of q.citations) {
            footnoteCounter += 1;
            refs.push(`${footnoteCounter}`);
          }
          answerRuns.push(
            new TextRun({ text: ` [${refs.join(", ")}]`, superScript: true, size: 18, color: "1F6F43" })
          );
        }
        out.push(
          new Paragraph({
            children: answerRuns,
            spacing: { after: 240 },
            alignment: AlignmentType.JUSTIFIED,
          })
        );
      }
    }
    return out;
  }

  let qaRendered = false;

  // Proposal narrative sections — render in user-defined order. A section
  // whose content is "__QA_BLOCK__" expands into the full Q&A block at that
  // position instead.
  if (opts.proposalSections && opts.proposalSections.length > 0) {
    for (const ps of opts.proposalSections) {
      if (ps.content === "__QA_BLOCK__") {
        // Heading from the user's section name, then the questions.
        bodyParas.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: ps.heading, bold: true, size: 32, color: accent })],
            spacing: { before: 480, after: 200 },
          })
        );
        bodyParas.push(...renderQaBlock());
        qaRendered = true;
        continue;
      }
      bodyParas.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: ps.heading, bold: true, size: 32, color: accent })],
          spacing: { before: 480, after: 160 },
        })
      );
      const lines = ps.content.split("\n").filter((l) => l.trim() !== "");
      for (const line of lines) {
        bodyParas.push(
          new Paragraph({
            children: [new TextRun({ text: line, size: 22 })],
            spacing: { after: 160 },
            alignment: AlignmentType.JUSTIFIED,
          })
        );
      }
    }
  }

  // Fall back to appending the Q&A at the end if the template didn't include
  // a qa section (or no template was used at all).
  if (!qaRendered) {
    bodyParas.push(...renderQaBlock());
  }

  if (opts.citation_style === "footnote") {
    bodyParas.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: "References", bold: true, size: 28 })],
        spacing: { before: 480, after: 120 },
      })
    );
    let n = 0;
    for (const q of footnoteSourceList) {
      for (const c of q.citations) {
        n += 1;
        bodyParas.push(
          new Paragraph({
            children: [
              new TextRun({ text: `${n}. `, bold: true, size: 20 }),
              new TextRun({
                text: `${c.document_filename}${c.page != null ? ` — page ${c.page}` : ""}`,
                size: 20,
              }),
            ],
          })
        );
      }
    }
  }

  const doc = new Document({
    creator: opts.org_name ?? "Klovered",
    title: `RFP Response — ${opts.deal_name}`,
    description: "Generated by Klovered",
    // Document-wide typographic defaults: one clean sans everywhere, comfortable
    // 1.3 line height, ragged-right body. Every run/heading inherits this font
    // unless it sets its own, so the whole file reads as one typeface.
    styles: {
      default: {
        document: {
          run: { font: DOC_FONT, size: 22, color: INK },
          paragraph: { spacing: { line: 312, lineRule: "auto" } },
        },
      },
    },
    sections: [
      {
        properties: {},
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: opts.deal_name + " — Page ", size: 18, color: "9B9A94" }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "9B9A94" }),
                  new TextRun({ text: " of ", size: 18, color: "9B9A94" }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: "9B9A94" }),
                ],
              }),
            ],
          }),
        },
        children: [...titleParas, ...bodyParas],
      },
    ],
  });

  return await Packer.toBuffer(doc);
}
