/**
 * Knowledge-base ingestion: download → parse → chunk → embed → store.
 * Returns the chunk count on success, throws on failure. Status transitions
 * are managed by the caller via knowledge_documents.ingestion_status.
 */

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseDocument } from "./parse";
import { chunkBlocks } from "./chunk";
import { embedTexts, hasEmbeddings } from "./embeddings";

async function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type KDoc = {
  id: string;
  org_id: string;
  filename: string;
  file_path: string;
  mime_type: string | null;
};

export async function ingestKnowledgeDocument(
  supabase: SupabaseClient,
  doc: KDoc
): Promise<{ chunk_count: number; page_count: number; dedup: boolean }> {
  // Stage updates are written to error_message with "STAGE:" prefix so the UI
  // can poll progress without a schema change. Final success clears it.
  const setStage = async (stage: string) => {
    await supabase
      .from("knowledge_documents")
      .update({ ingestion_status: "processing", error_message: `STAGE:${stage}` })
      .eq("id", doc.id);
  };

  await setStage("downloading");

  // 1. Download
  const { data: blob, error: dlErr } = await supabase.storage
    .from("knowledge")
    .download(doc.file_path);
  if (dlErr || !blob) throw new Error(`Storage download failed: ${dlErr?.message ?? "no data"}`);
  const buf = Buffer.from(await blob.arrayBuffer());

  // 2. Parse (with timeout — mammoth can hang on malformed DOCX)
  await setStage("parsing");
  const parsed = await withTimeout(
    parseDocument(buf, doc.mime_type, doc.filename),
    60_000,
    "Parsing timed out after 60s. The document may be corrupted or unusually complex."
  );
  if (!parsed.blocks.length) throw new Error("No content extracted from document.");

  // 3. Hash for dedup
  const textHash = crypto.createHash("sha256").update(parsed.raw_text).digest("hex");

  // If the same hash already ingested in this org, skip re-chunking.
  const { data: existing } = await supabase
    .from("knowledge_documents")
    .select("id, ingestion_status")
    .eq("org_id", doc.org_id)
    .eq("text_hash", textHash)
    .neq("id", doc.id)
    .maybeSingle();
  if (existing && existing.ingestion_status === "ready") {
    // Mark current as ready WITHOUT writing text_hash — there is a unique
    // constraint on (org_id, text_hash) and the existing "ready" row already
    // holds the hash. We just point the user at the existing ingest via the
    // error_message and skip chunk insertion.
    const { error: updErr } = await supabase
      .from("knowledge_documents")
      .update({
        ingestion_status: "ready",
        page_count: parsed.page_count,
        error_message: "Deduplicated against a previously ingested document with identical text.",
      })
      .eq("id", doc.id);
    if (updErr) throw new Error(`Dedup status update failed: ${updErr.message}`);
    return { chunk_count: 0, page_count: parsed.page_count, dedup: true };
  }

  // 4. Chunk
  await setStage("chunking");
  const chunks = chunkBlocks({ blocks: parsed.blocks, filename: doc.filename });
  if (chunks.length === 0) throw new Error("Chunker produced 0 chunks (document may be empty).");

  // 5. Embed (batched inside embedTexts). Skip the call entirely when no
  // provider is configured — embedTexts now throws instead of returning zeros.
  await setStage("embedding");
  const embeddings: number[][] = hasEmbeddings()
    ? await embedTexts(chunks.map((c) => c.text_for_embedding), "document")
    : [];

  // 6. Persist — wipe any prior chunks for this KB doc (idempotent re-ingest)
  await setStage("storing");
  await supabase.from("document_chunks").delete().eq("knowledge_document_id", doc.id);

  const rows = chunks.map((c, i) => ({
    knowledge_document_id: doc.id,
    org_id: doc.org_id,
    chunk_index: i,
    section_title: c.section_path,
    section_path: c.section_path,
    page_start: c.page_start,
    page_end: c.page_end,
    raw_text: c.text,
    cleaned_text: c.text,
    text_for_embedding: c.text_for_embedding,
    embedding: hasEmbeddings() ? embeddings[i] : null,
    sparse_terms: c.sparse_terms,
  }));

  // Insert in slices in parallel — Postgres handles concurrent inserts fine.
  const slices: any[][] = [];
  for (let i = 0; i < rows.length; i += 50) slices.push(rows.slice(i, i + 50));
  await Promise.all(
    slices.map(async (slice) => {
      const { error } = await supabase.from("document_chunks").insert(slice);
      if (error) throw new Error(`Chunk insert failed: ${error.message}`);
    })
  );

  await supabase
    .from("knowledge_documents")
    .update({
      ingestion_status: "ready",
      page_count: parsed.page_count,
      text_hash: textHash,
      error_message: hasEmbeddings()
        ? null
        : "Stored without embeddings — set MISTRAL_API_KEY in .env.local and re-ingest to enable retrieval.",
    })
    .eq("id", doc.id);

  return { chunk_count: chunks.length, page_count: parsed.page_count, dedup: false };
}
