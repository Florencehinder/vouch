# JobScout — Build Plan

## Goal

A personal job-tracking web app that pulls companies + warm contacts from a Google Sheet, discovers new openings at those companies daily, filters for relevant roles (PM, DS/FDE, TPM, Program Manager), and surfaces matches in a UI plus a daily email digest with referral context.

Single user. No multi-tenancy. No public surface.

## Architecture decisions

**Stack:** Next.js 14 (App Router) + TypeScript + Supabase (Postgres + Auth) + Vercel (hosting + cron) + Resend (email).

- Skipping Hetzner-style VPS for this one — Vercel cron + Supabase covers everything for a personal tool with daily runs.
- Resend matches the Flexsta pattern.
- Service-account auth for Google Sheets (no OAuth flow needed for a single-user tool).

**ATS-first, scrape-last.** Don't write a generic HTML scraper as the primary path — it will break constantly. Most target companies use one of these, all with public/unauthenticated job feeds:

| ATS | Endpoint pattern |
|---|---|
| Greenhouse | `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` |
| Lever | `https://api.lever.co/v0/postings/{slug}?mode=json` |
| Ashby | `https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true` |
| SmartRecruiters | `https://api.smartrecruiters.com/v1/companies/{slug}/postings` |
| Workday | Per-tenant. Defer until forced. |

The careers URL itself usually tells you the ATS (`boards.greenhouse.io/anthropic` → Greenhouse, slug `anthropic`). Build an `ats-detect` step that resolves a company's careers URL once and caches `ats_provider` + `ats_slug` on the company row. Playwright fallback exists only for companies whose careers page isn't on a known ATS.

**Sheet as input, Postgres as state.** Google Sheet is the editable source of truth for companies + contacts. Everything else (jobs, matches, run logs, triage status) lives in Postgres. Sync runs idempotently.

## Data model

```sql
create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  careers_url text,
  ats_provider text,            -- 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'workday' | 'scrape' | null
  ats_slug text,
  priority text,                -- 'high' | 'medium' | 'low' from sheet
  notes text,
  last_synced_at timestamptz,
  last_scraped_at timestamptz,
  created_at timestamptz default now()
);

create table contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  name text not null,
  role text,
  relationship_strength text,   -- 'strong' | 'medium' | 'weak'
  contact_method text,          -- 'email:...' | 'linkedin:...' | 'whatsapp:...'
  notes text,
  created_at timestamptz default now(),
  unique (company_id, name)
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  external_id text not null,    -- ATS job ID, or URL hash for scraped
  title text not null,
  location text,
  url text not null,
  description_text text,        -- stripped to plaintext on insert
  posted_at timestamptz,
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz default now(),
  is_open boolean default true,
  unique (company_id, external_id)
);

create table job_matches (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references jobs(id) on delete cascade unique,
  matched_role_category text,   -- 'pm' | 'ds_fde' | 'tpm' | 'program_mgr' | 'other'
  match_score numeric,           -- Haiku confidence 0-1
  classification_version text,   -- bump when prompt changes to invalidate cache
  classification_reasoning text, -- one-sentence reason from Haiku
  status text default 'new',     -- 'new' | 'interested' | 'applied' | 'interviewing' | 'passed' | 'archived'
  user_notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  kind text,                    -- 'sheet_sync' | 'job_discover' | 'digest_email'
  started_at timestamptz default now(),
  finished_at timestamptz,
  status text,                  -- 'ok' | 'error' | 'partial'
  stats jsonb,
  error text
);

create index on jobs (company_id, is_open);
create index on job_matches (status, created_at desc);
```

## Google Sheet schema

Two tabs.

**Tab `companies`:** `name`, `careers_url`, `priority`, `notes`

**Tab `contacts`:** `company_name`, `name`, `role`, `relationship_strength`, `contact_method`, `notes`

`company_name` in `contacts` joins to `name` in `companies`. Don't put ATS info in the sheet — the detector populates that.

## Repo structure

```
app/                          # Next.js routes (UI + API)
  api/cron/daily/route.ts     # Vercel cron entry
  jobs/page.tsx
  companies/page.tsx
  contacts/page.tsx
lib/
  supabase.ts
  sheets.ts
  ats/
    detect.ts
    greenhouse.ts
    lever.ts
    ashby.ts
    smartrecruiters.ts
    scrape.ts                 # Playwright fallback
  filter.ts
  digest.ts
  draft-referral.ts           # Claude API for referral message draft
scripts/
  run-sync.ts                 # CLI: sheet → DB
  run-discover.ts             # CLI: companies → jobs → matches
  run-digest.ts               # CLI: send digest email
supabase/
  migrations/0001_init.sql
PLAN.md
```

