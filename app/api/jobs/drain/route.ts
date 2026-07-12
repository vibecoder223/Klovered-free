import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  claimJobs,
  recoverStuckJobs,
  runJob,
  markDone,
  markFailed,
  enqueueSuccessors,
  deriveDocStatus,
} from "@/lib/jobs";

export const runtime = "nodejs";
export const maxDuration = 300;

const BATCH = 8;

// Push-chain budget: keep draining within one invocation instead of leaving
// successor stages for the next cron tick — each tick boundary used to add up
// to a full polling interval of dead wall-clock per stage. Stay under
// maxDuration with headroom for the in-flight batch to finish.
const TIME_BUDGET_MS = 4 * 60_000;

// Heartbeat endpoint. A driver (pg_cron, Vercel cron, or `npm run drain`)
// calls this on an interval. Each call recovers stuck claims, then loops:
// claim a small batch, run it concurrently, enqueue successors, repeat —
// until the queue is empty or the time budget is spent. The interval driver
// remains the recovery net for crashes and long-running queues.
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (req.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminClient();
  await recoverStuckJobs(admin);

  const startedAt = Date.now();
  const allResults: Array<{ id: string; stage: string; ok: boolean; error?: string }> = [];
  let totalClaimed = 0;

  for (;;) {
    const claimed = await claimJobs(admin, BATCH);
    if (claimed.length === 0) break;
    totalClaimed += claimed.length;
    const touchedDocs = new Set<string>();

    // Run the claimed jobs concurrently — each is an independent unit of work
    // (different document or question), so there's no ordering dependency
    // within a batch.
    const results = await Promise.all(
      claimed.map(async (job) => {
        touchedDocs.add(job.document_id);
        try {
          await runJob(admin, job);
          // Enqueue successors BEFORE marking done. If this crashes mid-fan-out
          // the stage stays claimed, gets recovered, and re-runs — re-enqueue is
          // idempotent (unique-live index). Marking done first would leave a
          // permanent gap: a "done" stage with missing successors that nothing
          // ever revisits.
          await enqueueSuccessors(admin, job);
          await markDone(admin, job.id);
          return { id: job.id, stage: job.stage, ok: true };
        } catch (e: any) {
          await markFailed(admin, job, e?.message ?? "stage failed");
          return { id: job.id, stage: job.stage, ok: false, error: e?.message };
        }
      })
    );
    allResults.push(...results);

    // Status updates inside the loop so the UI tracks progress live.
    for (const documentId of touchedDocs) {
      await deriveDocStatus(admin, documentId);
    }

    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
  }

  return NextResponse.json({ claimed: totalClaimed, results: allResults });
}
