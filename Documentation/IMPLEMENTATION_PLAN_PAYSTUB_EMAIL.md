# Implementation Plan: Paystub Email Distribution via n8n

> **Goal**: After each payroll run is dispatched in the PayrollWizard, automatically send every employee a personalized paystub email containing their hours, rates, deductions, and net pay — triggered via a webhook from the HRIS and executed by an n8n workflow.

---

## 1. Overview

| Layer | Tool | Role |
|---|---|---|
| HRIS (this app) | Next.js + Supabase | Stores payroll data, exposes a webhook endpoint, logs delivery status |
| Orchestration | n8n | Fetches paystub data, batches employees, sends emails, reports back |
| Email delivery | SMTP / Send Email node (n8n) | Sends the actual emails |
| PDF (optional) | n8n HTML or external renderer | Generates paystub as HTML email body or PDF attachment |

---

## 2. Chosen Approach — n8n Send Email (SMTP) Node

The **Send Email (SMTP)** node in n8n connects to any SMTP server — including Gmail (for small teams), Zoho Mail, or a dedicated business SMTP relay. For 1,000 employees it is recommended to use a business SMTP account with sufficient daily send limits.

### SMTP Provider Recommendations

| Provider | Daily Limit | Best For |
|---|---|---|
| Gmail Workspace | 2,000/day | Small teams (<200 employees) |
| Zoho Mail (paid) | 1,000/day | Mid-size teams |
| SendGrid (SMTP relay) | 100/day free, unlimited paid | Any size |
| Amazon SES (SMTP) | ~62,000/month free tier | Large teams, lowest cost |
| Mailgun (SMTP) | 5,000/month free | Good for testing |

> **Recommendation for 1,000 employees (bi-weekly cycle):** Use **SendGrid SMTP relay** or **Amazon SES SMTP** configured in the n8n Send Email node. Both plug directly into SMTP credentials without requiring a custom API node.

---

## 3. System Architecture

```
PayrollWizard (Step 5 — Dispatch)
  │
  └─► POST /api/trigger-paystub-email
        │  { payrollRunId, cycleLabel, employeePaystubs[] }
        │
        ▼
  Supabase: paystub_runs table (status = "queued")
        │
        └─► HTTP call → n8n Webhook URL
                │
                ▼
          n8n Workflow
          ┌─────────────────────────────────────┐
          │ 1. Receive Webhook                   │
          │ 2. GET /api/paystub-data?runId=...   │
          │    (fetch full employee paystub list) │
          │ 3. Split in Batches (50 per batch)   │
          │ 4. For each employee:                │
          │    a. Build HTML paystub body        │
          │    b. Send Email (SMTP node)         │
          │    c. Wait 500ms                     │
          │ 5. POST /api/paystub-callback        │
          │    (report delivered / failed count) │
          └─────────────────────────────────────┘
                │
                ▼
  Supabase: paystub_runs (status = "done" / "partial")
  Supabase: audit_log (action = "paystub.email.sent")
```

---

## 4. Database Tables to Add

### 4.1 `paystub_runs`

Tracks each payroll email batch.

```sql
CREATE TABLE public.paystub_runs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_label   TEXT        NOT NULL,                -- e.g. "April 13–19, 2026"
  triggered_by  TEXT        NOT NULL DEFAULT 'System',
  status        TEXT        NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued', 'sending', 'done', 'partial', 'failed')),
  total_count   INT         NOT NULL DEFAULT 0,
  sent_count    INT         NOT NULL DEFAULT 0,
  failed_count  INT         NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
```

### 4.2 `paystub_deliveries`

One row per employee per run — tracks individual delivery status.

```sql
CREATE TABLE public.paystub_deliveries (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID        NOT NULL REFERENCES public.paystub_runs(id) ON DELETE CASCADE,
  employee_name TEXT,
  email         TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'sent', 'failed', 'bounced')),
  error_message TEXT,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX paystub_deliveries_run_id_idx ON public.paystub_deliveries (run_id);
CREATE INDEX paystub_deliveries_email_idx  ON public.paystub_deliveries (email);
```

---

## 5. API Routes to Build

### 5.1 `POST /api/trigger-paystub-email`

Called by the PayrollWizard at Step 5 (Dispatch). Creates a `paystub_runs` row and fires the n8n webhook.