## Phases

Each phase ends with an explicit verification step. Don't move on until it's green. Don't bundle phases.

### Phase 0 — Skeleton

- `pnpm create next-app jobscout --ts --app --tailwind`
- `supabase init`, link to a new project, write `migrations/0001_init.sql` with the schema above, `supabase db push`.
- `.env.local`:
  ```
  SUPABASE_URL=
  SUPABASE_SERVICE_ROLE_KEY=
  SUPABASE_ANON_KEY=
  GOOGLE_SHEETS_ID=
  GOOGLE_SERVICE_ACCOUNT_JSON=   # base64 of the JSON key
  RESEND_API_KEY=
  DIGEST_TO_EMAIL=
  ANTHROPIC_API_KEY=
  CRON_SECRET=                   # to gate /api/cron/* from public hits
  ```
- Add `lib/supabase.ts` with both anon and service-role clients.
- **Verify:** Migration applies cleanly, `pnpm dev` boots, Supabase tables exist.

### Phase 1 — Sheet sync

- `googleapis` package, service-account auth (share the sheet with the SA email).
- `lib/sheets.ts`: read both tabs, return typed `CompanyRow[]` and `ContactRow[]`.
- `scripts/run-sync.ts`:
  - Upsert companies on `name`.
  - Upsert contacts on `(company_id, name)`.
  - Mark contacts not present in sheet as deleted (soft delete with a `deleted_at` column, or hard delete — pick one and log it). Recommend hard delete; the sheet is canonical.
  - Write a row to `runs` with stats `{ companies_upserted, contacts_upserted, contacts_deleted }`.
- **Verify:** Put 3 companies + 5 contacts in the sheet, run `pnpm tsx scripts/run-sync.ts`, see them in Supabase. Edit a row, re-run, confirm update lands.

### Phase 2 — ATS detection + adapters

