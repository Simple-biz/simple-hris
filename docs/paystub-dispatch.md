# Paystub Dispatch (n8n Integration)

End-to-end pipeline for sending weekly paystubs from the HRIS to employees' personal emails, triggered by the Confirm & Dispatch button in the PayrollWizard's Dispatch step.

## Architecture

```
PayrollWizard (Dispatch step)
        │
        │  POST /api/dispatch-paystubs  { pay_period, employees[] }
        ▼
Next.js API route  (app/api/dispatch-paystubs/route.ts)
        │  — reads N8N_DISPATCH_WEBHOOK_URL (server-only)
        │  — forwards JSON body unchanged
        ▼
n8n webhook (production or test)
        │
        ├─ Webhook node
        ├─ Split Out (fieldsToSplitOut: "employees")
        ├─ Loop Over Items (batchSize: 1)
        ├─ Set node "pay_vars" (maps webhook fields → template names)
        ├─ Gmail / Resend Send Email node (renders HTML paystub)
        ├─ Wait 600ms (throttle to avoid Gmail rate limits)
        └─ Respond to Webhook  { status, sent }
```

The webhook URL is **kept server-side** in `N8N_DISPATCH_WEBHOOK_URL`. The browser only ever calls `/api/dispatch-paystubs`; it never knows the n8n URL.

## Environment variables

`.env` / `.env.local`:

```
N8N_DISPATCH_WEBHOOK_URL_TEST="https://<workspace>.app.n8n.cloud/webhook-test/confirm-dispatch"
N8N_DISPATCH_WEBHOOK_URL_PROD="https://<workspace>.app.n8n.cloud/webhook/confirm-dispatch"
# Active URL read by the API route. Point at TEST or PROD.
N8N_DISPATCH_WEBHOOK_URL="https://<workspace>.app.n8n.cloud/webhook-test/confirm-dispatch"
```

The **test** URL only fires while "Listen for test event" is active in the n8n editor — it captures one request then stops. For real dispatches, activate the workflow and point `N8N_DISPATCH_WEBHOOK_URL` at the `/webhook/` (production) URL. Restart the dev server after env changes.

## API route

`app/api/dispatch-paystubs/route.ts`:

- Validates `N8N_DISPATCH_WEBHOOK_URL` is set (500 if not).
- Parses body as JSON (400 on invalid).
- POSTs to the webhook with `Content-Type: application/json`.
- On non-2xx from n8n: returns 502 with `{ error, detail }` (detail contains n8n's raw response for debugging).
- On success: returns `{ ok: true, n8n: <parsed response> }`.

## Webhook payload

Built in `dispatchData` (a `useMemo` in `PayrollWizard.tsx`) and posted as:

```jsonc
{
  "pay_period": {
    "currency": "PHP",
    "hubstaff_source_file": "simple-biz_daily_report_2026-04-05_to_2026-04-11.csv",
    "week": { "start": "2026-04-05", "end": "2026-04-11" },
    "pab_evaluation": {
      "month_label": "April 2026",
      "range_start": "2026-04-06",
      "range_end": "2026-05-01"
    }
  },
  "employees": [
    {
      "name": "Jane Dela Cruz",
      "email": "jane@work.example.com",
      "personal_email": "jane@gmail.com",
      "pay_period": { /* same shape as top-level, duplicated per row */ },
      "department_key": "site_building",
      "department_name": "Site Building",
      "hours": { "total": 42.5, "regular": 40, "ot": 2.5 },
      "rates_php": { "regular": 250, "ot": 375 },
      "pay_php": {
        "regular": 10000,
        "ot": 937.5,
        "initial": 10937.5,
        "bonuses_total": 1850,
        "perfect_attendance_bonus": 0,
        "tech_bonus": 1850,
        "other_bonuses": 0,
        "final": 12787.5
      }
    }
  ]
}
```

### How each field is derived

| Field | Source |
|---|---|
| `pay_period.hubstaff_source_file` | `calcSourceFile` (selected Hubstaff CSV). |
| `pay_period.week` | `parseDateRangeFromFilename(calcSourceFile)` → `{ start, end }`. Falls back to Mon–Sun of the latest parseable date column if the filename doesn't match `YYYY-MM-DD_to_YYYY-MM-DD`. ISO-formatted. |
| `pay_period.pab_evaluation` | `pabMonthRange` — the PAB month inferred for the current UI context (see `BUSINESS_LOGIC.md#PAB month period`). |
| `personal_email` | Resolved per-row by `resolvePersonalEmail`: (1) rate row keyed by Hubstaff work email, (2) `global_master_list` match on `work_email`, (3) `global_master_list` name match via `normalizeNameTokens`. Rows without a resolvable personal email are **skipped** with a toast warning. |
| `department_key/name` | `employeeDepts[email]` → `DEPARTMENTS.find(...)`. |
| `hours.*` | From `effectiveCalcResults[].totalHours/regularHours/otHours`. |
| `rates_php.*` | From `effectiveCalcResults[].regularRate/otRate`. |
| `pay_php.regular/ot/initial` | From `effectiveCalcResults[]`. |
| `pay_php.perfect_attendance_bonus` | `isFinalPabWeek && toggles.perfect_attendance ? 5000 : 0`. Only attaches on the final weekly paystub of the PAB month. |
| `pay_php.tech_bonus` | `(isTechBonusWeek \|\| toggles.tech_bonus) && hasThirtyDays ? 1850 : 0`. Only on the paycheck whose salary date falls in the **3rd full Mon–Sun week** of its month (week 1 = first Mon–Sun whose Monday ≥ the 1st; week 3 = +14d) and only after 30 days of service. This lands tech bonus two weeks out from PAB. |
| `pay_php.other_bonuses` | `bonusTotals[email] − toggledPab − toggledTech`. Department-specific bonuses (collections tiers, per-ticket, etc.). |
| `pay_php.bonuses_total` | Recomposed: `perfect_attendance_bonus + tech_bonus + other_bonuses`. |
| `pay_php.final` | `initial + bonuses_total`. |

## Gating summary (dispatch-time)

- **Final PAB week**: `week.end >= pabMonthRange.end` where `pabMonthRange` is **derived from the dispatch week's own Monday** (not from merged uploads' mode month).
- **3rd-paycheck tech week**: `week.start` falls within the 3rd calendar week of the dispatch week's PAB month. Week 1 = Mon–Sun week containing the 1st of the month.
- **30 days of service**: `week.start >= (start_date + 30 days)`. `start_date` is looked up from `masterEmployees` keyed by work email + personal email.

