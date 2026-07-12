// Manual / CI trigger for the 48h guest-data cleanup. Reads CRON_SECRET and
// SITE_URL from the environment (or .env.local when run locally) and POSTs the
// cron route. In production a scheduler should call the same endpoint hourly.
//
//   node scripts/cleanup.mjs
import { readFileSync } from "node:fs";

function loadEnv() {
  try {
    const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const i = line.indexOf("=");
      if (i === -1 || line.trimStart().startsWith("#")) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {
    /* no .env.local — rely on the real environment */
  }
}

loadEnv();

const base = process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3100";
const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error("CRON_SECRET is not set.");
  process.exit(1);
}

const res = await fetch(`${base}/api/cron/cleanup`, {
  method: "POST",
  headers: { "x-cron-secret": secret },
});
const body = await res.json().catch(() => ({}));
console.log(res.status, JSON.stringify(body, null, 2));
process.exit(res.ok ? 0 : 1);