- `lib/ats/detect.ts`: given `careers_url`, return `{ provider, slug } | { provider: 'scrape' }`. Rules:
  - Host contains `greenhouse.io` → greenhouse, slug = first path segment.
  - Host contains `lever.co` → lever, slug = first path segment.
  - Host contains `ashbyhq.com` → ashby.
  - Host contains `smartrecruiters.com` → smartrecruiters.
  - Host contains `myworkdayjobs.com` → workday (don't implement adapter yet, store provider but skip discovery).
  - Otherwise: fetch the HTML and check for embedded ATS iframes/scripts (Greenhouse and Lever embed via known script tags). If matched, use that ATS. Else mark `scrape`.
- One adapter per ATS: `fetchJobs(slug): Promise<NormalizedJob[]>` returning:
  ```ts
  type NormalizedJob = {
    external_id: string;
    title: string;
    location: string | null;
    url: string;
    description_text: string;     // stripped to plaintext
    posted_at: Date | null;
  };
  ```
- After first detection, write `ats_provider` + `ats_slug` back to the company row.
- **Verify:** For each adapter, hit one real public board (Anthropic on Greenhouse, a Lever company, etc.) and log the count + a sample. No DB writes yet.

### Phase 3 — Discovery + storage

- `scripts/run-discover.ts`:
  - For each company with a known ATS provider, call its adapter.
  - Upsert jobs on `(company_id, external_id)`. Set `last_seen_at = now()`.
  - For jobs in DB belonging to this company that weren't returned this run, set `is_open = false`.
  - Strip HTML → plaintext before storing `description_text`.
  - Log to `runs`.
- Don't build the Playwright scraper yet. Wait until you hit your first non-ATS company. When you do: respect `robots.txt`, add 2s delay between requests, hash `(url, normalised_title)` for `external_id`.
- **Verify:** Run discover. Open the `jobs` table, see a meaningful count per company. Re-run; counts should be stable, `last_seen_at` updated, no duplicates.

### Phase 4 — Role filter (Haiku on JD)

Title-only matching is too lossy: "Solutions Engineer" can be a presales SaaS rep or a deeply technical FDE; "Implementation Manager" can be DS-flavoured or a glorified admin job. Use Haiku 4.5 to read the actual JD.

**Two steps:**

**1. Cheap title exclude** — drop obviously-out-of-scope titles before paying for an LLM call. This is an exclude-only filter, not an include filter. If in doubt, pass to step 2.

```ts
const HARD_EXCLUDE = /\b(accountant|payroll|bookkeeper|recruiter|talent\s+(acquisition|partner|sourcer)|hr\s+(business|partner|generalist)|legal\s+counsel|paralegal|marketing\s+(manager|director|specialist|coordinator)|sales\s+(rep|representative|director|executive|development)|account\s+executive|customer\s+success|software\s+engineer\s+(i{1,3}|junior|senior|staff|principal)?\s*$|backend\s+engineer|frontend\s+engineer|data\s+scientist|machine\s+learning\s+engineer|ux\s+designer|graphic\s+designer|copywriter|content\s+writer|janitor|warehouse|driver)\b/i;
```

Also exclude jobs in locations you'd never accept (set this from the sheet — e.g. require London, remote-UK/EU, or NZ in the location string).

**2. Haiku classification** — for everything not excluded, call `claude-haiku-4-5` with the title, company, location, and JD. Strict JSON out.

```ts
const CLASSIFICATION_VERSION = "v1";

const SYSTEM = `You are screening job postings for a candidate targeting these roles:
- Product Manager (Senior, Group, Principal, Head of Product, CPO)
- Deployment Strategist / Forward Deployed Engineer / Solutions Engineer or Architect / Customer Engineer / GTM Engineer / Applied AI Engineer
- Technical Program Manager (TPM)
- Program Manager / Programme Manager

Reject if the role is:
- Product Marketing, Product Ops, Product Design
- Engineering Manager (managing engineers, not products)
- Sales-only, Marketing, Customer Success, Account Management, Recruiting, HR, Finance, Legal
- Pure backend/infra software engineering with no embedded or customer-facing element

Be generous on customer-facing technical roles — those are exactly what the candidate wants. Be strict on roles that just have "product" or "manager" in the title without product ownership or technical customer work.

Reply with ONLY valid JSON, no preamble or backticks:
{"category": "pm" | "ds_fde" | "tpm" | "program_mgr" | "none", "confidence": 0.0-1.0, "reasoning": "one sentence"}`;

const userMsg = `Title: ${job.title}
Company: ${company.name}
Location: ${job.location ?? "n/a"}

Description:
${job.description_text.slice(0, 8000)}`;  // cap input to keep cost predictable
```

Settings: `temperature: 0`, `max_tokens: 200`. Parse defensively — strip stray backticks, retry once on JSON parse fail, log and skip on second fail.

**3. Upsert a `job_matches` row for every classification, including `"none"`.** This is what stops Haiku from re-reading the same JD on every run. The unique constraint on `job_id` makes the insert an upsert. Store `classification_version`, `match_score = confidence`, the reasoning, and the category — even when the category is `"none"`. The UI and digest filter `matched_role_category != 'none' AND match_score >= 0.6` at query time — not at insert time. The mental model: `job_matches` records "Haiku has looked at this job"; the filter to actual matches happens on read.

**Skip logic.** Each discover run only classifies jobs that genuinely need it:

```sql
SELECT j.*
FROM jobs j
LEFT JOIN job_matches m ON m.job_id = j.id
WHERE j.is_open = true
  AND (m.id IS NULL OR m.classification_version != $CURRENT_VERSION);
```

This is the only query that drives Haiku calls. If a job has been classified at the current version (whether the result was a match or `"none"`), it is skipped on every subsequent run. Forever, until the version bumps.

**Prompt iteration.** When you change the system prompt, bump `CLASSIFICATION_VERSION`. On the next run, do this *before* classifying:

```sql
DELETE FROM job_matches WHERE classification_version != $CURRENT_VERSION;
```

Then the skip-logic query above sweeps everything back up for reclassification. Delete-then-reinsert (rather than update-in-place) means `created_at` refreshes for reclassified jobs — so a job that flips from `"none"` to a match after a prompt tweak correctly appears in the next daily digest as new.

**Cost sanity check.** Haiku 4.5 is ~$1/MTok input, ~$5/MTok output. A JD ≈ 2–4k input tokens; output ≈ 100 tokens.
- Initial backfill ~1000 jobs across all companies: ~$3 one-off.
- Steady state ~30 new jobs/day: ~$0.10/day, ~$3/month.
- Full reclassify after a prompt change: ~$3.

Negligible. Don't over-optimise — but the skip logic above is doing the work so a steady-state daily run only pays for genuinely new postings.

- **Verify:** Run discover twice in a row. The second run should make zero Haiku calls (log the count). If it makes any, the skip query is wrong. Then bump `CLASSIFICATION_VERSION` and run again — every job should reclassify.

### Phase 5 — Daily cron + digest email

- `vercel.json`:
  ```json
  { "crons": [{ "path": "/api/cron/daily", "schedule": "0 7 * * *" }] }
  ```
  (07:00 UTC. Adjust if you want UK morning year-round.)
- `/api/cron/daily/route.ts`: header check against `CRON_SECRET`, then runs sheet_sync → discover → filter → digest in sequence. Each step writes its own `runs` row.
- `lib/digest.ts`: query `job_matches` with `matched_role_category != 'none' AND match_score >= 0.6 AND status='new' AND created_at > (last successful digest_email run finished_at)`. Group by company. For each company, include linked contacts (name, relationship strength, contact method).
- Resend HTML email with sections: company → jobs (title + location + link), then contacts list ("People you know here").
- **Verify:** Curl `/api/cron/daily` with the secret, confirm email arrives, confirm grouping correct, confirm second run produces an empty/skipped digest (idempotent).

### Phase 6 — Web UI

- Auth: Supabase magic link, restrict to your email via Postgres RLS or an allow-list check in middleware.
- `/` (jobs):
  - Default view: matches with `status='new'`, sorted by `created_at desc`.
  - Filters: status, role category, company, has-contact-at-company.
  - Columns: company, title, location, posted_at, # contacts at company (badge), status dropdown, "Open" link.
  - Status edits write back to `job_matches`.
- `/companies`: name, ATS provider, last scraped, # open jobs, # matches in last 30 days.
- `/contacts`: read-only mirror of the sheet. Editing instructions: "edit the Google Sheet."
- Per-match action: "Draft referral message" → modal calling `lib/draft-referral.ts`, which sends Claude a prompt with contact relationship strength + job description + your one-paragraph background. Output goes into a copyable textarea. No auto-send.
- **Verify:** You can triage a day's matches in <5 minutes from the UI without touching the DB.

### Phase 7 — Optional polish

- Slack webhook as alternative to email digest.
- Auto-archive matches older than 30 days with no status change.
- Per-job TL;DR generated by Claude on first view, cached on the row.
- iOS home-screen pin for one-tap triage.
- Workday adapter (only if a target company is on Workday and you can't replace the inbound).

## Pitfalls

- **Don't scrape Workday until forced.** Tenant-specific URLs, session-bound JSON API. If you must, look at the `wd1.myworkdayjobs.com/wday/cxs/.../jobs` POST endpoint, but expect it to fight you.
- **Title regex is for excluding, not including.** Don't try to write include patterns — Haiku reads the JD and decides. The exclude list exists only to avoid paying $0.003 to classify an Accountant role. Be liberal with excludes (clearly off-topic only); when in doubt, let Haiku see it.
- **Bump `CLASSIFICATION_VERSION` whenever the prompt changes**, otherwise old classifications stick around and you'll be confused by stale reasoning text in the UI.
- **Don't store raw HTML.** Strip to plaintext on insert. Keeps storage low and LLM calls cheap.
- **Daily is the right cadence.** Faster polling annoys ATS providers and gets you nothing.
- **Make sheet→DB sync idempotent.** Run as often as you want. Cron does it daily; you should be able to fire it manually after any sheet edit and have it converge.
- **Cap Claude calls.** Borderline-title classification + referral drafts only. Don't summarise every job description until Phase 7.

## Definition of done for v1

- Add a row to the sheet, wait one day, see new matching jobs in the UI and an email containing them with the names of people you know at that company.
- Daily triage time: under 5 minutes.
- Adding a new ATS adapter: under 30 minutes.

## Hand-off instruction for Claude Code

Open the repo and tell Claude Code:

> Read `PLAN.md`. Implement Phase 0 only. Stop after the verification step and show me before moving on.

Then iterate phase-by-phase. Don't let it stitch phases together — the per-phase verification exists because each phase has a way to silently half-work and that's hardest to debug after three more layers go on top.
