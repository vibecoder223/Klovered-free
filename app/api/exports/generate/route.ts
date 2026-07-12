import { requireGuest, AuthError } from "@/utils/auth";
import { NextResponse } from "next/server";
import { tryCreateAdminClient } from "@/utils/supabase/admin";
import PDFDocument from "pdfkit";
import { renderDocx, type ExportQuestion } from "@/lib/docx-export";
import { fillDocxTemplate, type FillVars } from "@/lib/docx-template-fill";
import { callMistralText } from "@/lib/mistral";

const SECTIONS_PREFIX = "__SECTIONS__:";

type TemplateSection = {
  id: string;
  name: string;
  type: "ai" | "static" | "qa";
  instruction?: string;
  content?: string;
  maxWords?: number;
};

async function generateProposalSections(
  sections: TemplateSection[],
  ctx: FillVars
): Promise<{ heading: string; content: string }[]> {
  const contextSummary = [
    ctx.client_name && `Client: ${ctx.client_name}`,
    ctx.rfp_title && `RFP: ${ctx.rfp_title}`,
    ctx.company_name && `Company: ${ctx.company_name}`,
    ctx.sector && `Sector: ${ctx.sector}`,
    ctx.region && `Region: ${ctx.region}`,
    ctx.owner_name && `Prepared by: ${ctx.owner_name}`,
    ctx.value && `Contract value: ${ctx.value}`,
  ].filter(Boolean).join("\n");

  function expandTokens(text: string): string {
    return text
      .replace(/\[Client Name\]/gi, String(ctx.client_name ?? ""))
      .replace(/\[Company Name\]/gi, String(ctx.company_name ?? ""))
      .replace(/\[RFP Title\]/gi, String(ctx.rfp_title ?? ""))
      .replace(/\[Sector\]/gi, String(ctx.sector ?? ""))
      .replace(/\[Region\]/gi, String(ctx.region ?? ""))
      .replace(/\[Owner\]/gi, String(ctx.owner_name ?? ""))
      .replace(/\[Date\]/gi, String(ctx.date ?? ""))
      .replace(/\[Due Date\]/gi, String(ctx.due_date ?? ""))
      .replace(/\[Value\]/gi, String(ctx.value ?? ""))
      .replace(/\[Contract Type\]/gi, String(ctx.contract_type ?? ""))
      .replace(/\[Contract Duration\]/gi, String(ctx.contract_duration ?? ""))
      .replace(/\[Bid Reference\]/gi, String(ctx.bid_reference ?? ""));
  }

  const out: { heading: string; content: string }[] = [];
  for (const sec of sections) {
    if (sec.type === "qa") {
      // Sentinel — renderDocx swaps this for the full Q&A block at this position.
      out.push({ heading: sec.name || "Questions and Answers", content: "__QA_BLOCK__" });
      continue;
    }
    if (sec.type === "static") {
      out.push({ heading: sec.name, content: expandTokens(sec.content ?? "") });
      continue;
    }
    // AI section
    const instruction = expandTokens(sec.instruction ?? `Write the "${sec.name}" section for this RFP response proposal.`);
    const wl = sec.maxWords && sec.maxWords > 0 ? sec.maxWords : null;
    const lengthRule = wl
      ? `Keep this section under ${wl} words. Be concise.`
      : "Write 2-3 concise paragraphs.";
    try {
      const { text } = await callMistralText({
        system: `You are writing a section of a professional RFP proposal response.
Write in formal business English. ${lengthRule} Be persuasive and outcome-focused.
Never invent facts not in the context. Do not include the section heading in your output.

Deal context:\n${contextSummary}`,
        user: instruction,
        maxTokens: wl ? Math.min(500, Math.ceil(wl * 1.6) + 40) : 500,
      });
      out.push({ heading: sec.name, content: text.trim() });
    } catch (e: any) {
      console.warn(`[export] AI section "${sec.name}" failed: ${e.message}`);
      out.push({ heading: sec.name, content: expandTokens(sec.content ?? "") });
    }
  }
  return out;
}

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await requireGuest();
  } catch (e) {
    const s = e instanceof AuthError ? e.status : 401;
    return NextResponse.json({ error: "No session" }, { status: s });
  }
  const { supabase, user } = ctx;

  const body = (await req.json()) as {
    deal_id?: string;
    document_id?: string;
    document_ids?: string[];
    merge?: boolean;
    format?: "pdf" | "docx";
    citation_style?: "inline" | "footnote";
    template_id?: string | null;
  };
  const { deal_id } = body;
  const docIds = body.document_ids?.length
    ? body.document_ids
    : body.document_id
    ? [body.document_id]
    : [];
  const merge = !!body.merge && docIds.length > 1;
  const format: "pdf" | "docx" = body.format === "docx" ? "docx" : "pdf";
  const citationStyle: "inline" | "footnote" =
    body.citation_style === "footnote" ? "footnote" : "inline";

  if (!deal_id || docIds.length === 0) {
    return NextResponse.json({ error: "deal_id and document_ids required" }, { status: 400 });
  }

  // Pull every deal column we know about + org name. Falls back to the core
  // subset if the extended bid-management columns weren't migrated.
  let deal: any = null;
  try {
    const r = await supabase
      .from("deals")
      .select(
        "id, name, client_name, value, due_date, bid_reference, bid_type, sector, region, contract_type, contract_duration, submission_method, win_probability, competitors, notes, owner_id, org_id, organizations(name)"
      )
      .eq("id", deal_id)
      .maybeSingle();
    if (r.error) throw r.error;
    deal = r.data;
  } catch {
    const r2 = await supabase
      .from("deals")
      .select("id, name, client_name, due_date, owner_id, org_id, organizations(name)")
      .eq("id", deal_id)
      .maybeSingle();
    deal = r2.data;
  }
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Owner display name (best-effort)
  let ownerName: string | null = null;
  if (deal.owner_id) {
    const { data: ownerRow } = await supabase
      .from("team_members")
      .select("name, email")
      .eq("user_id", deal.owner_id)
      .maybeSingle();
    ownerName = ownerRow?.name || ownerRow?.email || null;
  }

  const { data: docRows } = await supabase
    .from("documents")
    .select("id, filename, created_at")
    .in("id", docIds)
    .order("created_at", { ascending: true });
  const docs = docRows ?? [];

  const { data: questions } = await supabase
    .from("questions")
    .select(
      "document_id, requirement_id, question_text, created_at, responses(id, final_text, draft_text, status, gap_flag, citations(document_filename, page, section_path))"
    )
    .in("document_id", docIds)
    .order("created_at", { ascending: true });

  if (!questions || questions.length === 0) {
    return NextResponse.json({ error: "Nothing to export" }, { status: 400 });
  }

  // Group questions by document, in the order of the documents.
  const byDoc = new Map<string, any[]>();
  for (const d of docs) byDoc.set(d.id, []);
  for (const q of questions as any[]) {
    if (!byDoc.has(q.document_id)) byDoc.set(q.document_id, []);
    byDoc.get(q.document_id)!.push(q);
  }

  function toExportable(qs: any[]): ExportQuestion[] {
    return qs.map((q) => {
      const approved = (q.responses ?? []).find((r: any) => r.status === "approved");
      const r = approved ?? (q.responses ?? [])[0];
      const answer = r?.final_text || r?.draft_text || "(no response)";
      const citations = (r?.citations ?? []).map((c: any) => ({
        document_filename: c.document_filename,
        page: c.page,
      }));
      return {
        requirement_id: q.requirement_id,
        question_text: q.question_text,
        answer,
        citations,
        gap_flag: (r?.gap_flag ?? null) as ExportQuestion["gap_flag"],
      };
    });
  }

  // For non-merge mode, single doc only.
  const exportable: ExportQuestion[] = merge
    ? [] // we'll build sectioned output below
    : toExportable((byDoc.get(docIds[0]) ?? []) as any[]);

  // Build sectioned export: array of { heading, items }
  const sections = docs
    .filter((d) => (byDoc.get(d.id)?.length ?? 0) > 0)
    .map((d) => ({
      heading: d.filename,
      items: toExportable(byDoc.get(d.id) ?? []),
    }));

  const orgName = (deal as any).organizations?.name ?? null;

  // Resolve template (explicit id > org default > none). Fail soft if table missing.
  let template:
    | { id: string; name: string; kind: string | null; file_path: string | null; intro?: string | null; accent_color?: string | null; logo_path?: string | null }
    | null = null;
  // Scope template lookup to the deal's org so a user can't reference another
  // tenant's template (or pick up a foreign default) via the template_id body
  // field. proposal_templates is not defined in this repo's migrations, so we
  // cannot rely on RLS being enabled; the explicit org_id filter is the only
  // authoritative isolation here.
  const dealOrgId = (deal as any).org_id as string | undefined;
  try {
    if (body.template_id && dealOrgId) {
      const { data } = await supabase
        .from("proposal_templates")
        .select("id, name, kind, file_path, intro, accent_color, logo_path")
        .eq("id", body.template_id)
        .eq("org_id", dealOrgId)
        .maybeSingle();
      template = data ?? null;
    } else if (body.template_id === undefined && dealOrgId) {
      const { data } = await supabase
        .from("proposal_templates")
        .select("id, name, kind, file_path, intro, accent_color, logo_path")
        .eq("is_default", true)
        .eq("org_id", dealOrgId)
        .maybeSingle();
      template = data ?? null;
    }
  } catch {}

  // Fetch the template logo (if any) — used by both fallback docx export and
  // can be referenced in golden-template flows later.
  let logo: { buffer: Buffer; ext: "png" | "jpg" } | null = null;
  if (template?.logo_path) {
    try {
      const reader = tryCreateAdminClient() ?? supabase;
      const { data: blob } = await reader.storage.from("templates").download(template.logo_path);
      if (blob) {
        const ab = await blob.arrayBuffer();
        logo = {
          buffer: Buffer.from(ab),
          ext: template.logo_path.toLowerCase().endsWith(".png") ? "png" : "jpg",
        };
      }
    } catch (e: any) {
      console.warn(`[export] logo fetch failed: ${e.message}`);
    }
  }

  let buf!: Buffer;
  let contentType: string;
  let ext: string;

  // Flattened Q&A list for golden-template variables (across all selected docs)
  const flatItems: ExportQuestion[] = merge
    ? sections.flatMap((s) => s.items)
    : exportable;

  // GOLDEN TEMPLATE MODE — only for .docx output with a .docx template.
  let usedGoldenTemplate = false;
  if (format === "docx" && template?.kind === "docx" && template.file_path) {
    try {
      const writer = tryCreateAdminClient() ?? supabase;
      const { data: blob, error: dlErr } = await writer.storage
        .from("templates")
        .download(template.file_path);
      if (dlErr || !blob) throw new Error(dlErr?.message ?? "no data");
      const tplBuf = Buffer.from(await blob.arrayBuffer());

      const today = new Date().toLocaleDateString(undefined, {
        year: "numeric", month: "long", day: "numeric",
      });
      const formattedValue =
        deal.value != null && deal.value !== ""
          ? `$${Number(deal.value).toLocaleString()}`
          : "";
      const formattedDue = deal.due_date
        ? new Date(deal.due_date).toLocaleDateString(undefined, {
            year: "numeric", month: "long", day: "numeric",
          })
        : "";

      const fillContext: FillVars = {
        // Identity
        client_name: deal.client_name ?? "",
        company_name: orgName ?? "",
        rfp_title: deal.name,
        date: today,
        // Dates + reference
        due_date: formattedDue,
        bid_reference: deal.bid_reference ?? "",
        // Bid metadata
        bid_type: deal.bid_type ?? "",
        sector: deal.sector ?? "",
        region: deal.region ?? "",
        contract_type: deal.contract_type ?? "",
        contract_duration: deal.contract_duration ?? "",
        submission_method: deal.submission_method ?? "",
        value: formattedValue,
        win_probability: deal.win_probability != null ? `${deal.win_probability}%` : "",
        competitors: deal.competitors ?? "",
        notes: deal.notes ?? "",
        // People
        owner_name: ownerName ?? "",
        // Answers
        questions: flatItems.map((q) => ({
          requirement_id: q.requirement_id ?? "",
          question_text: q.question_text,
          answer:
            q.gap_flag === "no_source"
              ? "(Requires human review — no source in knowledge base.)"
              : q.answer,
          citations: q.citations
            .map((c) => `${c.document_filename}${c.page != null ? `, p.${c.page}` : ""}`)
            .join("; "),
        })),
        answers_block: flatItems
          .map((q) => {
            const a = q.gap_flag === "no_source" ? "(Requires human review.)" : q.answer;
            return `${q.requirement_id ?? ""}\n${q.question_text}\n${a}\n`;
          })
          .join("\n"),
        primary_answer: flatItems[0]?.answer ?? "",
      };

      buf = await fillDocxTemplate(tplBuf, fillContext);
      usedGoldenTemplate = true;
    } catch (e: any) {
      console.warn(`[export] golden template failed, falling back: ${e.message}`);
    }
  }

  // Resolve section-builder template (plain kind with __SECTIONS__ intro)
  let proposalSections: { heading: string; content: string }[] | undefined;
  if (
    !usedGoldenTemplate &&
    format === "docx" &&
    template?.intro?.startsWith(SECTIONS_PREFIX)
  ) {
    try {
      const rawSections: TemplateSection[] = JSON.parse(
        template.intro.slice(SECTIONS_PREFIX.length)
      );
      const fillCtx: FillVars = {
        client_name: deal.client_name ?? "",
        company_name: orgName ?? "",
        rfp_title: deal.name,
        date: new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
        due_date: deal.due_date ? new Date(deal.due_date).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "",
        bid_reference: deal.bid_reference ?? "",
        sector: deal.sector ?? "",
        region: deal.region ?? "",
        value: deal.value != null ? `$${Number(deal.value).toLocaleString()}` : "",
        contract_type: deal.contract_type ?? "",
        contract_duration: deal.contract_duration ?? "",
        owner_name: ownerName ?? "",
      };
      proposalSections = await generateProposalSections(rawSections, fillCtx);
    } catch (e: any) {
      console.warn(`[export] section generation failed: ${e.message}`);
    }
  }

  if (format === "docx") {
    if (!usedGoldenTemplate) {
      // Default to the Vellum forest accent when a template doesn't set one.
      const accentColor = template?.accent_color?.replace("#", "") ?? "1F6F43";
      if (merge) {
        buf = await renderDocx(exportable, {
          deal_name: deal.name,
          client_name: deal.client_name,
          org_name: orgName,
          citation_style: citationStyle,
          sections,
          proposalSections,
          accentColor,
          logo,
        } as any);
      } else {
        buf = await renderDocx(exportable, {
          deal_name: deal.name,
          client_name: deal.client_name,
          org_name: orgName,
          citation_style: citationStyle,
          proposalSections,
          accentColor,
          logo,
        });
      }
    }
    contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    ext = "docx";
  } else {
    buf = await renderPdf(merge ? [] : exportable, {
      deal_name: deal.name,
      client_name: deal.client_name,
      org_name: orgName,
      citation_style: citationStyle,
      sections: merge ? sections : undefined,
      accentColor: template?.accent_color ?? "#1F7A53",
    });
    contentType = "application/pdf";
    ext = "pdf";
  }

  const storage = (tryCreateAdminClient() ?? supabase).storage.from("documents");
  const path = `${deal_id}/export-${Date.now()}.${ext}`;
  const { error: upErr } = await storage.upload(path, buf, {
    contentType,
    upsert: false,
  });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  const { data: row, error: insertErr } = await supabase
    .from("exports")
    .insert({
      deal_id,
      // For merged exports, store the first doc id as a reference point.
      document_id: docIds[0],
      file_path: path,
      format: ext,
      created_by: user.id,
    })
    .select()
    .single();
  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

  return NextResponse.json({ exportId: row.id, format: ext });
}

