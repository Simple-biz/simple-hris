# Documents tab (Accounting) + Employee "Request Documents"

*Added 2026-07-18.*

Employees need officially signed paperwork for real-life needs — filing taxes, bank/housing
loans, visa and immigration checks. This feature lets an employee submit a PDF to Accounting,
and lets the Accounting Head sign it with a saved, revocable signature. The signed copy is
returned to the employee carrying both the **requested date** and the **signed date** (plus a
reference id), so the document can be verified as real.

## Flow

1. **Employee → Profile → Request Documents** ([RequestDocumentsTab.tsx](../../src/components/employee/RequestDocumentsTab.tsx))
   - Picks a type: **Pay Stubs** / **COE** / **Award-Certificate** / Other.
   - Pay Stubs are **auto-generated in the browser** from the same statements as the Pay Stubs
     tab (`GET /api/employee/paystub?all=1` → `generatePayStubsPdf`), scoped to a chosen period
     (3 / 6 / 12 months / all) and attached; other types attach an uploaded PDF (≤ 4 MB).
   - Submit → `POST /api/employee/documents` (multipart) → `document_requests` row, `pending`.
   - The same tab lists the employee's requests with live status, a **Cancel** for pending ones,
     and — once signed — a **"Signed document"** download.
2. **Accounting → Documents** ([AccountingDocuments.tsx](../../src/components/accounting/AccountingDocuments.tsx))
   - Queue of all requests (Pending / Signed / Rejected filters), live via Realtime + poll.
   - Preview the submitted PDF (inline signed URL), then **Approve & sign** or **Reject** (a
     reason is required and is sent to the employee).
3. **Signing** ([sign-pdf.ts](../../src/lib/documents/sign-pdf.ts))
   - Appends a **certification page** to the original PDF (never redraws the submitted pages):
     Simple masthead, employee + document details, **Requested on** / **Signed on** (Manila
     time), the request id as a verifiable **Reference ID**, the signer's drawn signature with
     printed name + title, and a verification footer. A one-line pointer is stamped at the very
     bottom edge of the last original page.
   - The signed copy is stored next to the original; the employee gets a `documents.signed`
     notification ("returned back as a signed document").

## The signature (Carla's)

[signatures.ts](../../src/lib/documents/signatures.ts) + the signature card in the Documents tab:

- On first visit with edit access and no saved signature, the tab **auto-opens the capture
  dialog** — the "Carla would be prompted for her signature" requirement.
- She draws it on a canvas ([SignaturePad.tsx](../../src/components/common/SignaturePad.tsx));
  it's saved to Supabase (`document_signatures`, PNG data URL, one row per signer) with a
  printed name + title (default "Accounting Head").
- The **Active/Revoked switch** is the revoke: while off (or while no row exists) approvals are
  blocked server-side (`412`) and the UI steers into the capture dialog instead.
- Approvals always stamp the **approver's own** row — nobody can sign with someone else's
  signature.

## Storage

Private bucket `document-requests` (10 MB, `application/pdf` only, service-role access;
downloads via 1-hour signed URLs):

```
<sanitized-email>/<request-id>/original.pdf   ← exactly as submitted, never mutated
<sanitized-email>/<request-id>/signed.pdf     ← original + certification page
```

## RBAC / registries

The tab is registered per the house checklist: `ACCOUNTING_TAB_IDS` + `TAB_TO_FEATURE`
([accounting-tabs.ts](../../src/lib/rbac/accounting-tabs.ts)), `FEATURE_CATALOG.accounting`
(`documents`) ([feature-permissions.ts](../../src/lib/rbac/feature-permissions.ts)),
`VIEW_TAB_IDS.accounting` ([view-tabs.ts](../../src/lib/rbac/view-tabs.ts)), `DASHBOARD_PAGES`
([visibility.ts](../../src/lib/pages/visibility.ts)), the accounting sidebar, and the App render
switch. Default-deny: after deploy, **grant Accounting → Documents (edit) to the Accounting
Head** from Admin → Roles (admins always see it). Reads need `view`, decisions and signature
changes need `edit` (`requireFeatureAccess('accounting','documents', …)`); the employee routes
are session-scoped only.

## Notifications

`documents.requested` → accounting/admin role holders, **feature-gated** on the Documents grant
(only people with the tab get pinged); `documents.signed` / `documents.rejected` → the employee
(ungated). Mapped in [notification-views.ts](../../src/lib/notifications/notification-views.ts);
types added to the `employee_notifications` CHECK by the migration.

## Deploy

1. Run [`references/sql/migrate/2026-07-18_documents_tab.sql`](../../references/sql/migrate/2026-07-18_documents_tab.sql)
   in the Supabase SQL editor (creates the bucket + both tables, adds Realtime, restates the
   notification-type CHECK with the three `documents.*` types).
2. Grant **Accounting → Documents = Edit** to the Accounting Head (Carla) in Admin → Roles
   (or uncomment the seed block at the bottom of the migration).

## Audit trail

`documents.request_submitted` / `request_cancelled` / `request_signed` / `request_rejected` and
`documents.signature_saved` / `signature_enabled` / `signature_revoked` / `signature_updated`
in `audit_log`.

## Tests

[sign-pdf.test.ts](../../src/lib/documents/sign-pdf.test.ts) — certification page count/size
(portrait + landscape), WinAnsi sanitizing, corrupt-signature and non-PDF rejection.
