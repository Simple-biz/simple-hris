# Onboarding CallTools Username (Lead Gen)

> **Status:** Built. Requires the **PENDING migration**
> `references/sql/alter/add_calltools_username_to_onboarding.sql` before the
> fields persist — see [Pending migration](#pending-migration).

Lead Gen hires work on the **CallTools** dialer under a nickname of their own
choosing. On the onboarding paperwork their **Nickname field is editable** (it
is NOT derived from their legal name, unlike every other department's
mirrored read-only nickname), and the system mints a **read-only CallTools
Username** from it:

```
<Nickname> <first-name initial>. <surname slice>.
```

| Hire | Typed nickname | Username |
|---|---|---|
| James Thomas (first "Mikey J. T…") | Mikey | `Mikey J. T.` |
| Jordan Thackeray (second) | Mikey | `Mikey J. TH.` |
| a third colliding hire | Mikey | `Mikey J. THO.` |

The surname slice starts at one letter and **lengthens until the username is
unique**, mirroring the work-email / Gmail-surname rule. There is **no numeric
fallback** — if every slice collides the full surname is used.

Non-Lead-Gen hires are untouched: their Nickname stays the read-only
first-name mirror (with the multi-first-name arrows), no CallTools field is
shown, and nothing CallTools-related is submitted.

---

## What the hire sees (Step 1 / Welcome)

When the invite's `invite_department` is Lead Gen (`"Lead Gen"` /
`"Lead Generation"`, case-insensitive — `isLeadGenDepartment`):

- **Nickname** becomes a required, editable input ("How you want to be called —
  e.g. Mikey"), title-cased on blur. It seeds **blank** (never from the invite
  name); a re-opened submission restores the stored `calltools_nickname`.
- The minted **CallTools Username is HIDDEN from the hire** — it is an internal
  HR/dialer value. The field only renders on the HR preview (below); the real
  paperwork shows just the Nickname.

On submit the form sends `calltools_nickname` only (Lead Gen; other departments
omit the key entirely). The username is minted **server-side** by
`POST /api/onboarding/[token]`: it verifies the row's invite is Lead Gen,
splits `full_name` (suffix-peeling via `splitFullName`), loads the taken set,
deletes the row's own previous username (re-submissions don't collide with
self), and stores `suggestCallToolsUsername(...)`. Any client-sent
`calltools_username` is ignored; for non-Lead-Gen rows both keys are stripped.
If the taken-set read fails it mints the shortest form unchecked rather than
blocking the hire (`console.error` notes it). `priorData` never returns the
username back to the paperwork.

---

## HR preview + "Test as Lead Gen"

`/onboarding/preview` has no invite, so preview mode gets TWO synced controls
over the same `previewLeadGen` state (handler: `setPreviewLeadGenMode`):

- an **inline switch panel directly above the Nickname field** on the Welcome
  step ("Preview test — onboard this hire as Lead Gen", Standard/Lead Gen
  switch) — flip it while looking at the field and watch it change from the
  system-generated mirror to the type-your-own Lead Gen version;
- a **"Test as Lead Gen"** pill in the top preview banner, visible from every
  step.

Flipping on blanks the mirrored nickname and swaps Step 1 into the Lead Gen
experience so HR can type a nickname and watch the username mint live
(collision-aware, 300 ms debounce, "Checking availability…" spinner — the same
pattern as the Gmail Surname field). The username field carries an "Only
visible in this preview" note so it's clear hires never see it. Flipping off
re-mirrors the nickname from the first name.

HR also sees the stored values on a submission: the detail modal's **Personal
info** section shows *CallTools nickname* and *CallTools username* (copyable)
whenever the row has them.

---

## CallTools-creation webhook (where the username leaves the system)

When a manager marks a **LEAD GEN** hire as **attended** on Manager → Newly
Hired (single or bulk — bulk fires one event per hire; other departments fire
nothing), **`POST /api/manager/pending-hires/[id]/orientation`** fires the
**`call_tools_creation`** n8n webhook
([src/lib/hr/orientation-webhook.ts](../../src/lib/hr/orientation-webhook.ts))
— this is the payload that provisions the CallTools agent:

