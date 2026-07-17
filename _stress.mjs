// Scaled concurrency stress test. Runs N guests through the full loop at once
// (KB upload + RFP upload + process + poll to completion), measures per-user
// latency, success/fail, isolation, and (via the LLM metrics file) combined
// RPM/TPM through the single shared per-process rate gate.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync("./.env.local", "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL, ANON = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SITE = "http://localhost:3100";
const REF = URL_.match(/https:\/\/([a-z0-9]+)\./)[1];
const COOKIE = `sb-${REF}-auth-token`;
const admin = createClient(URL_, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const FIX = process.argv[2];
const N = Number(process.argv[3] || 5);
const RFP = process.argv[4] || "rfp-15.pdf";

const kb = readFileSync(`${FIX}/kb-full.txt`);
const rfp = readFileSync(`${FIX}/${RFP}`);

async function mint() {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signInAnonymously();
  if (error) throw error;
  return { cookie: `${COOKIE}=base64-${Buffer.from(JSON.stringify(data.session)).toString("base64")}`, userId: data.user.id };
}
const api = (path, { cookie, method = "GET", body, json, ip } = {}) => {
  const headers = { cookie, "x-forwarded-for": ip };
  let payload = body;
  if (json !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(json); }
  return fetch(`${SITE}${path}`, { method, headers, body: payload });
};
const sec = (ms) => +(ms / 1000).toFixed(1);

async function runUser(idx) {
  const ip = `10.9.${idx}.1`; // distinct IP per user → no session rate-limit collision
  const r = { idx, ok: false, stage: "mint", httpErrors: [], procSec: null, drafted: 0, total: 0, status: null };
  try {
    const g = await mint();
    r.userId = g.userId; r.cookie = g.cookie; r.ip = ip;
    r.stage = "session";
    const sres = await api("/api/session", { cookie: g.cookie, method: "POST", ip });
    if (!sres.ok) { r.httpErrors.push(`session ${sres.status}`); return r; }
    const info = await sres.json();
    r.dealId = info.deal_id; r.orgId = info.org_id;

    r.stage = "kb";
    const kfd = new FormData();
    kfd.append("file", new Blob([kb], { type: "text/plain" }), "kb.txt");
    kfd.append("doc_type", "past_proposal");
    const kres = await api("/api/knowledge/upload", { cookie: g.cookie, method: "POST", body: kfd, ip });
    if (!kres.ok) r.httpErrors.push(`kb ${kres.status}`);

    r.stage = "rfp-upload";
    const rfd = new FormData();
    rfd.append("file", new Blob([rfp], { type: "application/pdf" }), "rfp.pdf");
    rfd.append("deal_id", info.deal_id);
    const ures = await api("/api/documents/upload", { cookie: g.cookie, method: "POST", body: rfd, ip });
    if (!ures.ok) { r.httpErrors.push(`upload ${ures.status}`); return r; }
    const docId = (await ures.json()).document.id;

    r.stage = "process";
    const t0 = Date.now();
    await api("/api/documents/process", { cookie: g.cookie, method: "POST", json: { document_id: docId }, ip });

    r.stage = "poll";
    const deadline = Date.now() + 12 * 60000;
    while (Date.now() < deadline) {
      const dres = await api(`/api/documents/${docId}`, { cookie: g.cookie, ip });
      if (!dres.ok) { await new Promise((x) => setTimeout(x, 2000)); continue; }
      const d = (await dres.json()).document;
      r.status = d.processing_status;
      if (r.status === "completed") { r.ok = true; break; }
      if (r.status === "failed" || (r.status || "").endsWith("_failed")) { r.errorMsg = d.error_message; break; }
      await new Promise((x) => setTimeout(x, 2000));
    }
    r.procSec = sec(Date.now() - t0);
    const ans = await (await api(`/api/answers?deal_id=${info.deal_id}`, { cookie: g.cookie, ip })).json();
    const qs = ans.questions || [];
    r.total = qs.length; r.drafted = qs.filter((q) => q.response).length;
  } catch (e) {
    r.httpErrors.push(`ex@${r.stage}: ${e.message}`);
  }
  return r;
}

console.error(`[tier ${N}] launching ${N} concurrent users with ${RFP}...`);
const wall0 = Date.now();
const users = await Promise.all(Array.from({ length: N }, (_, i) => runUser(i + 1)));
const wallSec = sec(Date.now() - wall0);

// Isolation spot check: first user tries to read a random other user's answers.
let leak = false;
const ok = users.filter((u) => u.dealId);
if (ok.length >= 2) {
  const a = ok[0], b = ok[ok.length - 1];
  const rr = await (await api(`/api/answers?deal_id=${b.dealId}`, { cookie: a.cookie, ip: a.ip })).json();
  leak = (rr.questions || []).length > 0;
}

const completed = users.filter((u) => u.ok);
const failed = users.filter((u) => !u.ok);
const procs = completed.map((u) => u.procSec).sort((a, b) => a - b);
const p = (arr, q) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(q * arr.length))] : null;

console.log(JSON.stringify({
  tier: N,
  rfp: RFP,
  wallClockSec: wallSec,
  completed: completed.length,
  failed: failed.length,
  procSec: { min: procs[0] ?? null, median: p(procs, 0.5), p90: p(procs, 0.9), max: procs[procs.length - 1] ?? null },
  draftedTotals: completed.map((u) => `${u.drafted}/${u.total}`).slice(0, 3).concat(completed.length > 3 ? ["..."] : []),
  crossOrgLeak: leak,
  httpErrorSample: failed.flatMap((u) => u.httpErrors).slice(0, 8),
  failStatuses: failed.map((u) => u.status).filter(Boolean).slice(0, 8),
}, null, 2));

// Teardown all created orgs/users.
for (const u of users) {
  if (!u.userId) continue;
  const { data: m } = await admin.from("team_members").select("org_id").eq("user_id", u.userId);
  for (const row of m ?? []) await admin.from("organizations").delete().eq("id", row.org_id);
  await admin.auth.admin.deleteUser(u.userId).catch(() => {});
}
console.error(`[tier ${N}] done, cleaned up.`);
