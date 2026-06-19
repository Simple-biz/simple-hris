# Onboarding Pay Plans

> **Status:** Requires **PENDING migration #80** (two files) before it works in
> production — see [Pending migrations](#pending-migrations).

HR uploads **one pay-plan PDF per (Department, Country)** from a "Pay Plans" modal on
the HR Onboarding Form. When HR generates an onboarding link and picks that
Department + Country, the matching plan **rides the onboarding INVITE email** (not a
submission webhook) — as an in-email download card next to the W-8BEN card and as an
entry in the webhook's `attachments[]` for n8n to fetch. Best-effort: a missing or
unmatched plan never blocks sending the invite.

---

## Storage model

Each plan is one row in `onboarding_pay_plans` plus one PDF object. The PDF reuses the
existing private **`hr-onboarding-files`** Storage bucket (`HR_ONBOARDING_BUCKET`) at
**`pay-plans/<id>.pdf`** — the row only holds metadata + the storage path. There is
**one plan per (department, country)** pair; re-uploading the same pair **replaces in
place**.

`src/lib/supabase/onboarding-pay-plans.ts` is the data layer:

| Function | Role |
|---|---|
| `listOnboardingPayPlans()` | All rows, ordered by department then country |
| `getOnboardingPayPlanById(id)` | Single row |
| `findPayPlanForDeptCountry(dept, country)` | Normalized lookup of the plan for a pair (returns `null` when none) |
| `upsertOnboardingPayPlan({…})` | Upload or replace; reuses the existing row id + path so there's only ever one object per pair |
| `deleteOnboardingPayPlan(id)` | Best-effort remove of the storage object, then the row |
| `getPayPlanSignedUrl(path, ttl=600)` | Signed URL on the private bucket (HR preview + the emailed download link) |

### Normalized matching

Department and country are matched **in code**, not by exact string, so spelling
variants resolve to the same plan:

- **Department** — `deptMatchKey()` runs the value through `normalizeDeptToKey()`
  (`src/lib/payroll/normalize-dept-key.ts`), falling back to trimmed/lower-cased raw.
- **Country** — `countryMatchKey()` runs the value through
  `resolveOnboardingCountry()` (`src/lib/onboarding/countries.ts`), which maps aliases
  (`USA`, `Columbia` misspelling, `PH`, `CO`, …) onto the three canonical names —
  **United States** (USD), **Philippines** (PHP), **Colombia** (COP). On upsert the
  **canonical** country name is stored so the list reads cleanly; matching stays
  normalized on read.

`upsertOnboardingPayPlan` reuses `existing?.id` and `existing?.file_path` when a plan
already exists for the pair, uploads with `upsert: true`, then `UPDATE`s (existing) or
`INSERT`s (new) the metadata row. So a replace overwrites the same `pay-plans/<id>.pdf`
object — no orphans.

---

## HR config UI

The **`PayPlansDialog`** modal in `src/components/hr/HrOnboardingForm.tsx` (opened from
a "Pay Plans" button beside the licenses meter) lists existing plans and offers an
upload form: a `DepartmentSelect` (from `/api/departments`), a `CountrySelect` (the
three countries), and a PDF picker (PDF-only, ≤10 MB, validated client-side). A
**"replacing existing"** hint appears when the chosen pair already has a plan. The list
shows a signed-URL preview/download per row and a delete with confirm.

---

## API routes

All routes are `runtime = "nodejs"`, `dynamic = "force-dynamic"`, and gated by the
**HR onboarding** feature permission (admin bypasses).

| Route | Auth | Behaviour |
|---|---|---|
| `GET /api/hr/pay-plans` | `requireFeatureAccess('hr','onboarding','view')` | Lists every plan, each with a short-lived (10 min) `download_url` signed URL |
| `POST /api/hr/pay-plans` | `requireFeatureEdit('hr','onboarding')` | `multipart/form-data` (`file`, `department`, `country`). Validates: department required, country must `resolveOnboardingCountry` to one of the three, file present + non-empty + ≤10 MB + PDF (by type **or** `.pdf` extension). Upserts, stamps `uploaded_by` from the session |
| `DELETE /api/hr/pay-plans/[id]` | `requireFeatureEdit('hr','onboarding')` | Removes the storage object + row |

`POST` is defined in `app/api/hr/pay-plans/route.ts`; `DELETE` in
`app/api/hr/pay-plans/[id]/route.ts`.

---

## Delivery: the invite email (the live path)

> **The plan ships with the onboarding INVITE, not on submission.** An earlier design
> fired an `onboarding_pay_plan` webhook at submit time (`src/lib/onboarding/send-pay-plan.ts`);
> both were **removed**. That stale path still shows up in a comment header inside
> `create_onboarding_pay_plans.sql` — ignore it. The real path is below.

`invite_country` is captured when HR generates a link. The generate-link dialog gained
a **Country picker** whose value is sent as `invite_country` on
`POST /api/hr/onboarding-submissions` (single and bulk; in bulk each pasted row carries
its own country so a mixed batch emails each hire the right plan).

`POST /api/hr/onboarding-submissions/[id]/send`
(`app/api/hr/onboarding-submissions/[id]/send/route.ts`) resolves the plan and attaches
it to the invite:

1. After minting a fresh token and building the email, it calls
   `findPayPlanForDeptCountry(row.invite_department, row.invite_country)`.
2. If a plan matches, it signs a **~14-day** URL
   (`PAY_PLAN_SIGNED_URL_TTL = 60*60*24*14`) — long-lived because it sits in the hire's
   inbox — and derives `currency` via `currencyForCountry()`.
3. The plan is woven into three places of the webhook payload:
   - **`html`** — `renderOnboardingEmailHtml` draws a **pay-plan card** (navy "PDF"
     chip, filename, dept/country/currency line, "Download your pay plan →") directly
     below the W-8BEN card. The card renders only when a plan matched.
   - **`attachments[]`** — appended after the W-8BEN attachment (`{ url, filename,
     contentType, description }`) so n8n's HTTP Request node can fetch the binary and
     attach it.
   - **`pay_plan`** — a structured object (`url`, `file_name`, `content_type`,
     `department`, `country`, `currency`) or `null`.

**Best-effort end to end:** the entire resolve/sign block is wrapped in `try/catch`;
a blank/unmatched country or a signing failure yields `payPlan = null` and the invite
sends without a plan. The webhook itself is `onboarding_send` (resolved via
`resolveWebhookUrl`, slug `onboarding_send`, legacy key `hr.onboarding_webhook_url`).

---

## Data model

`onboarding_pay_plans` (one row per plan):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | Also names the storage object `pay-plans/<id>.pdf` |
| `department` | text | Human-facing dept name HR picked; matched normalized |
| `country` | text | Canonical country name (United States / Philippines / Colombia) |
| `file_path` | text | `pay-plans/<id>.pdf` |
| `file_name` | text | Original filename for display + attachment |
| `content_type` | text | `application/pdf` |
| `file_size` | bigint | Bytes |
| `uploaded_by` | text | Session email, lower-cased |
| `created_at` / `updated_at` | timestamptz | |

A unique index `onboarding_pay_plans_dept_country_uniq` on
`(lower(btrim(department)), lower(btrim(country)))` backstops the in-code de-dupe.

`hr_onboarding_submissions.invite_country` (text) holds HR's invite-time country choice.
It is **distinct** from the `country` column added by `add_country_to_onboarding.sql`:
`invite_country` drives the emailed pay plan (HR's pick), while `country` is what the
**hire** selects on the paperwork (drives currency).

---

## Pending migrations

> **Migration #80 — PENDING (two files).** The feature does not work in production until
> both run (Supabase SQL editor):
>
> - [`references/sql/create/create_onboarding_pay_plans.sql`](../../references/sql/create/create_onboarding_pay_plans.sql)
>   — creates the table + the dept/country unique index.
> - [`references/sql/alter/add_invite_country_to_onboarding.sql`](../../references/sql/alter/add_invite_country_to_onboarding.sql)
>   — `ALTER TABLE hr_onboarding_submissions ADD COLUMN IF NOT EXISTS invite_country TEXT`.

---

## Files

| Path | Role |
|---|---|
| [`src/lib/supabase/onboarding-pay-plans.ts`](../../src/lib/supabase/onboarding-pay-plans.ts) | Row type, list/find/upsert/delete, signed URL, normalized match keys |
| [`src/lib/onboarding/countries.ts`](../../src/lib/onboarding/countries.ts) | 3 canonical countries + currency + alias resolver |
| [`app/api/hr/pay-plans/route.ts`](../../app/api/hr/pay-plans/route.ts) | `GET` list (signed URLs) + `POST` upload/replace |
| [`app/api/hr/pay-plans/[id]/route.ts`](../../app/api/hr/pay-plans/[id]/route.ts) | `DELETE` a plan |
| [`app/api/hr/onboarding-submissions/[id]/send/route.ts`](../../app/api/hr/onboarding-submissions/[id]/send/route.ts) | Invite send: matches the plan, signs a 14-day URL, adds the email card + `attachments[]` + `pay_plan` |
| [`src/components/hr/HrOnboardingForm.tsx`](../../src/components/hr/HrOnboardingForm.tsx) | `PayPlansDialog` config modal + invite-dialog Country picker → `invite_country` |
| [`references/sql/create/create_onboarding_pay_plans.sql`](../../references/sql/create/create_onboarding_pay_plans.sql) | **PENDING** #80 file A |
| [`references/sql/alter/add_invite_country_to_onboarding.sql`](../../references/sql/alter/add_invite_country_to_onboarding.sql) | **PENDING** #80 file B |
