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
const N = Number(process.argv[3] || 2);

async function mint() {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { data } = await c.auth.signInAnonymously();
  return { cookie: `${COOKIE}=base64-${Buffer.from(JSON.stringify(data.session)).toString("base64")}`, userId: data.user.id };
}
const api = (path, { cookie, method = "GET", body, json, ip } = {}) => {
  const headers = { cookie, "x-forwarded-for": ip };
  let payload = body;
  if (json !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(json); }
  return fetch(`${SITE}${path}`, { method, headers, body: payload });
};
const minf = (ms) => (ms / 60000).toFixed(2);
const kb = readFileSync(`${FIX}/kb-full.txt`);
const rfp = readFileSync(`${FIX}/rfp-40.pdf`);

async function runUser(idx) {
  const g = await mint();
  const ip = `10.2.${idx}.1`;
  const info = await (await api("/api/session", { cookie: g.cookie, method: "POST", ip })).json();
  const kfd = new FormData();
  kfd.append("file", new Blob([kb], { type: "text/plain" }), "kb.txt");
  kfd.append("doc_type", "past_proposal");
  await api("/api/knowledge/upload", { cookie: g.cookie, method: "POST", body: kfd, ip });
  const rfd = new FormData();
  rfd.append("file", new Blob([rfp], { type: "application/pdf" }), "rfp.pdf");
  rfd.append("deal_id", info.deal_id);
  const up = await (await api("/api/documents/upload", { cookie: g.cookie, method: "POST", body: rfd, ip })).json();
  const docId = up.document.id;
  const t0 = Date.now();
  await api("/api/documents/process", { cookie: g.cookie, method: "POST", json: { document_id: docId }, ip });
  const deadline = Date.now() + 8 * 60000;
  let status = null, failed = false;
  while (Date.now() < deadline) {
    const d = (await (await api(`/api/documents/${docId}`, { cookie: g.cookie, ip })).json()).document;
    status = d.processing_status;
    if (status === "completed") break;
    if (status === "failed" || status.endsWith("_failed")) { failed = true; break; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  const procMin = minf(Date.now() - t0);
  const ans = await (await api(`/api/answers?deal_id=${info.deal_id}`, { cookie: g.cookie, ip })).json();
  const qs = ans.questions || [];
  return { idx, userId: g.userId, cookie: g.cookie, ip, dealId: info.deal_id, orgId: info.org_id,
    status, failed, procMin, drafted: qs.filter((q) => q.response).length, total: qs.length };
}

console.log(`Launching ${N} users concurrently...`);
const wall0 = Date.now();
const users = await Promise.all(Array.from({ length: N }, (_, i) => runUser(i + 1)));
const wallMin = minf(Date.now() - wall0);

// Cross-isolation: each user tries to read every OTHER user's answers by deal_id.
let leak = false;
for (const a of users) {
  for (const b of users) {
    if (a === b) continue;
    const r = await (await api(`/api/answers?deal_id=${b.dealId}`, { cookie: a.cookie, ip: a.ip })).json();
    if ((r.questions || []).length > 0) { leak = true; console.log(`LEAK: user ${a.idx} read ${(r.questions||[]).length} of user ${b.idx}'s answers`); }
  }
}

console.log(JSON.stringify({
  concurrentUsers: N,
  wallClockMin: wallMin,
  perUser: users.map((u) => ({ idx: u.idx, status: u.status, procMin: u.procMin, drafted: `${u.drafted}/${u.total}` })),
  crossOrgLeak: leak,
}, null, 2));

for (const u of users) {
  const { data: m } = await admin.from("team_members").select("org_id").eq("user_id", u.userId);
  for (const row of m ?? []) await admin.from("organizations").delete().eq("id", row.org_id);
  await admin.auth.admin.deleteUser(u.userId).catch(() => {});
}
