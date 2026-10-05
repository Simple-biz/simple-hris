# Onboarding Gmail Surname

> **Status:** Built and **live**. Migration #81 is **APPLIED** — verified
> against production 2026-08-11 by `scripts/audit-pending-migrations.mts`
> ([probe](../audits/2026-08-11-pending-migrations-probe.md)).

The public onboarding paperwork shows a **read-only, auto-derived "Gmail
Surname"**: the minimal last-name slice that makes `<first><slice>@simple.biz`
unique against the live roster, UPPER-cased. When HR mints the work email, this
slice is sent to the workspace-account webhook **in place of the legal surname**
on purpose — so the hire's full last name is never baked into a lookup-able
`@simple.biz` Google account.

---

## What the hire sees

On **Step 1 / Welcome** of the wizard
([`app/onboarding/[token]/page.tsx`](../../app/onboarding/[token]/page.tsx)) a
`Gmail Surname` field sits below `First name` / `Last name`. It is
**`readOnly`** (`tabIndex={-1}`, `aria-readonly`), rendered in a mono font, and
carries the helper copy: *"Auto-generated surname for your @simple.biz Google
account (for privacy, it's not your full last name). If your initials are
already in use, extra letters are added automatically to keep it unique."*

While the lookup is in flight, an inline **"Searching Google Workspace…"**
spinner (emerald) sits in the right edge of the field, driven by a
`surnameLoading` state.

---

## The derivation rule

It mirrors the work-email minting rule in
[`src/lib/hr/work-email.ts`](../../src/lib/hr/work-email.ts): the local part is
`<first><progressive last-name slice>`. The slice starts at one letter and
lengthens until `<first><slice>@simple.biz` is free on the roster.

| Hire | Roster state | Address | Gmail Surname |
|---|---|---|---|
| Kane Reroma (first to join) | `kaner` free | `kaner@…` | `R` |
| Kane Reiner (later) | `kaner` taken | `kanere@…` | `RE` |
| Kane Resma (later still) | `kaner`, `kanere` taken | `kaneres@…` | `RES` |

The surname returned is **only the slice** (local part with the first-name
prefix removed), UPPER-cased — the roster's actual addresses are never exposed.

### Client-side flow (debounced, always-on)

An effect keyed on `[form.first_name, form.last_name, token]` does the work:

1. Computes a **fallback** = the last-name **initial only** (NFD-folded to ASCII,
   non-letters stripped, upper-cased). Never the full surname.
2. If either name is blank → clears the field and stops.
3. **RULE: always generate a surname.** It seeds the field with the fallback
   initial immediately (so the field is never blank and never shows a stale
   value from a previous name), sets `surnameLoading`, then after a **300 ms
   debounce** POSTs `{ first, last }` to the endpoint below.
4. On a successful response with a non-empty `gmail_surname`, it applies that
   collision-aware slice; otherwise it keeps the seeded initial. A failed/aborted
   request also falls back to the initial. Only the latest (non-superseded)
   request clears the spinner.

On submit, the form posts `gmail_surname: form.gmail_surname.trim() || null` to
`POST /api/onboarding/[token]`, which persists it via `submitHrOnboarding`
(stored as `gmail_surname` on the submission — see
[`src/lib/supabase/hr-onboarding-submissions.ts`](../../src/lib/supabase/hr-onboarding-submissions.ts)).
A re-opened submitted form prefills the field from `priorData.gmail_surname`.

---

## The endpoint

**`POST /api/onboarding/[token]/gmail-surname`**
([route](../../app/api/onboarding/[token]/gmail-surname/route.ts))

| | |
|---|---|
| Body | `{ first?: string; last?: string }` |
| Returns | `{ gmail_surname: string }` (the UPPER-cased slice, or `""` when a name is missing) |
| Runtime | `nodejs`, `force-dynamic` |

**Auth + scope:**

- A **real onboarding token** is gated by its submission row. `pending` /
  `submitted` rows pass; an `archived` link returns **409**; an unknown token
  returns **404**.
- The HR-facing **`/onboarding/preview`** path has no submission row, so when
  `token === "preview"` it is gated by **`requireElevatedSession()`** instead.
  This is deliberate: preview must be roster-accurate and **collision-aware**, or
  it could only guess the bare initial.

**Why `loadTakenWorkEmails`, not `suggestWorkEmail`:** the route walks
`workEmailCandidates(first, last)` (progressive slices, no numeric fallback)
against the taken set and picks the first free candidate, falling back to the
**longest slice** (full surname, no digit) if every slice collides. It avoids
`suggestWorkEmail` on purpose — that helper's numeric fallback (e.g.
`kanereiner2`) would leak the **full** surname plus a digit into the Google
account, the opposite of the privacy goal.

