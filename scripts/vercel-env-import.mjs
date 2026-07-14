#!/usr/bin/env node
/**
 * Push every var in .env.local into the linked Vercel project, so production
 * has the same config as local dev. Values are piped straight to the Vercel
 * CLI over stdin — they are never printed, logged, or passed as argv.
 *
 * Prereqs (one time):
 *   npm i -g vercel
 *   vercel login
 *   vercel link          # pick the klovered-free project
 *
 * Usage:
 *   node scripts/vercel-env-import.mjs               # production (default)
 *   node scripts/vercel-env-import.mjs preview       # or: development
 *   node scripts/vercel-env-import.mjs production --overwrite
 *
 * NEXT_PUBLIC_* are inlined at build time, so a redeploy is required after an
 * import for those to take effect (server-only vars apply on the next request).
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const target = process.argv.find((a) => ["production", "preview", "development"].includes(a)) || "production";
const overwrite = process.argv.includes("--overwrite");

let raw;
try {
  raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
} catch {
  console.error("No .env.local found next to the project root. Create it first (see .env.example).");
  process.exit(1);
}

const vars = raw
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#") && l.includes("="))
  .map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  })
  // Skip empties and the CLI's own local artifacts (`vercel link` appends
  // VERCEL_OIDC_TOKEN to .env.local; it's local-dev-only and must not be
  // uploaded as project env).
  .filter(([k, v]) => v !== "" && !k.startsWith("VERCEL_"));

if (vars.length === 0) {
  console.error(".env.local has no non-empty KEY=value lines.");
  process.exit(1);
}

// On Windows the CLI is a .cmd shim, which Node refuses to spawn without a
// shell (CVE-2024-27980 hardening) — route through the shell there. Keys are
// validated identifiers and values go over STDIN, so nothing user-controlled
// is interpolated into the command line.
// Prefer a global `vercel`; fall back to npx (which is how most people have
// it). Probed once up front so per-var failures are real errors, not PATH noise.
const spawnOpts = process.platform === "win32" ? { shell: true } : {};
const hasGlobal =
  spawnSync("vercel", ["--version"], { stdio: "ignore", ...spawnOpts }).status === 0;
const vercelCmd = hasGlobal ? ["vercel"] : ["npx", "--yes", "vercel"];
const vercel = vercelCmd[0];
const baseArgs = vercelCmd.slice(1);
const keyOk = (k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
console.log(`Importing ${vars.length} vars into Vercel [${target}]${overwrite ? " (overwrite)" : ""}...\n`);

let ok = 0;
let failed = 0;
for (const [key, value] of vars) {
  if (!keyOk(key)) {
    console.log(`  ✗ ${key} — skipped (not a valid env identifier)`);
    failed++;
    continue;
  }
  if (overwrite) {
    // `env rm` is a no-op-safe cleanup; ignore "not found".
    spawnSync(vercel, [...baseArgs, "env", "rm", key, target, "--yes"], { stdio: "ignore", ...spawnOpts });
  }
  const res = spawnSync(vercel, [...baseArgs, "env", "add", key, target], {
    input: value + "\n",
    encoding: "utf8",
    ...spawnOpts,
  });
  const out = (res.stdout || "") + (res.stderr || "");
  if (res.status === 0) {
    console.log(`  ✓ ${key}`);
    ok++;
  } else if (/already exists/i.test(out)) {
    console.log(`  = ${key} (exists — rerun with --overwrite to replace)`);
  } else {
    console.log(`  ✗ ${key} — ${out.trim().split("\n").pop()}`);
    failed++;
  }
}

console.log(`\nDone: ${ok} set, ${failed} failed. Redeploy to apply NEXT_PUBLIC_* changes.`);
process.exit(failed ? 1 : 0);