```jsonc
{
  "event": "hire.orientation_attended",
  "pending_employee_id": 123,
  "name": "James Thomas",
  "first_name": "James",               // split parts (source of truth), carried
  "last_name": "Thomas",               // straight from the pending row's columns
  "work_email": "jamest@simple.biz",
  "personal_email": "james@gmail.com",
  "department": "Lead Gen",
  "lead_gen": true,                    // always true — Lead Gen only
  "calltools_nickname": "Mikey",
  "calltools_username": "Mikey J. T.",
  "pay_rate": 175,                     // regular rate, 0 when Accounting hasn't set it
  "regular_rate": 175,                 // Payment Catalog figures (null when unset)
  "ot_rate": 262.5,
  "attended_on": "2026-07-14",         // Manila date = Start Date
  "orientation_attended_at": "2026-07-13T16:00:00.000Z",
  "marked_by": "manager@simple.biz",
  "note": null,
  "already_marked": false              // true on a re-mark (date edit) — n8n's dedupe signal
}
```

The CallTools fields come from `ensureCallToolsFieldsForSubmission` /
`...ForPendingHire`
([calltools-username-server.ts](../../src/lib/hr/calltools-username-server.ts)):
STORED-OR-MINTED. When a Lead Gen hire's linked submission has no stored
username (paperwork submitted before the nickname feature), one is minted at
call time — nickname preference: stored `calltools_nickname` → the roster
name's quoted go-by name (`Joan "Andy" Raguindin` → Andy; surname-first
`Caraga, Siegmond Lois “Siegmond”` handled too — `fallbackDialerIdentity`) →
first name — checked against every minted username, and **persisted back onto
the submission** (reserved + stable + visible in the HR modal). So the payload
always carries a username for a Lead Gen hire with a linked submission; nulls
only when unlinked, non-Lead-Gen, or pre-migration. Marking is idempotent, so
**date edits re-fire with `already_marked: true`** — the n8n flow must treat
those as an update, not a second account.

The same two fields (`calltools_nickname` / `calltools_username`, always
present, null for non-Lead-Gen) also ride the **`create_workspace_account`
webhook payload** — set-work-email, the Add-Person work-email PATCH, and
retry-workspace all resolve them through the same stored-or-minted helper, so
whichever webhook fires first mints and the others reuse the persisted value.
Per HR, the **mark-attended (CallTools-creation) webhook is the provisioning
trigger**; the workspace payload carries the fields for reference. Best-effort: a
webhook failure never blocks the mark, but it is returned to the panel, which
toasts "attendance saved, but the n8n webhook failed" (and a per-hire tally on
bulk). URL: Admin → Webhooks slug `call_tools_creation` (registered from the
Admin dashboard, active), env `N8N_CALLTOOLS_CREATION_WEBHOOK_URL`, default
`…n8n.cloud/webhook/calltools-creation`. The HR **Bypass** flow marks
orientation too but deliberately does NOT fire this (a bypassed worker already
has accounts).

---

## The preview endpoint

**`POST /api/onboarding/preview/calltools-username`**
([route](../../app/api/onboarding/[token]/calltools-username/route.ts))

| | |
|---|---|
| Body | `{ nickname?: string; first?: string; last?: string }` |
| Returns | `{ calltools_username: string }` (`""` when nickname/first missing) |
| Runtime | `nodejs`, `force-dynamic` |

**PREVIEW-ONLY, deliberately stricter than the gmail-surname route:** any token
other than the literal `"preview"` → **404**, and preview requires
`requireElevatedSession()`. Real hires never call it (their username is minted
at submit), so a token-holding hire cannot probe which usernames exist.

**Taken set** (`loadTakenCallToolsUsernames`,
[src/lib/hr/calltools-username-server.ts](../../src/lib/hr/calltools-username-server.ts)),
shared by the preview endpoint and the submit-time minting: every non-null
`calltools_username` on `hr_onboarding_submissions`, **all statuses** — an
archived-but-promoted hire still holds a live dialer account and there is no
off-boarded flag to recycle against, so we over-reserve. **Limitation:**
usernames created directly in CallTools before this feature are invisible —
uniqueness is only guaranteed among usernames this system minted.

The pure rule lives in
[src/lib/hr/calltools-username.ts](../../src/lib/hr/calltools-username.ts)
(`calltoolsUsernameCandidates` / `suggestCallToolsUsername` /
`isLeadGenDepartment`), covered by
[calltools-username.test.ts](../../src/lib/hr/calltools-username.test.ts).

