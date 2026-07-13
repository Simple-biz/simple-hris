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

## Orientation-attended webhook (where the username leaves the system)

When a manager marks the hire as **attended** on Manager → Newly Hired
(single or bulk — bulk fires one event per hire),
**`POST /api/manager/pending-hires/[id]/orientation`** fires the
**`orientation_attended`** n8n webhook
([src/lib/hr/orientation-webhook.ts](../../src/lib/hr/orientation-webhook.ts)) —
this is the payload that provisions the Lead Gen CallTools agent:

```jsonc
{
  "event": "hire.orientation_attended",
  "pending_employee_id": 123,
  "name": "James Thomas",
  "work_email": "jamest@simple.biz",
  "personal_email": "james@gmail.com",
  "department": "Lead Gen",
  "lead_gen": true,                    // normalizeDeptToKey-based
  "calltools_nickname": "Mikey",       // null for non-Lead-Gen
  "calltools_username": "Mikey J. T.", // null for non-Lead-Gen / pre-feature rows
  "attended_on": "2026-07-14",         // Manila date = Start Date
  "orientation_attended_at": "2026-07-13T16:00:00.000Z",
  "marked_by": "manager@simple.biz",
  "note": null,
  "already_marked": false              // true on a re-mark (date edit) — n8n's dedupe signal
}
```

The CallTools fields are looked up from the submission linked to the pending
hire (`hr_onboarding_submissions.pending_employee_id`). **Mint-on-mark
fallback:** when a Lead Gen hire's linked submission has no stored username
(paperwork submitted before the nickname feature), the route mints one at mark
time — nickname preference: stored `calltools_nickname` → the roster name's
quoted go-by name (`Joan "Andy" Raguindin` → Andy; surname-first
`Caraga, Siegmond Lois “Siegmond”` handled too — `fallbackDialerIdentity`) →
first name — checks it against every minted username, and **persists it back
onto the submission** (reserved + stable + visible in the HR modal). So the
payload always carries a username for a Lead Gen hire with a linked
submission; nulls only when unlinked, non-Lead-Gen, or pre-migration. Marking
is idempotent, so **date edits re-fire with `already_marked: true`** — the n8n
flow must treat those as an update, not a second account. Best-effort: a
webhook failure never blocks the mark, but it is returned to the panel, which
toasts "attendance saved, but the n8n webhook failed" (and a per-hire tally on
bulk). URL: Admin → Webhooks slug `orientation_attended`, env
`N8N_ORIENTATION_ATTENDED_WEBHOOK_URL`, default
`…n8n.cloud/webhook/orientation-attended`. The HR **Bypass** flow marks
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
| [`src/lib/hr/calltools-username-server.ts`](../../src/lib/hr/calltools-username-server.ts) | `loadTakenCallToolsUsernames` (all-status over-reserve) |
| [`app/api/onboarding/[token]/calltools-username/route.ts`](../../app/api/onboarding/[token]/calltools-username/route.ts) | PREVIEW-ONLY live derivation (elevated session; other tokens 404) |
| [`app/onboarding/[token]/page.tsx`](../../app/onboarding/[token]/page.tsx) | Editable Lead Gen nickname; preview-only username field + Lead Gen switches |
| [`app/api/onboarding/[token]/route.ts`](../../app/api/onboarding/[token]/route.ts) | Mints `calltools_username` server-side at submit; returns only the nickname in `priorData` |
| [`src/lib/supabase/hr-onboarding-submissions.ts`](../../src/lib/supabase/hr-onboarding-submissions.ts) | Row/input types, verbatim-sanitized write, pre-migration retry |
| [`src/components/hr/HrOnboardingForm.tsx`](../../src/components/hr/HrOnboardingForm.tsx) | Detail-modal "CallTools nickname / username" rows |
| [`src/lib/hr/orientation-webhook.ts`](../../src/lib/hr/orientation-webhook.ts) | `orientation_attended` slug + payload type + best-effort fire |
| [`app/api/manager/pending-hires/[id]/orientation/route.ts`](../../app/api/manager/pending-hires/[id]/orientation/route.ts) | Fires the webhook on mark-attended with the CallTools fields + `already_marked` |
| [`src/components/manager/NewlyHiredPanel.tsx`](../../src/components/manager/NewlyHiredPanel.tsx) | Toasts when the mark saved but the n8n webhook failed (single + bulk) |
| [`src/components/admin/AdminWebhooks.tsx`](../../src/components/admin/AdminWebhooks.tsx) | `orientation_attended` slug registry entry |
| [`references/sql/alter/add_calltools_username_to_onboarding.sql`](../../references/sql/alter/add_calltools_username_to_onboarding.sql) | **PENDING** migration |
