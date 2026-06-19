# Onboarding Gmail Surname

> **Status:** Built. Requires **PENDING migration #81** before it persists in
> production — see [Pending migration](#pending-migration).

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

## Roster recycling fix (`loadTakenWorkEmails`)

[`src/lib/hr/work-email-server.ts`](../../src/lib/hr/work-email-server.ts) builds
the taken-address set from four sources: `global_master_list` (active rows,
including both Alternate Work Email columns), `employee_ids`, `employee_roles`
(non-revoked), and in-flight `hr_pending_employees` (`pending_work_email` /
`ready`). Off-boarded master rows are **recyclable** (per HR) and are not
reserved.

The fix makes recycling **consistent across tables**: it tracks
`activeEmails` vs `offboardedEmails` from the master list, computes
`freed = offboarded − active`, and **drops freed addresses from the
`employee_ids` and `employee_roles` passes** too. Without this, an off-boarded
person's address would linger forever in those flag-less tables and stay
reserved — so a recycled address could not be re-minted (and the Gmail-surname
slice would needlessly lengthen around a ghost).

---

## Pending migration

> **Migration #81 — PENDING** as of 2026-06-19. The field does not persist until
> [`references/sql/alter/add_gmail_surname_to_onboarding.sql`](../../references/sql/alter/add_gmail_surname_to_onboarding.sql)
> is run in the Supabase SQL editor. It is idempotent:
> `ALTER TABLE hr_onboarding_submissions ADD COLUMN IF NOT EXISTS gmail_surname TEXT`.
>
> Until it runs, the live derivation still works (the endpoint reads the roster),
> but a submit cannot store `gmail_surname`, so `set-work-email` falls back to the
> last-name initial.

---

## Files

| Path | Role |
|---|---|
| [`app/api/onboarding/[token]/gmail-surname/route.ts`](../../app/api/onboarding/[token]/gmail-surname/route.ts) | Derives the collision-aware slice; token-row / preview-session auth |
| [`app/onboarding/[token]/page.tsx`](../../app/onboarding/[token]/page.tsx) | Read-only field, debounced effect, loading spinner, always-generate rule |
| [`src/lib/hr/work-email.ts`](../../src/lib/hr/work-email.ts) | `workEmailCandidates` / `normalizeNamePart` — the minting rule |
| [`src/lib/hr/work-email-server.ts`](../../src/lib/hr/work-email-server.ts) | `loadTakenWorkEmails` (off-boarded recycling fix) |
| [`app/api/hr/onboarding-submissions/[id]/set-work-email/route.ts`](../../app/api/hr/onboarding-submissions/[id]/set-work-email/route.ts) | Sends Gmail Surname as `lastName` to the workspace webhook |
| [`app/api/onboarding/[token]/route.ts`](../../app/api/onboarding/[token]/route.ts) | Persists `gmail_surname` on submit; returns it in `priorData` |
| [`src/lib/supabase/hr-onboarding-submissions.ts`](../../src/lib/supabase/hr-onboarding-submissions.ts) | Row type + `gmail_surname` write |
| [`references/sql/alter/add_gmail_surname_to_onboarding.sql`](../../references/sql/alter/add_gmail_surname_to_onboarding.sql) | **PENDING** migration #81 |