See `BUSINESS_LOGIC.md#Technology Bonus` and `#Weekly gating for monthly bonuses` for the full business rules.

## Preview Paystubs modal

The Dispatch step's "Preview Paystubs" button opens a modal built from the same `dispatchData` rows that will be posted. Two views:

1. **List view**: searchable (filter by name or personal email), one row per employee (name + personal email + "View" action).
2. **Detail view**: orange/white/blue diagonal-gradient paystub mirroring the email template (header, recipient, earnings, bonuses, total, logo footer). Fits one viewport without scrolling. "← Back" returns to the list.

State: `previewPaystubsOpen`, `previewSelectedEmail`, `previewSearch`. All reset on modal close.

## n8n workflow

Template JSON lives at `references/n8n_paystub_dispatch.json`. Key nodes:

- **Webhook** (`POST /confirm-dispatch`): receives the payload.
- **Split Out** (`fieldsToSplitOut: employees`): fans out to one item per employee.
- **Loop Over Items** (batchSize 1): iterates per employee.
- **Set "pay_vars"** (replaces an older Google-Sheets-driven `prep sheet variables`): maps webhook fields to template-friendly names (e.g., `mf_hours`, `mf_rate`, `week_human`, `total_pay_php`).
- **Send Email** (Gmail node in the current test workflow; swap to Resend/SES for production volume): renders the HTML paystub template.
- **Wait 600ms**: throttles below Gmail's ~2 sends/sec per-user API cap.
- **Respond to Webhook**: `{ status, sent }`.

### HTML template

The paystub body uses inline-styled tables for email-client compatibility. Diagonal `linear-gradient(to top right, …)` (blue → white → orange) on the page background, header band, section accent bars, card backgrounds, and total bar. Logo + "© Simple · Confidential" in a centered footer row. All data comes from `$('pay_vars').item.json.*`. Fits a ~500px card width.

### Known limits

- **Gmail consumer**: ~500/day, ~2/sec per-user API cap → `FAILED_PRECONDITION` on burst sends. Not viable for 1,000-employee runs.
- **Gmail Workspace**: ~2,000/day. Marginal for 1,000 runs, still rate-limited per-second.
- **Recommended for production volume**: Resend Pro ($20/mo, 50k/mo, 100 req/sec batch API), SES, or SendGrid. Switch the Gmail node for the provider's node; `pay_vars` mappings stay the same.

### Resilience checklist (in-workflow)

- Toggle **Continue on Fail** on the Send Email node.
- Enable **Retry on Fail** (Max Tries 5, Wait 2000 ms) for transient API errors.
- Route failures to a `failed_dispatches` Set/Sheet node capturing `{ personal_email, name, itemIndex, error, timestamp }`.
- Add a filter before Send Email requiring `personal_email` to match an email regex after trim+lowercase.

## UI signals in the HRIS

- **n8n pill** on the Dispatch step (`Ready to Dispatch` block): small pink badge reading "Triggers n8n automation · Accounting heads up" with an n8n favicon, linking to the n8n Cloud workspace. Gives payroll/accounting a clear signal that clicking Confirm will fire an external workflow.
- **Running red-light animation**: while `isDispatching === true` the Dispatch panel gets a conic-gradient red light running around its edges (1.6s per rotation). Button disables and label changes to "Dispatching…". Controlled by the `dispatch-running-light` CSS class embedded alongside the JSX (inline `<style>` for scoped keyframes).

## Client-side dispatch flow

```
Confirm & Dispatch onClick
 ├─ Resolve personal_email per row; collect `missing` (rows to skip).
 ├─ Early-out if no employees have personal email → error toast.
 ├─ Warning toast listing up to 5 skipped names if any.
 ├─ setIsDispatching(true)  → red-light animation + disabled button.
 ├─ fetch('/api/dispatch-paystubs', { method: 'POST', body: { pay_period, employees } })
 │    ├─ res.ok  → success toast "Sent N paystub requests to n8n" + setCurrentStep(1).
 │    └─ !res.ok → error toast with { error, detail from n8n }.
 └─ finally → setIsDispatching(false)
```

## References

- Workflow JSON: `references/n8n_paystub_dispatch.json`.
- Business rules: `Documentation/BUSINESS_LOGIC.md`.
- API route: `app/api/dispatch-paystubs/route.ts`.
- Client logic: `src/components/PayrollWizard.tsx` (`dispatchData` useMemo + Dispatch step JSX + Preview Paystubs dialog).