async function renderPdf(
  questions: ExportQuestion[],
  opts: {
    deal_name: string;
    client_name: string | null;
    org_name: string | null;
    citation_style: "inline" | "footnote";
    sections?: { heading: string; items: ExportQuestion[] }[];
    accentColor?: string;
  }
): Promise<Buffer> {
  const accent = opts.accentColor ?? "#1F7A53";
  return await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, size: "LETTER" });
    const chunks: Buffer[] = [];
    doc.on("data", (b) => chunks.push(b as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).fillColor("#0F1626").text(`RFP Response`, { align: "left" });
    doc.moveDown(0.2);
    doc.fontSize(13).fillColor("#5B6478").text(opts.deal_name);
    if (opts.client_name) {
      doc.moveDown(0.1);
      doc.fontSize(11).fillColor("#8A93A6").text(`Prepared for ${opts.client_name}`);
    }
    if (opts.org_name) {
      doc.moveDown(0.1);
      doc.fontSize(11).fillColor("#8A93A6").text(`Submitted by ${opts.org_name}`);
    }
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor("#8A93A6").text(new Date().toLocaleDateString());
    doc.moveDown(1.5);

    function renderQuestion(q: ExportQuestion) {
      doc.fontSize(11).fillColor(accent).text(q.requirement_id ?? "", { continued: false });
      doc.moveDown(0.15);
      doc.fontSize(12.5).fillColor("#0F1626").text(q.question_text);
      doc.moveDown(0.35);
      if (q.gap_flag === "no_source") {
        doc
          .fontSize(11)
          .fillColor("#C0392B")
          .text(
            "No source found in the knowledge base. Human review required before submission.",
            { align: "left" }
          );
      } else {
        doc.fontSize(11).fillColor("#2A3245").text(q.answer, { align: "justify" });
        if (opts.citation_style === "inline" && q.citations.length > 0) {
          const inline = q.citations
            .map((c) => `[Source: ${c.document_filename}${c.page != null ? `, p.${c.page}` : ""}]`)
            .join(" ");
          doc.moveDown(0.2);
          doc.fontSize(9.5).fillColor("#5B6478").text(inline);
        }
      }
      doc.moveDown(1);
    }

    if (opts.sections && opts.sections.length > 0) {
      opts.sections.forEach((sec, i) => {
        if (i > 0) doc.addPage();
        doc.fontSize(16).fillColor(accent).text(sec.heading);
        doc.moveDown(0.6);
        for (const q of sec.items) renderQuestion(q);
      });
    } else {
      for (const q of questions) renderQuestion(q);
    }

    doc.end();
  });
}