---

## Roster surfacing + backfill (Manager → My Team → list view)

The Manager **My Team → Roster** list view carries an **inline-editable
CallTools Username** column. It is Lead-Gen-scoped both ways:

- the column only renders when the currently-visible (filtered) roster contains
  at least one Lead Gen member — non-Lead-Gen teams never see an all-blank
  column (`showCallToolsCol` in `ManagerApp.tsx`, gated by `isLeadGenDepartment`);
- per Lead Gen row: the current username (mono) with a hover pencil to edit, or a
  clickable amber **"Needs backfill"** chip when none is on file; every
  non-Lead-Gen row shows a plain `—`.

### Two sources, manual wins

`loadCallToolsUsernamesByEmail`
([calltools-username-server.ts](../../src/lib/hr/calltools-username-server.ts))
returns an email→username map merged from **two** sources, and
`/api/manager/department-members` attaches it onto each
`EmployeeRow.calltools_username` in the same decorate pass as HSL/rate data
(matching on work/personal/alternate emails):

1. **Onboarding submissions** — every `hr_onboarding_submissions.calltools_username`
   (the auto-minted value; Lead Gen is the only department that stores one),
   keyed by the minted `work_email`, the typed personal `email`, and
   `invite_personal_email`.
2. **`employee_calltools_usernames`** (the per-employee manual store) — overlaid
   ON TOP, so a deliberate backfill/correction **wins** over a stale minted one.

Best-effort throughout: a missing column/table or a read failure just skips that
source rather than breaking the roster.

### Who has a minted username vs. who needs backfill (2026-07-20 audit)

Two distinct populations — don't confuse them:

- **The July 2026 new-hire batch (≈79 Lead Gen hires)** onboarded through the
  nickname feature: their submissions carry minted usernames (verified 79/79 —
  orientation stamped, username minted + unique, `call_tools_creation` webhook
  HTTP 200 in the audit log). They sit on the **New Hire Check List**
  (`hr_pending_employees`), not yet promoted, so they are NOT on
  `active_employees` yet — once promoted, the roster column picks them up
  automatically via the email join. Their usernames show on the Newly Hired
  panel (below).
- **Pre-feature Lead Gen staff (~217 active)**: none had a stored username, and
  ~94 have **no onboarding submission at all** — so there was nowhere to record
  one. The manual store is that place, keyed by the employee's work email
  (personal fallback), independent of whether they ever had a submission.

### New Hire Check List surfacing (Manager → My Team → New Hire Check List)

`GET /api/manager/pending-hires` attaches **`calltools_username`** to each row —
`loadCallToolsUsernamesByPendingIds` maps `hr_onboarding_submissions
.pending_employee_id` → latest submission's username (Lead Gen rows only;
display-only, never mints). On the actionable card (awaiting/attended),
`NewlyHiredPanel` shows a violet **copyable dialer-username badge** under the
emails line, or a "not minted yet" chip when the paperwork hasn't minted one.
The Bypass and no-show card variants deliberately omit the line (a bypassed
worker was provisioned outside the system; a no-show has no dialer account).

### Editing / backfilling

- **Inline:** click the cell → type → Enter/blur saves. `PATCH
  /api/manager/calltools-username`
  ([route](../../app/api/manager/calltools-username/route.ts)) upserts the store,
  scoped exactly like the roster read (manager/admin; a non-elevated manager may
  only edit someone on a department they manage). An empty save clears the
  manual entry (reverts to the submission value, if any). The just-saved value
  shows immediately via a local override map — no roster refetch.
- **Bulk:** `node scripts/import-calltools-usernames.mjs <file.csv>` (dry-run;
  add `--apply` to write) matches each CSV row to an employee by **email
  first**, then a normalized-name fallback (exact, then a unique-subset match for
  messy nickname-laden roster names), and upserts into the store. Auto-detects
  the username/email/name columns; overridable with `--username-col=` etc.
  **Include work emails in the export for reliable matching.**

---

## Pending migration