A re-submission's own already-minted address is **deleted from the taken set**
(`taken.delete(self)`) so the slice doesn't needlessly lengthen against itself.

---

## What HR sends to the webhook

When HR mints the work email
([`POST /api/hr/onboarding-submissions/[id]/set-work-email`](../../app/api/hr/onboarding-submissions/[id]/set-work-email/route.ts)),
the **Gmail Surname is sent as `lastName` to `createWorkspaceAccount`** instead
of the legal last name:

```ts
const gmailSurname =
  (row.gmail_surname ?? "").trim() || (last ? last.charAt(0).toUpperCase() : "");
```

So the provisioned `@simple.biz` Google account carries the disambiguating slice
(`R`, `RE`, …) as its surname, not the hire's real last name. The **fallback for
a blank/legacy row is the last-name initial only** — never the full surname. The
chosen value is recorded in the audit log (`gmail_surname` in the
`hr.onboarding.set_work_email` entry).

---

## An address that has belonged to someone is never re-issued (`loadWorkEmailReservations`)

**Kane, 2026-10-05 (audit item 344): an address that has ever been on someone's
record is never minted again.** This **replaces** HR's earlier rule that an
off-boarded master row frees its address for recycling (in force from 2026-07 to
2026-10-05). Payroll keys a person by work email in `employee_ids` (bank and
wallet), the rates history (rate and paystub address) and Hubstaff. None of those
tables knows about stints, and `global_master_list` enforces
`(Work Email, Department)` unique. So a recycled address is either refused at
promote or merged into the previous holder's identity.

On 2026-09-26, five Lead Gen hires were minted a recycled same-department
address (`johnt@`, `justinem@`, `maryt@`, `marial@`, `marief@`). All five are
`failed_to_promote` and invisible on every surface. Their first pay would have
gone to the previous holder's Hurupay wallet.

[`src/lib/hr/work-email-server.ts`](../../src/lib/hr/work-email-server.ts) reads six
sources and hands them to the pure
[`buildWorkEmailReservations`](../../src/lib/hr/work-email-reservations.ts):

| Source | Class |
|---|---|
| `global_master_list`: **every** row, active or off-boarded, all three email columns | on record |
| `employee_ids` | on record |
| `employee_roles` (non-revoked) | on record |
| `offboarded_sheet` (the leaver ledger, which keeps addresses whose master row was deleted) | on record |
| `employee_hourly_rates_current` (one row per work email ever rated) | on record |
| `hr_pending_employees` in `pending_work_email` / `ready` / `failed_to_promote` | claimed |

`taken` = on record ∪ claimed. **Only a pure claim is reclaimable** when the
verify webhook reports its Workspace account missing
(`mayReclaimWhenWorkspaceMissing`; see `workspace-account-verify.md`).
Off-boarding deletes the Google account, so "missing" proves nothing about a
leaver's address.

`failed_to_promote` was missing from the in-flight statuses until 2026-10-05, so a
hire whose promote failed did not hold their own address.

**Every route that writes a work email runs one gate:** `workEmailIssueDenial`
(`work-email-server.ts`). The routes are `set-work-email` and
`PATCH /api/hr/pending-employees/[id]`. Before 2026-10-05 the PATCH route wrote
any address unchecked. Keeping the hire's current address always passes. The
PATCH also refuses a change on a hire already linked to a master row
(`promoted_to_master_id`), because that would leave the master row, the Sheet and
payroll on the old address.