**Request body:**
```json
{
  "cycleLabel": "April 13–19, 2026",
  "employeePaystubs": [
    {
      "name": "Juan Dela Cruz",
      "email": "juan@company.com",
      "department": "Accounting",
      "regularHours": 40.00,
      "otHours": 3.50,
      "regularRate": 1200,
      "otRate": 1500,
      "regularPay": 48000,
      "otPay": 5250,
      "bonuses": 1850,
      "totalPay": 55100
    }
  ]
}
```

**What it does:**
1. Inserts a row into `paystub_runs` (status = `queued`)
2. Inserts one row per employee into `paystub_deliveries` (status = `pending`)
3. Calls the n8n webhook URL with `{ runId, cycleLabel }`
4. Returns `{ runId, error: null }`

### 5.2 `GET /api/paystub-data`

Called by n8n to fetch the full paystub list for a given run.

**Query params:** `?runId=<uuid>`

**Response:**
```json
{
  "runId": "...",
  "cycleLabel": "April 13–19, 2026",
  "paystubs": [ { ...employee paystub fields } ],
  "error": null
}
```

### 5.3 `POST /api/paystub-callback`

Called by n8n at the end of the workflow to report results.

**Request body:**
```json
{
  "runId": "...",
  "results": [
    { "email": "juan@company.com", "status": "sent", "sentAt": "2026-04-13T14:00:00Z" },
    { "email": "failed@company.com", "status": "failed", "error": "Invalid address" }
  ]
}
```

**What it does:**
1. Updates each matching `paystub_deliveries` row
2. Updates `paystub_runs` totals (`sent_count`, `failed_count`, `status`, `completed_at`)
3. Writes to `audit_log` (`action = "paystub.email.sent"`)

---

## 6. n8n Workflow — Step by Step

### Nodes in order:

```
[Webhook] → [HTTP Request: GET /api/paystub-data]
          → [Split In Batches: 50 per batch]
          → [Send Email (SMTP): personalized body per employee]
          → [Wait: 500ms]
          → [Merge results]
          → [HTTP Request: POST /api/paystub-callback]
```

### Node Details

#### Node 1 — Webhook (Trigger)
- Method: `POST`
- Path: `/paystub-email`
- Receives: `{ runId, cycleLabel }`

#### Node 2 — HTTP Request (Fetch paystub data)
- Method: `GET`
- URL: `https://your-hris-domain.com/api/paystub-data?runId={{ $json.runId }}`
- Authentication: Bearer token (shared secret in env var)

#### Node 3 — Split In Batches
- Batch size: `50`
- Iterates over `paystubs` array

#### Node 4 — Send Email (SMTP)
- **From:** `payroll@yourcompany.com`
- **To:** `{{ $json.email }}`
- **Subject:** `Your Paystub — {{ $json.cycleLabel }}`
- **Body (HTML):** See Section 7

#### Node 5 — Wait
- Duration: `500ms`
- Prevents hitting SMTP rate limits between batches

#### Node 6 — HTTP Request (Callback)
- Method: `POST`
- URL: `https://your-hris-domain.com/api/paystub-callback`
- Body: aggregated results array

---

## 7. Paystub Email HTML Template

The email body is built inside n8n using expressions. Example structure:

```html
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: #f97316; padding: 20px; color: white;">
    <h1 style="margin: 0;">Paystub — {{ $json.cycleLabel }}</h1>
  </div>

  <div style="padding: 24px;">
    <p>Hi <strong>{{ $json.name }}</strong>,</p>
    <p>Here is your paystub for the cycle ending <strong>{{ $json.cycleLabel }}</strong>.</p>

    <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
      <tr style="background: #f4f4f4;">
        <th style="padding: 8px; text-align: left;">Description</th>
        <th style="padding: 8px; text-align: right;">Hours</th>
        <th style="padding: 8px; text-align: right;">Rate</th>
        <th style="padding: 8px; text-align: right;">Amount</th>
      </tr>
      <tr>
        <td style="padding: 8px;">Regular Pay</td>
        <td style="padding: 8px; text-align: right;">{{ $json.regularHours }}</td>
        <td style="padding: 8px; text-align: right;">₱{{ $json.regularRate }}</td>
        <td style="padding: 8px; text-align: right;">₱{{ $json.regularPay }}</td>
      </tr>
      <tr>
        <td style="padding: 8px;">Overtime Pay</td>
        <td style="padding: 8px; text-align: right;">{{ $json.otHours }}</td>
        <td style="padding: 8px; text-align: right;">₱{{ $json.otRate }}</td>
        <td style="padding: 8px; text-align: right;">₱{{ $json.otPay }}</td>
      </tr>
      <tr>
        <td style="padding: 8px;">Bonuses</td>
        <td style="padding: 8px; text-align: right;">—</td>
        <td style="padding: 8px; text-align: right;">—</td>
        <td style="padding: 8px; text-align: right;">₱{{ $json.bonuses }}</td>
      </tr>
      <tr style="background: #fff7ed; font-weight: bold;">
        <td style="padding: 8px;" colspan="3">Total Pay</td>
        <td style="padding: 8px; text-align: right;">₱{{ $json.totalPay }}</td>
      </tr>
    </table>

    <p style="margin-top: 24px; font-size: 12px; color: #888;">
      Department: {{ $json.department }}<br/>
      This is a system-generated paystub. Do not reply to this email.
    </p>
  </div>
</div>
```

