# Klovered Free

A public, no-login web tool that runs Klovered's core loop for anyone:

> Upload your company knowledge → upload an RFP → get AI-drafted, cited answers
> to every extracted requirement → export to `.docx`.

It's a go-to-market wedge: let people experience the magic moment for free, then
convert. Optional Google sign-in saves results beyond the anonymous window.

This is a standalone Next.js app that **vendors** the RAG pipeline from the main
`Propello` repo (`lib/`) and points at the **same Supabase project**. Every
visitor gets an anonymous `auth.users` row plus an auto-provisioned throwaway org
+ hidden deal, so all existing RLS and pipeline code run unchanged.

## Architecture

| Piece | What it does |
|---|---|
| `app/(pages)` | Linear 3-step flow: `/knowledge` → `/rfp` → `/answers`. No sidebar. |
| `components/PublicShell` | Slim top bar (wordmark → marketing site, step nav, Google sign-in), mounts the guest session once. |
| `app/api/session` | Idempotent anonymous-guest provisioning (org + hidden deal). Race-safe via a deterministic `guest-<user.id>` slug. |
| `app/api/knowledge*`, `app/api/documents*`, `app/api/answers`, `app/api/exports*` | Thin public wrappers over the vendored pipeline, guarded by `requireGuest()`. |
| `app/api/jobs/drain` | Pipeline stage driver (CRON_SECRET-gated). |
| `app/api/cron/cleanup` | 48h expiry of anonymous data (CRON_SECRET-gated). |
| `lib/`, `utils/` | Vendored verbatim from Propello. Copies stay byte-identical for a future shared-package extraction. |

## Environment variables

Copy from `Propello/.env.local` (same Supabase project + Mistral key), then set
the two URL vars. `.env.local`:

| Var | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Shared Supabase project URL. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase anon/publishable key (client + middleware). |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin client: guest provisioning, cleanup, storage. Server-only. |
| `MISTRAL_API_KEY` / `LLM_*` | AI provider is **Mistral**. Never add Anthropic/OpenAI SDKs. |
| `LLM_RPM`, `LLM_TPM`, `LLM_MAX_CONCURRENCY` (+ `_FAST`) | Pipeline throughput limits against Mistral. |
| `CRON_SECRET` | Shared secret for `/api/jobs/drain` and `/api/cron/cleanup`. |
| `NEXT_PUBLIC_MARKETING_URL` | Where the wordmark links (the landing site). |
| `NEXT_PUBLIC_SITE_URL` | This app's own origin (OAuth redirect base, cleanup script). |

## Manual Supabase dashboard setup (required)

The app talks to the shared Supabase project. Two provider toggles live in the
dashboard, not in code:

1. **Anonymous sign-ins** — Authentication → Sign In / Providers → enable
   *Anonymous sign-ins*. **Status: enabled** (the core loop depends on it).
2. **Google provider + manual identity linking** — required for the optional
   "Sign in to keep your work" upgrade (`linkIdentity`). In Authentication:
   - Enable the **Google** provider and add its OAuth client ID/secret.
   - Enable **manual linking** (Authentication → settings).
   - Add this app's `${NEXT_PUBLIC_SITE_URL}/api/auth/callback` to the allowed
     redirect URLs.
   **Status: NOT yet enabled** — the button ships and is wired, but the OAuth
   round-trip stays inert until Google is turned on. Anonymous usage is
   unaffected.

## Guardrails (verified)

| Limit | Value | Enforced in |
|---|---|---|
| Knowledge docs per guest org | 10 → `403` | `api/knowledge/upload` |
| Total pages per guest org | 200 → `403` | `api/knowledge/upload` |
| Knowledge uploads | 20 / hr per org → `429` | `api/knowledge/upload` |
| RFPs per session | 1 → `403` | `api/documents/upload` |
| New guest sessions | 10 / hr per IP → `429` | `api/session` |
| File size | 50 MB, `pdf`/`docx`/`txt` | upload routes |
| Anonymous data lifetime | 48 h (signed-in exempt) | `api/cron/cleanup` |

Isolation is enforced by the same org-scoped RLS that protects real customers: a
guest can never read another guest's uploads, documents, or answers. This is the
#1 correctness property and is covered by the limits/isolation test.

## The cleanup scheduler

`/api/cron/cleanup` purges guest orgs older than 48 h whose members are all still
anonymous (Google-upgraded orgs are exempt): storage objects first, then the org
row (FK cascade clears every child table), then the anonymous auth users. It is
**not self-scheduling** — wire a scheduler to POST it hourly with the
`x-cron-secret` header (pg_cron, a GitHub Action, or Vercel cron). Manual/CI
trigger:

```bash
node scripts/cleanup.mjs
```

## Development

```bash
npm install
npm run dev   # http://localhost:3100
```

## Model / execution split

Per the design spec (§9): the security-sensitive core (anonymous auth +
throwaway-org provisioning + RLS isolation, vendored-pipeline wiring) and the
guest cleanup were built and verified on Opus; the UI porting (knowledge/RFP/
answers screens) followed the same spec. The pipeline itself is unchanged
vendored code from Propello.

## Known notes

- A `NO_SOURCE` marker can leak into an answer's text in rare cases. This is
  vendored-pipeline behavior (copied byte-identical from Propello); fix it in the
  shared lib, not here, to keep the vendored copies in sync.
- The in-process rate limiter (`lib/rate-limit.ts`) is per warm instance. For
  hard multi-instance guarantees, move it to Postgres/Redis.