**The way out for a hire stuck on a recycled address** is HR → Onboarding →
**Failed**. A `failed_to_promote` row with no master row now shows **Edit**. Saving a
fresh address there creates a new Workspace account and Hubstaff invite for it
(the PATCH route's combined webhook), and then **Retry** promotes onto a fresh
master row. Their onboarding submissions are archived, so `set-work-email` cannot
be used for them.

**Measured 2026-10-05:** the taken set went from **1,425** to **5,243** addresses,
which newly reserves **3,389** @simple.biz addresses that used to be offered.
Expect longer suggestions and longer Gmail-surname slices for common names; this
is the accepted cost. For the five above, the suggester now offers
`johnmarkt@`, `justinerajahm@`, `maryangeliet@`, `mariarhonal@` and
`mariestephanief@`.

Every source is read through `selectAllPaged` on a total order, and **every read
throws on an error** (2026-09-25, item 227). `employee_ids` had been one capped read
(1,000 of 2,072 addresses), which left **3** addresses held only there mintable
again. A failed read used to be skipped, which shrank the set with no signal. All
three callers (Suggest, Set work email, the Gmail-surname step) turn the throw
into a 500. Pinned by `src/lib/hr/work-email-reservations.test.ts`.

> **Superseded 2026-10-05.** The recycling rule computed
> `freed = off-boarded − active` from the master list and dropped those addresses
> from the `employee_ids` and `employee_roles` passes too, so an off-boarded
> person's address was offered again. That `freed` set is what let `maryt@` reach
> a third holder.

---

## Migration (APPLIED)

> **Migration #81 — APPLIED** (verified against production 2026-08-11 by
> `scripts/audit-pending-migrations.mts`). It was:
> [`references/sql/alter/add_gmail_surname_to_onboarding.sql`](../../references/sql/alter/add_gmail_surname_to_onboarding.sql)
> — idempotent:
> `ALTER TABLE hr_onboarding_submissions ADD COLUMN IF NOT EXISTS gmail_surname TEXT`.

---

## Files

| Path | Role |
|---|---|
| [`app/api/onboarding/[token]/gmail-surname/route.ts`](../../app/api/onboarding/[token]/gmail-surname/route.ts) | Derives the collision-aware slice; token-row / preview-session auth |
| [`app/onboarding/[token]/page.tsx`](../../app/onboarding/[token]/page.tsx) | Read-only field, debounced effect, loading spinner, always-generate rule |
| [`src/lib/hr/work-email.ts`](../../src/lib/hr/work-email.ts) | `workEmailCandidates` / `normalizeNamePart` — the minting rule |
| [`src/lib/hr/work-email-server.ts`](../../src/lib/hr/work-email-server.ts) | `loadWorkEmailReservations` / `loadTakenWorkEmails` (six sources, read in full) |
| [`src/lib/hr/work-email-reservations.ts`](../../src/lib/hr/work-email-reservations.ts) | `buildWorkEmailReservations` + `mayReclaimWhenWorkspaceMissing`: never re-issue an address on record (2026-10-05) |
| [`app/api/hr/onboarding-submissions/[id]/set-work-email/route.ts`](../../app/api/hr/onboarding-submissions/[id]/set-work-email/route.ts) | Sends Gmail Surname as `lastName` to the workspace webhook |
| [`app/api/onboarding/[token]/route.ts`](../../app/api/onboarding/[token]/route.ts) | Persists `gmail_surname` on submit; returns it in `priorData` |
| [`src/lib/supabase/hr-onboarding-submissions.ts`](../../src/lib/supabase/hr-onboarding-submissions.ts) | Row type + `gmail_surname` write |
| [`references/sql/alter/add_gmail_surname_to_onboarding.sql`](../../references/sql/alter/add_gmail_surname_to_onboarding.sql) | Migration #81 — **APPLIED** (verified 2026-08-11) |
