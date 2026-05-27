# Discussion Summary — Antigravity / Simple HRIS · 2026-05-13

This document captures the key decisions, requirements, and next steps agreed upon during today's session. Intended for audit and implementation tracking.

---

## I. Payroll Delegation Logic (Lenny & Claire)

### Dispatch Views
The Dispatch step needs separate views to delegate payroll responsibilities:

| Person | Responsibility |
|--------|---------------|
| **Claire** | US pay — anyone marked as a US Manager (USD currency) |
| **Lenny** | PHP and ZAR currency pay |

### Dev / Contractor Pay Processing
- **Claire**: Reviews and processes US Dev invoices (USD). Sets up *and* pays them.
- **Lenny**: Reviews and processes PHP Dev invoices and ZAR currency invoices. Pays only (does not set up).

---

## II. Contractor Management & Dashboard

Contractors are not employees — they require a separate, restricted dashboard.

### Department rename
`Devs` → `Contractors` (updated across HRIS, PayrollWizard, and Global Master list).

### Contractor Dashboard tabs
1. **Overview** — summary stats (invoices created, total billed)
2. **Profile** — bank info (name, account number, routing/SWIFT, address). This info **pre-fills** the invoice form.
3. **Invoice Form** (create new invoice)
4. **Invoice History** (past submissions with status)

### Exclusions from Contractor view
Contractors do **not** see: Announcements, Policies, Leave, My Hours, PAB / Tech bonus information.

---

## III. Contractor Invoice Form Requirements

### Field changes
| Field | Requirement |
|-------|-------------|
| Entity Name | Label as **Entity** to cover both personal names and company LLCs |
| Invoice Number | Auto-generated unique code (format: `C-<initials>-<sequence>`) |
| Bill To | Hardcoded: `Simple.biz · Remote, USA` — no City/State/Zip entry |
| Terms & Conditions | **Remove** — covered in onboarding paperwork |
| Payment Gateway | **Remove** from form — bank info lives in Profile only |

### Line items
- Unlimited clickable rows (already implemented)
- Description must include the website name or URL for the delivered work
- Claire needs a **"Checked" field** per row to mark that the work was verified (site delivered, not under construction)

### Submission flow
- Final button: **"Send to Accounting"** (not "Save Invoice")
- Submitted invoice → `contractor_invoices` table with `status = 'pending'`
- Invoice appears in **PayrollWizard → Contractors tab** for Claire to review

---

## IV. PayrollWizard — Contractors Tab

A new **Step 5 "Contractors"** is inserted between Orphanage (step 4) and Validation (step 6).

- Lists all pending contractor invoices
- Approve / Reject per invoice
- Approved invoices roll up into the **Validation** step's Total Weekly Outflow
- Approved invoices appear in the **Preview Emails** dialog under a "Contractors" tab
- Claire separates USD invoices; Lenny handles PHP/ZAR

---

## V. Orphanage Budget Request — Dispatch Email

The dispatch email for orphanage budget requests must include:
- **Name of the orphanage**
- **Budget Details** (what the budget is for) in the Notes field

Gifts are handled by a third party and are **not** part of payroll dispatch — they should not appear in the dispatch payload.

---

## VI. Administrative / Access Control

| Item | Decision |
|------|---------|
| AI API Team | Members (Abby Sabino, Dustin, Franco) under "Devs" → move to **AI API** in Global Master list |
| Access restriction | Rates and employee profiles in Accounting must be restricted from Jeff and AI API team members |
| Offboarding | New off-boarding automation confirmed working (3 people successfully off-boarded) |

---

## VII. Items Confirmed Implemented Today

- [x] Department renamed `Devs` → `AI/API Team` in PayrollWizard
- [x] Contractor switch view / dashboard created
- [x] Invoice form: unlimited row line items
- [x] Invoice form: Bill To hardcoded to `Simple.biz · Remote, USA`
- [x] Contractor Profile: bank / payment gateway fields — saving confirmed working
- [x] Invoice form: "Send to Accounting" button (pending deploy)
- [x] PayrollWizard: Contractors step added (pending deploy)
- [x] Off-boarding automation: working

---

## VIII. Open / Pending Items

- [ ] Auto-generate invoice number (`C-<initials>-<sequence>`)
- [ ] "Checked" field per invoice line item (for Claire's verification workflow)
- [ ] Separate Dispatch views for Claire (USD) vs Lenny (PHP/ZAR)
- [ ] Restrict Rates / profile access from AI API team and Jeff
- [ ] Move AI API team members from "Devs" → "AI API" in Global Master list
- [ ] Orphanage dispatch email: include orphanage name + Budget Details in Notes
- [ ] Remove Gifts from Dispatch payload
