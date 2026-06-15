# Designated Work Email — verify & status (HR Onboarding)

Where: **HR → Onboarding → Onboarding Form → Submitted tab**, the
**Designated Work Email** column.

## What the column means

The address an onboarding hire was assigned is shown as a *designated* work email
only when its Google Workspace account is actually provisioned. The state comes
from `hr_onboarding_submissions.workspace_account_ok` (migration #70):

| State | `workspace_account_ok` | Column shows |
|-------|------------------------|--------------|
| Confirmed | `true` | green pill + address |
| Automation failed | `false` | red "Automation failed" + struck address + "Retry setup" |
| Unverified | `null` (legacy) | amber "Unverified — click Verify to check" |
| Not set | (no `work_email`) | "Not set" |

`workspace_account_ok` is written two ways:

1. **At set-work-email time** — the `create_workspace_account` webhook result is
   persisted (body-aware: n8n can return HTTP 200 with `ok:false`, so the body is
   inspected, not just the status). See
   [`src/lib/hr/workspace-account.ts`](../../src/lib/hr/workspace-account.ts).
2. **By the Verify button** — a read-only re-check (below). Use this to resolve
   the legacy "Unverified" rows **without** recreating the account (no duplicate
   risk). Reserve **Retry setup** for genuinely failed ones.

## Verify button → n8n webhook contract

Clicking **Verify** calls
`POST /api/hr/onboarding-submissions/[id]/verify-work-email`, which calls the n8n
webhook resolved by slug **`verify_workspace_account`** (Admin → Webhooks, or env
`N8N_VERIFY_WORKSPACE_WEBHOOK_URL`, default
`https://auto.simple.biz/webhook/verify-workspace-account`).

**This webhook must be read-only** — a Google Workspace Directory "get user"
lookup. It must NOT create, invite, or email anyone.

### Request
```
POST  (the verify webhook URL)
Content-Type: application/json

{ "work_email": "fransta@simple.biz" }
```

### Response (HTTP 200)
Return whether the account exists. The canonical shape is:
```json
{ "exists": true }
```
or
```json
{ "exists": false }
```

The parser is lenient and also accepts (array-wrapped is fine — n8n's default):
- `found` / `ok` / `active` booleans
- a `status` string: `"found"`/`"exists"`/`"active"`/`"ok"` → exists;
  `"not_found"`/`"missing"`/`"no_user"` → missing
- a returned identity (`primaryEmail`, `id`, or a `user` object) → exists
- a bare `true` / `false`

### Outcomes (shown in a result modal, not a toast)
Clicking Verify opens a modal that shows a loading state, then the translated
outcome + the raw detail (HTTP status + webhook message):

| Webhook says | Stored | Modal |
|---|---|---|
| exists | `workspace_account_ok = true` (Confirmed) | green "Account verified" |
| missing | `workspace_account_ok = false` (Automation failed) | red "Account not found" + **Retry setup** |
| error / unreadable / non-2xx | **unchanged** | amber "Could not verify" + **Try again** |

On an ambiguous or failed lookup the stored status is deliberately **left as-is**
so a transient webhook outage never clobbers a known-good/known-bad row.

### Multi-select bulk Verify
Tick rows in the Submitted table (selection persists across search/filter) and a
**Verify (N)** button appears in the bulk action bar for every selected row that
has an address. It runs the read-only lookups 5-at-a-time and opens a progress +
results modal (`BulkVerifyDialog`) listing each row as Verified / Not found /
Unchecked, with a confirmed/not-found/unchecked count. The table refreshes and
the selection clears when it finishes. Never recreates anything.

### Bulk Set work email also verifies
The bulk **Set work email** flow (Submitted tab → select rows → "Set work email")
runs in two phases per department group: **(1)** set the addresses that still
need one (fires create), then **(2)** automatically **verify** every row in the
group that isn't already confirmed — the just-set ones whose create came back
"already exists", *plus* any selected row that already had an address but was
never verified. Freshly + cleanly created rows (create returned 200) are skipped
to avoid redundant lookups. A group with nothing left to set but unconfirmed
rows shows a **"Verify N accounts"** button so it can still be reconciled in one
click. Each row shows its verify result inline ("Verified in Workspace" /
"Account not found - retry from table"), and the toast summarizes
`X confirmed, Y not found`.

### Verify-aware email suggestion / reclaim
A prior failed attempt can leave an address claimed in the roster
(`hr_pending_employees`, etc.) with **no real Workspace account** behind it — so
the suggester would skip that ideal address forever. The single **Set/Retry work
email** dialog now passes `verify: true` to `/api/hr/work-email/suggest`, which:
- walks the preferred candidates and, for one that's only roster-taken, asks the
  verify webhook — if the account is **missing**, it reclaims that address
  instead of bumping to a variant (capped at `MAX_VERIFY_LOOKUPS` lookups);
- on the availability check, flips a roster-taken address back to **available**
  when verify says missing (shown as "Available — was claimed before but has no
  Workspace account").

The `set-work-email` route applies the same rule at save time: a taken address
that differs from the row's current one is only blocked (409) when verify finds a
**real account** — a definite "missing" is allowed through. Anything other than a
clear "missing" (real account, or a webhook error/outage) keeps the address
locked, so this never frees a genuinely-in-use address. The bulk suggest path
does **not** verify (kept fast).

### Manual override — "Mark as verified"
The `missing` and `error` modals also offer **Mark as verified**, for when HR has
checked the Google Admin console themselves and knows the account exists but the
create/verify webhook got it wrong (classic case: a create error of
`Operation "create" failed for resource "user"` that actually means the account
**already existed**). This calls
`POST /api/hr/onboarding-submissions/[id]/workspace-status` with `{ ok: true }`
(no webhook), stamps `workspace_account_ok = true`, and is audit-logged with
`manual: true`. It's the immediate fix while the n8n verify workflow is being
built (until then Verify itself returns "Could not verify").