---

## 8. PayrollWizard Integration

In **Step 5 (Dispatch)** of the PayrollWizard, after the existing confirmation logic, add a call to `POST /api/trigger-paystub-email` with the computed `effectiveCalcResults` and bonus totals merged into a single paystub array.

The Dispatch button should transition through these states:
1. `Dispatching payroll…` (existing)
2. `Queueing paystub emails…`
3. `Done — emails queued for {n} employees`

A non-blocking toast is shown if the email trigger fails (payroll dispatch itself should not be blocked by email failures).

---

## 9. Security

| Concern | Solution |
|---|---|
| n8n calling `/api/paystub-data` unauthenticated | Shared secret in `Authorization: Bearer <token>` header; verified in the route |
| Paystub data exposure | The `/api/paystub-data` route only returns data for a valid `runId` that is in `queued` or `sending` status |
| n8n callback spoofing | Same shared secret verified on `/api/paystub-callback` |
| Secret storage | Store as `N8N_WEBHOOK_SECRET` in `.env`; never commit to git |

---

## 10. Implementation Phases

### Phase 1 — Backend Foundation
| # | Task |
|---|---|
| 1.1 | Run SQL migrations for `paystub_runs` and `paystub_deliveries` |
| 1.2 | Create `POST /api/trigger-paystub-email` route |
| 1.3 | Create `GET /api/paystub-data` route |
| 1.4 | Create `POST /api/paystub-callback` route |
| 1.5 | Add `N8N_WEBHOOK_URL` and `N8N_WEBHOOK_SECRET` to `.env` |

### Phase 2 — n8n Workflow
| # | Task |
|---|---|
| 2.1 | Create n8n Webhook trigger node |
| 2.2 | Add HTTP Request node to fetch paystub data |
| 2.3 | Configure Split in Batches node (50 per batch) |
| 2.4 | Configure Send Email (SMTP) node with HTML template |
| 2.5 | Add Wait node (500ms between batches) |
| 2.6 | Add HTTP Request node for callback |
| 2.7 | Configure SMTP credentials in n8n |
| 2.8 | Test with 5 employees, then 50, then full list |

### Phase 3 — PayrollWizard Integration
| # | Task |
|---|---|
| 3.1 | Add `trigger-paystub-email` call in Step 5 Dispatch handler |
| 3.2 | Add email queue status to Dispatch UI (toast / status badge) |
| 3.3 | Add paystub run history viewer in a new Settings or Reports tab |

### Phase 4 — Monitoring
| # | Task |
|---|---|
| 4.1 | Audit log entries visible in System Settings for every paystub run |
| 4.2 | Failed delivery list accessible by admin (from `paystub_deliveries` where status = 'failed') |
| 4.3 | Manual re-send endpoint for individual failed deliveries |

---

## 11. Environment Variables to Add

```env
N8N_WEBHOOK_URL=https://your-n8n-instance.com/webhook/paystub-email
N8N_WEBHOOK_SECRET=your-shared-secret-here
```

---

## 12. Testing Checklist

- [ ] Single employee paystub email received and formatted correctly
- [ ] Batch of 50 processed without SMTP rate limit errors
- [ ] Full 1,000 employee run completes within expected time
- [ ] Failed emails recorded in `paystub_deliveries` with error message
- [ ] `paystub_runs` status updates correctly (queued → sending → done/partial)
- [ ] Audit log captures the run with sent/failed counts
- [ ] Dispatch in PayrollWizard is not blocked if n8n webhook is unreachable
- [ ] `/api/paystub-data` rejects requests with invalid or missing token
- [ ] Suspended employees are excluded from the paystub list