> `references/sql/alter/add_calltools_username_to_onboarding.sql` — idempotent:
> `ALTER TABLE hr_onboarding_submissions ADD COLUMN IF NOT EXISTS
> calltools_nickname TEXT, ADD COLUMN IF NOT EXISTS calltools_username TEXT;`
>
> Until it runs the feature degrades gracefully rather than blocking anyone:
> - the taken-set loader treats a missing-column error as an empty roster (the
>   live derivation still works, it just can't see prior collisions);
> - `submitHrOnboarding` retries a failed write once **without** the calltools
>   fields, so a Lead Gen hire's paperwork always lands (a `console.error`
>   names the missing migration);
> - the HR list query never selects the columns (the detail modal reads them
>   from its full-row `select("*")` fetch).

---

## Files

| Path | Role |
|---|---|
| [`src/lib/hr/calltools-username.ts`](../../src/lib/hr/calltools-username.ts) | Pure minting rule: candidates, suggestion, `isLeadGenDepartment` |
| [`src/lib/hr/calltools-username-server.ts`](../../src/lib/hr/calltools-username-server.ts) | `loadTakenCallToolsUsernames` (all-status over-reserve); `loadCallToolsUsernamesByEmail` (email→username map: submissions + `employee_calltools_usernames`, manual wins) |
| [`app/api/manager/department-members/route.ts`](../../app/api/manager/department-members/route.ts) | Joins the resolved username onto each roster `EmployeeRow.calltools_username` by email (Lead Gen only) |
| [`app/api/manager/calltools-username/route.ts`](../../app/api/manager/calltools-username/route.ts) | `PATCH` — inline backfill: upsert/clear the per-employee store, scoped like the roster read |
| [`src/components/manager/ManagerApp.tsx`](../../src/components/manager/ManagerApp.tsx) | My Team → Roster **list** view: Lead-Gen-gated, **inline-editable** "CallTools Username" column (`CallToolsUsernameCell`) |
| [`scripts/import-calltools-usernames.mjs`](../../scripts/import-calltools-usernames.mjs) | Bulk backfill importer — CSV → `employee_calltools_usernames`, email/name matching, dry-run by default |
| [`references/sql/migrate/2026-07-20_employee_calltools_usernames.sql`](../../references/sql/migrate/2026-07-20_employee_calltools_usernames.sql) | **PENDING** — creates the per-employee `employee_calltools_usernames` store |
| [`app/api/onboarding/[token]/calltools-username/route.ts`](../../app/api/onboarding/[token]/calltools-username/route.ts) | PREVIEW-ONLY live derivation (elevated session; other tokens 404) |
| [`app/onboarding/[token]/page.tsx`](../../app/onboarding/[token]/page.tsx) | Editable Lead Gen nickname; preview-only username field + Lead Gen switches |
| [`app/api/onboarding/[token]/route.ts`](../../app/api/onboarding/[token]/route.ts) | Mints `calltools_username` server-side at submit; returns only the nickname in `priorData` |
| [`src/lib/supabase/hr-onboarding-submissions.ts`](../../src/lib/supabase/hr-onboarding-submissions.ts) | Row/input types, verbatim-sanitized write, pre-migration retry |
| [`src/components/hr/HrOnboardingForm.tsx`](../../src/components/hr/HrOnboardingForm.tsx) | Detail-modal "CallTools nickname / username" rows |
| [`src/lib/hr/orientation-webhook.ts`](../../src/lib/hr/orientation-webhook.ts) | `call_tools_creation` slug + payload type (incl. rates) + best-effort fire |
| [`app/api/manager/pending-hires/[id]/orientation/route.ts`](../../app/api/manager/pending-hires/[id]/orientation/route.ts) | Fires the webhook on mark-attended with the CallTools fields + `already_marked` |
| [`src/components/manager/NewlyHiredPanel.tsx`](../../src/components/manager/NewlyHiredPanel.tsx) | Copyable CallTools-username badge per Lead Gen card; toasts when the mark saved but the n8n webhook failed (single + bulk) |
| [`app/api/manager/pending-hires/route.ts`](../../app/api/manager/pending-hires/route.ts) | Attaches `calltools_username` per pending hire (`loadCallToolsUsernamesByPendingIds`) |
| [`src/components/admin/AdminWebhooks.tsx`](../../src/components/admin/AdminWebhooks.tsx) | `call_tools_creation` slug registry entry |
| [`references/sql/alter/add_calltools_username_to_onboarding.sql`](../../references/sql/alter/add_calltools_username_to_onboarding.sql) | **PENDING** migration |
