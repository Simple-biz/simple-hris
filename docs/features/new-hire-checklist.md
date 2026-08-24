# New Hire Checklist (modal-only intake + concurrency hardening)

The HR **New Hire Checklist** tab is a per-week intake grid for recruits: HR captures each hire's
name, personal email, location, phone, interview date, source, referrer, recruiter, department, and
country, then **Lock in** the week to fire the orientation-welcome webhook (**Lead Gen hires only** —
see below) and feed the department-scoped **Bulk Invite** in the onboarding Generate-link flow. Each row lives in its own
Sun–Sat week (anchored on that week's Sunday, `YYYY-MM-DD`).

As of **2026-07-10** the grid is **read-only and modal-only**: nothing is typed directly into a cell
anymore. Every add / edit / delete / bulk-apply is an **atomic, single-row server write** that
reconciles against DB truth, so two HR people working the same week can't clobber each other. This
doc focuses on that lock-down and the concurrency model that replaced the old whole-grid Save.

Key files:

- [route.ts](app/api/hr/new-hire-checklist/route.ts) — the tab's API: `GET`, granular `POST` /
  `PATCH` / `DELETE`, and `PUT` (lock / reopen).
- [hr-new-hire-checklist.ts](src/lib/supabase/hr-new-hire-checklist.ts) — data access: the atomic
  per-row ops, per-cell edit history, week lock table, and the Bulk-Invite reader.
- [HrNewHireChecklist.tsx](src/components/hr/HrNewHireChecklist.tsx) — the read-only grid + all
  mutation handlers (each an atomic fetch reconciled from the response).
- [NewHireQuickAddDialog.tsx](src/components/hr/NewHireQuickAddDialog.tsx) — the "New Hire" add /
  edit modal (async submit, stays open on failure).
- [useChecklistRoom.ts](src/hooks/useChecklistRoom.ts) — Realtime room: presence-based soft row-lock
  + "week changed → peers refetch" broadcast.
- [new-hire-checklist-webhook.ts](src/lib/hr/new-hire-checklist-webhook.ts) — `fireNewHireChecklistLockWebhook`,
  fired from DB truth on Lock in.

---

## Why it changed — the root cause that was fixed

The old model let HR paste/type into the whole grid and hit **Save**, which shipped the client's
**entire grid** for the week to `syncHrNewHireChecklist`. That function made the DB **match the
payload exactly**:

- **Delete-missing wiped co-editors' rows.** It read the week's existing ids, built `keepIds` from
  the ids the payload carried, and deleted `existingIds` that weren't in `keepIds`
  (`toDelete = [...existingIds].filter((id) => !keepIds.has(id))`). If your grid was stale (loaded
  before a colleague added rows), those rows weren't in your payload — so your Save **deleted
  them**.
- **Last-saver-wins clobber.** Best-effort live co-editing (`useLiveCells` keystroke streaming) had
  **no join-snapshot**, so two open grids drifted apart and whoever saved last overwrote the other's
  work.

`syncHrNewHireChecklist` still exists in the data layer (and its cell-history diffing is correct),
but the tab no longer calls it. **Delete-missing never runs against a stale client view anymore**
because deletes are now by explicit id only.

---

## The new model — atomic per-row writes

Every mutation touches exactly the rows it names and diffs each cell against the value **currently in
the DB**, so it can't wipe a neighbour's cell or delete a row it never saw.

| Action | Method | Server op |
|---|---|---|
| Add one hire | `POST` | `insertHrNewHireChecklistRow` — appends at `max(position)+1`; refuses a blank hire |
| Edit one row | `PATCH { id, values, expectedUpdatedAt }` | `updateHrNewHireChecklistRow` — writes ONLY the fields sent; optimistic concurrency |
| Bulk-set one field | `PATCH { ids, field, value }` | `bulkSetHrNewHireChecklistField` — sets one column per id (Dept / Country) |
| Delete rows | `DELETE { id }` or `{ ids }` | `deleteHrNewHireChecklistRows` — by primary key, exactly the ids named |
| Lock / reopen week | `PUT { action }` | freezes the week; on lock, fires the webhook from DB truth |

Each op does its **own `cell_edits` diff**: a changed field appends a `{ by, at, from, to }` entry to
that column's append-only history log (capped at `MAX_CELL_HISTORY = 50`), diffed against the DB's
current value — never against whatever the client had loaded. Untouched cells keep their prior log
verbatim, and an unknown editor is never attributed.

### Optimistic concurrency on edit

The edit modal captures the row's `updated_at` **when it opens** (`baseUpdatedAt`) and sends it as
`expectedUpdatedAt`. `updateHrNewHireChecklistRow` re-reads the row: if its `updated_at` has moved
since, it returns `{ conflict: true }` with the **current** row and the route replies **HTTP 409**.
The grid then swaps in the fresh row, resets the modal's baseline to the co-editor's version, toasts
"Someone else just changed this hire…", and **keeps the modal open** so the editor re-applies their
change on top. `updated_at` is advanced **explicitly** in the update payload, so conflict detection
never depends on a DB trigger. An edit that changes nothing returns the current row without writing.

### Lock in — fires from DB truth

`PUT { action: 'lock' }` freezes the week (`setHrChecklistPeriodStatus('locked')`) **first**, then
re-reads the week's rows **from the DB** and passes them to `fireNewHireChecklistLockWebhook` — never
a client's possibly-stale copy. The webhook is best-effort: the DB write is the source of truth, so a
webhook failure never fails the lock (it's recorded in the audit log's `webhook_fired` detail).
`PUT { action: 'reopen' }` flips the week back to `open`. A locked week refuses every mutating verb
with **HTTP 409** (`POST`/`PATCH`/`DELETE` check `weekIsLocked`).

---

## Realtime room — `useChecklistRoom`

This tab's live layer is the new [useChecklistRoom](src/hooks/useChecklistRoom.ts) hook, **not**
`useLiveCells`. Because nothing types into a cell anymore, there's no keystroke stream to merge;
the room just keeps everyone converged on server truth and prevents double-editing. The channel is
period-scoped (`hr-nhc-room:<week>`) so switching weeks starts a clean room, and it's deliberately
separate from the presence/cursor CollabLayer.

- **Presence-based soft row-lock.** Each client tracks `{ email, name, editingId }`, where
  `editingId` is the DB id of the row whose edit modal they currently have open. `editingByRowId`
  maps each locked row to the peer editing it, so the grid can show that editor's identity color and
  **disable the Edit button** for everyone else on that row.
- **`changed` broadcast.** After any successful mutation the actor calls `broadcastChanged()`; peers
  fire `onChanged` and do a **silent refetch** of the week (debounced ~400ms in the component). An
  added / edited / deleted / bulk-updated hire thus shows up live on every screen without any
  field-level merge guesswork. `broadcast.self = false`, so the actor doesn't refetch its own write
  (it already reconciled from the response).

The grid keeps its row multiselect **keyed by DB id**, so a selection survives a live refetch (rows
that vanished are pruned).

---

## The New Hire modal

[NewHireQuickAddDialog](src/components/hr/NewHireQuickAddDialog.tsx) is the only way to add or edit a
hire. Its submit is now **async**: `commit` awaits `onSave(values)` and treats a resolved **`false`**
as "the server write failed / conflicted" — it shows a spinner (`submitting`), disables the footer
buttons and backdrop-dismiss, and **stays open** so the entry isn't lost. On success it either resets
for "Save & add another" (add mode) or closes. Only **name** is required (plus **Referred by** when
the source is a referral). Department and country are canonicalized client-side before the write so
Bulk Invite routes them to the right box.

---

## API (`/api/hr/new-hire-checklist`)

All verbs run server-side; mutating verbs require `requireFeatureEdit("hr", "new_hire_checklist")`,
`GET` requires an elevated session. Every mutation writes an `audit_log` entry.

| Verb | Body | Purpose |
|---|---|---|
| `GET` | `?period=YYYY-MM-DD` | That week's rows + its lock state. 400 on a bad period. |
| `POST` | `{ period_start, period_end?, values }` | Add ONE hire. First touch of a new week records its `period_end`. 409 if the week is locked. |
| `PATCH` (single) | `{ period_start?, id, values, expectedUpdatedAt? }` | Update only the fields sent; stale `expectedUpdatedAt` → **409** with the current row. |
| `PATCH` (bulk) | `{ period_start?, ids, field, value }` | Set one field on many rows (Dept / Country). |
| `DELETE` | `{ period_start?, id }` or `{ ids }` | Delete exactly the ids named — never "everything not in the payload". |
| `PUT` | `{ period_start, period_end?, action: 'lock' \| 'reopen' }` | Freeze / reopen the week; `lock` fires the orientation webhook from DB rows. |

Unknown `values` keys are dropped by `pickFields` (only `HR_NEW_HIRE_CHECKLIST_FIELDS` are accepted:
`name`, `personal_email`, `location`, `phone_number`, `date_of_interview`, `source`, `referred_by`,
`hired_by`, `department`, `country`).

---

## Lock-in webhook

`fireNewHireChecklistLockWebhook` POSTs **one** event (`new_hire_checklist.locked`) carrying each
**sendable** hire as a **self-contained** item in `rows[]` — each row has its own fields plus the
shared week/email fields (`start_date`, `orientation_date`, `orientation_weekday`, `zoom_link`), a
derived `first_name`, and `lead_gen: true`, so an n8n **Split Out** on `body.rows` yields
ready-to-send per-hire items. Hires start and orient the **Monday** of the Sun-anchored week
(`ORIENT_OFFSET_DAYS = 1`). The URL resolves through the Admin → Webhooks slug registry
(`new_hire_checklist_lock`) with an env-var override and a hard-coded default; the POST is
best-effort with a 25s timeout and never throws. No `cell_edits` / timestamp noise is sent.

### Lead Gen only — who is left out, and why

This email **is** the Lead Gen orientation invite: it carries the orientation Zoom link, meeting ID
and passcode, and orientation is a Lead Gen ritual. So `rows[]` is **not** every hire in the week:

| Left out | `skipped[].reason` | What HR sees | What HR does |
|---|---|---|---|
| Department is not Lead Gen | `not_lead_gen` | info toast naming the hire + their department | nothing, unless the department is wrong |
| `personal_email` holds no usable address | `invalid_email` | sticky warning toast | fix the cell, resend that hire |

- The gate is **`isLeadGenDepartment`** (`src/lib/hr/offboard-webhooks.ts`) — literally the same
  predicate that decides whether marking a hire "orientation attended" fires the CallTools-creation
  webhook. Both orientation surfaces therefore agree on who is Lead Gen, and there is one place to
  change it.
- It resolves through `normalizeDeptToKey`, so casing and spacing never matter and both **"Lead Gen"**
  and **"Lead Generation"** send. Everything else — including a **blank** or unrecognised department —
  is **not** Lead Gen and is withheld. The gate **fails closed** on purpose: a missing department
  must never mail a Zoom link to someone who is not invited.
- The department check runs **before** the email check, so a withheld non-Lead-Gen hire is reported
  as `not_lead_gen` even when their email cell is also junk — HR is not sent chasing a cell that
  changes nothing.
- `hire_index` still counts the hire's place in the **full** week, withheld rows included, so a
  trimmed resend still lines up with the original run's n8n item numbering.
- The gate lives in the **sender**, not only in n8n. The flow's Filter node (
  `references/n8n/orientation-email-leadgen-only.json`) is a deliberate **second** layer: editing or
  losing it in the n8n cloud UI cannot re-open the hole.

**Why it exists:** on 2026-08-21 the locked 2026-08-23 week (79 rows) shipped every row to a flow
with no filter, so the one **HSL** hire on it — Giducos, Vera — received the Lead Gen orientation
link. Teal caught it and told her to disregard it.

---

## Related

- **Onboarding Bulk Invite** — `listHrNewHireChecklistByDepartment(department, periodStart?)` reads a
  department's rows (optionally scoped to one week) to fan out one onboarding invite per hire.
- **HR Overview** — the checklist's `source` / `hired_by` / referral data powers the hiring-sources
  pie, recruiter scorecard, and referrals table (`listHrNewHireChecklistSourceCounts`,
  `…RecruiterCounts`, `…Referrals`).
- **Offboarding automation** — the mirror pipeline for taking someone off the roster.
