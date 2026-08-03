# Employee Overview "Details" — Pay Snapshot Grid + Download PDF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Employee → Overview "Details" popup's "Pay snapshot" list into a tile grid and add a button that downloads it as a one-page portrait PDF.

**Architecture:** A new, small, self-contained pdf-lib module (`src/lib/payroll/pay-snapshot-pdf.ts`) renders a fixed one-page portrait document from pre-formatted `{ label, value }` rows; `EmployeeDashboard.tsx` builds those rows from figures it already computes, restyles the same rows on screen as a 2-column tile grid, and adds a download button next to the "Pay snapshot" label that calls the new module.

**Tech Stack:** Next.js/React (TSX), Tailwind classes (existing conventions only), `pdf-lib`, the shared `embedPdfFonts`/`embedSimpleLogo` helpers, `node:test` for unit tests.

## Global Constraints

- Spec: [`docs/superpowers/specs/2026-08-03-employee-pay-snapshot-grid-pdf-design.md`](../specs/2026-08-03-employee-pay-snapshot-grid-pdf-design.md).
- Scope is the "Pay snapshot" section only — the PAB status card and Tech bonus status card in the same dialog are untouched.
- PDF content is the Pay snapshot figures only, always exactly one page, portrait US Letter (`PAGE_W = 612`, `PAGE_H = 792`).
- Use `embedPdfFonts` (real ₱) and `embedSimpleLogo` — not the older Helvetica + "PHP " fallback.
- The PDF must carry the disclaimer: this is an estimate, not the official pay stub.
- No new API routes, no schema changes, no changes to how the underlying figures are calculated.
- Grid tile colors reuse the existing palette: PAB indigo, Tech sky, MESA teal, plain zinc for hours/pay — no new colors invented.
- The component (`EmployeeDashboard.tsx`) is the single source of truth for each row's display value — the PDF module never re-derives a conditional (e.g. "pending PAB shows —") from raw numbers; it only draws the strings it's given.

---

## Task 1: Pay Summary PDF module

**Files:**
- Create: `src/lib/payroll/pay-snapshot-pdf.ts`
- Test: `src/lib/payroll/pay-snapshot-pdf.test.ts`

**Interfaces:**
- Consumes: `embedPdfFonts(doc)` from `src/lib/pdf/fonts.ts` (returns `{ regular, bold, unicode, sanitize }`); `embedSimpleLogo(doc)` and `simpleLogoWidthForHeight(height)` from `src/lib/pdf/logo.ts`.
- Produces (used by Task 2):
  ```ts
  export interface PaySnapshotPdfRow { label: string; value: string; }
  export interface PaySnapshotTotal { label: string; value: string; }
  export interface PaySnapshotPdfInput {
    employeeName: string;
    department?: string | null;
    weekLabel: string;
    rows: PaySnapshotPdfRow[];
    totalLabel: string;
    totalValue: string;
    usdEquivalent?: string | null;
    extraPayout?: PaySnapshotTotal | null;
    grandTotal?: PaySnapshotTotal | null;
  }
  export async function generatePaySnapshotPdf(input: PaySnapshotPdfInput, generatedAt: Date): Promise<Uint8Array>
  export async function downloadPaySnapshotPdf(input: PaySnapshotPdfInput, generatedAt?: Date): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/payroll/pay-snapshot-pdf.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { generatePaySnapshotPdf, type PaySnapshotPdfInput } from './pay-snapshot-pdf';

const SAMPLE: PaySnapshotPdfInput = {
  employeeName: 'Juan Dela Cruz',
  department: 'HSL',
  weekLabel: 'Jul 28 - Aug 3, 2026',
  rows: [
    { label: 'Total hours', value: '42.50h' },
    { label: 'Regular pay', value: '₱5,250.00' },
    { label: 'OT pay', value: '—' },
    { label: 'PAB', value: '+₱2,000.00' },
    { label: 'Tech bonus', value: '₱0.00' },
  ],
  totalLabel: 'Total',
  totalValue: '₱7,250.00',
  usdEquivalent: '≈ 130.00 USD',
};

const GENERATED_AT = new Date('2026-08-03T08:12:00.000Z');

test('renders a loadable, exactly-one-page PDF with the right title', async () => {
  const bytes = await generatePaySnapshotPdf(SAMPLE, GENERATED_AT);
  assert.ok(bytes.byteLength > 500, 'produced a non-trivial PDF');
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 1);
  assert.equal(reloaded.getTitle(), 'Pay Summary — Juan Dela Cruz');
});

test('the peso sign survives into the PDF (real ₱, not "PHP " fallback)', async () => {
  const { embedPdfFonts } = await import('@/lib/pdf/fonts');
  const doc = await PDFDocument.create();
  const fonts = await embedPdfFonts(doc);
  assert.equal(fonts.unicode, true, 'the Noto Sans subset must embed');
  assert.equal(fonts.sanitize('₱225.00'), '₱225.00');
});

test('renders the MESA emergency-payout variant (extraPayout + grandTotal) on one page', async () => {
  const withPayout: PaySnapshotPdfInput = {
    ...SAMPLE,
    totalLabel: 'Take-home',
    extraPayout: { label: 'MESA emergency payout', value: '+₱3,000.00' },
    grandTotal: { label: 'Total deposited', value: '₱10,250.00' },
  };
  const bytes = await generatePaySnapshotPdf(withPayout, GENERATED_AT);
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 1);
});

test('renders with no department and no usdEquivalent (all-time view)', async () => {
  const minimal: PaySnapshotPdfInput = {
    employeeName: 'Maria Santos',
    weekLabel: 'All time · combined',
    rows: [{ label: 'Total hours', value: '0.00h' }],
    totalLabel: 'Total',
    totalValue: '₱0.00',
  };
  const bytes = await generatePaySnapshotPdf(minimal, GENERATED_AT);
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test src/lib/payroll/pay-snapshot-pdf.test.ts`
Expected: FAIL — `Cannot find module './pay-snapshot-pdf'` (the module doesn't exist yet).

- [ ] **Step 3: Implement the module**

Create `src/lib/payroll/pay-snapshot-pdf.ts`:

```ts
// Employee Overview "Details" popup — a one-page PDF of the current pay
// week's ESTIMATE. Distinct from paystub-export.ts's generatePayStubsPdf,
// which renders the OFFICIAL, payroll-confirmed statement (landscape,
// multi-week, built from a full PayStubView). EmployeeDashboard's Pay
// snapshot numbers are locally-computed estimates with no PayStubView to
// hand it, so this is its own small module — portrait, single page, and
// explicit on the page that it's an estimate.
//
// Follows coe-document.ts's conventions (portrait Letter, embedPdfFonts for
// a real peso sign, embedSimpleLogo) rather than paystub-export.ts's older
// Helvetica + "PHP " sanitize fallback.

import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import { embedPdfFonts } from '@/lib/pdf/fonts';
import { embedSimpleLogo, simpleLogoWidthForHeight } from '@/lib/pdf/logo';

type Color = ReturnType<typeof rgb>;

const PAGE_W = 612; // US Letter, portrait
const PAGE_H = 792;
const MARGIN = 64;

const NAVY: Color = rgb(0.13, 0.15, 0.33);
const TEXT: Color = rgb(0.12, 0.12, 0.15);
const MUTED: Color = rgb(0.42, 0.42, 0.48);
const FAINT: Color = rgb(0.58, 0.58, 0.64);
const HAIRLINE: Color = rgb(0.9, 0.9, 0.93);
const BORDER: Color = rgb(0.86, 0.86, 0.9);
const EMERALD: Color = rgb(0.02, 0.36, 0.24);

export interface PaySnapshotPdfRow {
  label: string;
  /** Already formatted for display, e.g. "42.50h", "₱5,250.00", "—", "+₱2,000.00". */
  value: string;
}

export interface PaySnapshotTotal {
  label: string;
  value: string;
}

export interface PaySnapshotPdfInput {
  employeeName: string;
  department?: string | null;
  /** e.g. "Jul 28 - Aug 3, 2026" or "All time · combined". */
  weekLabel: string;
  /** One entry per visible grid tile, same order as on screen. */
  rows: PaySnapshotPdfRow[];
  totalLabel: string;
  totalValue: string;
  usdEquivalent?: string | null;
  /** The MESA-emergency-payout variant: an extra payout row + a grand total. */
  extraPayout?: PaySnapshotTotal | null;
  grandTotal?: PaySnapshotTotal | null;
}

/** "August 3, 2026, 4:12 PM GMT+8" (viewer's local time), matching paystub-export.ts. */
function formatTimestamp(d: Date): string {
  try {
    return d.toLocaleString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
  } catch {
    return d.toLocaleString();
  }
}

/** YYYY-MM-DD for filename suffixes. */
function dateSuffix(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** kebab filename stem from a person's name. */
function slug(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'employee';
}

/** Build the one-page Pay Summary PDF. There is exactly one `addPage` call
 *  below and no pagination loop, so this is always exactly one page. */
export async function generatePaySnapshotPdf(
  input: PaySnapshotPdfInput,
  generatedAt: Date,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Pay Summary — ${input.employeeName}`);
  doc.setAuthor('Simple');
  doc.setSubject('Pay Summary (estimate)');
  doc.setCreator('Simple HRIS');
  doc.setProducer('Simple HRIS');

  const { regular, bold, sanitize } = await embedPdfFonts(doc);
  const logo = await embedSimpleLogo(doc);

  const page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const text = (
    raw: string,
    x: number,
    baseline: number,
    opts: { size?: number; font?: PDFFont; color?: Color } = {},
  ) => {
    const size = opts.size ?? 10.5;
    const font = opts.font ?? regular;
    page.drawText(sanitize(raw), { x, y: baseline, size, font, color: opts.color ?? TEXT });
  };

  const right = (
    raw: string,
    rightEdge: number,
    baseline: number,
    opts: { size?: number; font?: PDFFont; color?: Color } = {},
  ) => {
    const size = opts.size ?? 10.5;
    const font = opts.font ?? regular;
    const s = sanitize(raw);
    const w = font.widthOfTextAtSize(s, size);
    page.drawText(s, { x: rightEdge - w, y: baseline, size, font, color: opts.color ?? TEXT });
  };

  // ── Masthead ─────────────────────────────────────────────────────────────
  if (logo) {
    const h = 26;
    const w = simpleLogoWidthForHeight(h);
    page.drawImage(logo, { x: MARGIN, y: y - h, width: w, height: h });
  } else {
    text('Simple', MARGIN, y - 20, { size: 20, font: bold, color: NAVY });
  }
  right('Pulled from Simple HRIS', PAGE_W - MARGIN, y - 8, { size: 9, font: bold, color: NAVY });
  right(`Generated ${formatTimestamp(generatedAt)}`, PAGE_W - MARGIN, y - 20, { size: 8, color: MUTED });
  y -= 42;

  text('PAY SUMMARY', MARGIN, y, { size: 17, font: bold, color: NAVY });
  y -= 17;
  const who = input.department ? `${input.employeeName} · ${input.department}` : input.employeeName;
  text(who, MARGIN, y, { size: 10.5, color: MUTED });
  y -= 14;
  text(input.weekLabel, MARGIN, y, { size: 10.5, font: bold, color: TEXT });
  y -= 10;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1.3, color: NAVY });
  y -= 22;

  // ── Rows ─────────────────────────────────────────────────────────────────
  const ROW_H = 22;
  for (const row of input.rows) {
    text(row.label, MARGIN, y, { size: 10, color: MUTED });
    right(row.value, PAGE_W - MARGIN, y, { size: 10.5, font: bold, color: TEXT });
    y -= 9;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: HAIRLINE });
    y -= ROW_H - 9;
  }

  // ── Total ────────────────────────────────────────────────────────────────
  y -= 4;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1.3, color: NAVY });
  y -= 20;
  text(input.totalLabel, MARGIN, y, { size: 12, font: bold, color: NAVY });
  right(input.totalValue, PAGE_W - MARGIN, y, { size: 14, font: bold, color: EMERALD });
  if (input.usdEquivalent) {
    y -= 15;
    right(input.usdEquivalent, PAGE_W - MARGIN, y, { size: 9, color: MUTED });
  }

  if (input.extraPayout) {
    y -= 22;
    text(input.extraPayout.label, MARGIN, y, { size: 10, color: MUTED });
    right(input.extraPayout.value, PAGE_W - MARGIN, y, { size: 10.5, font: bold, color: TEXT });
  }
  if (input.grandTotal) {
    y -= 20;
    page.drawLine({ start: { x: MARGIN, y: y + 8 }, end: { x: PAGE_W - MARGIN, y: y + 8 }, thickness: 0.7, color: BORDER });
    text(input.grandTotal.label, MARGIN, y, { size: 12, font: bold, color: NAVY });
    right(input.grandTotal.value, PAGE_W - MARGIN, y, { size: 14, font: bold, color: EMERALD });
  }

  // ── Disclaimer ───────────────────────────────────────────────────────────
  y -= 34;
  text('Estimated figures — not an official pay stub.', MARGIN, y, { size: 9, color: FAINT });
  y -= 12;
  text('Your confirmed pay statement is available under Open Paystubs once processed.', MARGIN, y, { size: 9, color: FAINT });

  // ── Footer ───────────────────────────────────────────────────────────────
  page.drawLine({ start: { x: MARGIN, y: 40 }, end: { x: PAGE_W - MARGIN, y: 40 }, thickness: 0.5, color: BORDER });
  text('Confidential pay estimate · Simple HRIS', MARGIN, 28, { size: 8, color: MUTED });
  right('Page 1 of 1', PAGE_W - MARGIN, 28, { size: 8, color: MUTED });

  return doc.save();
}

function downloadBlob(filename: string, blob: Blob): void {
  if (typeof window === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 200);
}

/** Build + download the Pay Summary PDF in the browser. */
export async function downloadPaySnapshotPdf(
  input: PaySnapshotPdfInput,
  generatedAt: Date = new Date(),
): Promise<void> {
  const bytes = await generatePaySnapshotPdf(input, generatedAt);
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  downloadBlob(
    `pay-summary-${slug(input.employeeName)}-${dateSuffix(generatedAt)}.pdf`,
    new Blob([ab], { type: 'application/pdf' }),
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test src/lib/payroll/pay-snapshot-pdf.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run lint`
Expected: no errors.

```bash
git add src/lib/payroll/pay-snapshot-pdf.ts src/lib/payroll/pay-snapshot-pdf.test.ts
git commit -m "feat(employee): add one-page Pay Summary PDF module"
```

---

## Task 2: Grid + download button in the Details popup

**Files:**
- Modify: `src/components/employee/EmployeeDashboard.tsx`

**Interfaces:**
- Consumes: `downloadPaySnapshotPdf`, `PaySnapshotPdfRow` from `src/lib/payroll/pay-snapshot-pdf.ts` (Task 1).
- Consumes (already in this file, unchanged): `row`, `totalHours`, `regularPay`, `otPay`, `otHours`, `perfectAttendanceBonusStatus`, `pabBonusAmount`, `technologyBonusAmount`, `mesaDeductionPhp`, `mesaDisbursementPhp`, `takeHomePhp`, `totalDepositedPhp`, `usdToPhpRate`, `profileForShipping`, `selectedFile`, `formatSourceFileLabel`, `formatPHP`.
- Produces: nothing consumed by later tasks (this is the last task).

- [ ] **Step 1: Add the new imports**

In the lucide-react import block
([`EmployeeDashboard.tsx:5-18`](../../../src/components/employee/EmployeeDashboard.tsx#L5-L18)), add `Download`:

```ts
import {
  AlertCircle,
  CalendarDays,
  ChevronDown,
  Loader2,
  CheckCircle2,
  XCircle,
  Info,
  Laptop,
  RefreshCw,
  CircleHelp,
  Sparkles,
  Receipt,
  Download,
} from 'lucide-react';
```

Right after the `normalizeDeptToKey` import
([`EmployeeDashboard.tsx:44`](../../../src/components/employee/EmployeeDashboard.tsx#L44)), add:

```ts
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { downloadPaySnapshotPdf, type PaySnapshotPdfRow } from '@/lib/payroll/pay-snapshot-pdf';
```

- [ ] **Step 2: Add download state and the handler**

Find the `mobileHelpOpen` state
([`EmployeeDashboard.tsx:655-656`](../../../src/components/employee/EmployeeDashboard.tsx#L655-L656)):

```tsx
  /** Mobile: PAB rules, bonus status, and pay numbers live in this sheet (charts stay on the main view). */
  const [mobileHelpOpen, setMobileHelpOpen] = useState(false);
```

Replace with (adds the new state and, right after it, the handler that builds the PDF input the
same way the JSX below renders each row):

```tsx
  /** Mobile: PAB rules, bonus status, and pay numbers live in this sheet (charts stay on the main view). */
  const [mobileHelpOpen, setMobileHelpOpen] = useState(false);
  /** True while the Pay snapshot PDF is being generated (Details popup download button). */
  const [snapshotDownloading, setSnapshotDownloading] = useState(false);

  /** Build this week's Pay Summary PDF from the exact same figures/branches the
   *  Pay snapshot grid below renders, then trigger a browser download. */
  const handleDownloadSnapshot = async () => {
    if (!row) return;
    setSnapshotDownloading(true);
    try {
      const rows: PaySnapshotPdfRow[] = [
        { label: 'Total hours', value: `${totalHours.toFixed(2)}h` },
        { label: 'Regular pay', value: regularPay != null ? formatPHP(regularPay) : '—' },
        {
          label: 'OT pay',
          value: otPay != null ? formatPHP(otPay) : otHours > 0 ? '—' : formatPHP(0),
        },
        {
          label: 'PAB',
          value:
            perfectAttendanceBonusStatus === 'pending'
              ? '—'
              : pabBonusAmount > 0
                ? `+${formatPHP(pabBonusAmount)}`
                : formatPHP(0),
        },
        {
          label: 'Tech bonus',
          value: technologyBonusAmount > 0 ? `+${formatPHP(technologyBonusAmount)}` : formatPHP(0),
        },
      ];
      if (mesaDeductionPhp > 0) {
        rows.push({ label: 'MESA contribution', value: `−${formatPHP(mesaDeductionPhp)}` });
      }

      await downloadPaySnapshotPdf({
        employeeName: profileForShipping.name || 'Employee',
        department: profileForShipping.department,
        weekLabel:
          selectedFile === null || selectedFile === '__all__'
            ? 'All time · combined'
            : formatSourceFileLabel(selectedFile),
        rows,
        totalLabel: mesaDisbursementPhp > 0 ? 'Take-home' : 'Total',
        totalValue: takeHomePhp != null ? formatPHP(takeHomePhp) : '—',
        usdEquivalent:
          takeHomePhp != null
            ? `≈ ${(takeHomePhp / usdToPhpRate).toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })} USD`
            : null,
        extraPayout:
          mesaDisbursementPhp > 0
            ? { label: 'MESA emergency payout', value: `+${formatPHP(mesaDisbursementPhp)}` }
            : null,
        grandTotal:
          mesaDisbursementPhp > 0
            ? {
                label: 'Total deposited',
                value: totalDepositedPhp != null ? formatPHP(totalDepositedPhp) : '—',
              }
            : null,
      });
    } finally {
      setSnapshotDownloading(false);
    }
  };
```

- [ ] **Step 3: Add the download button next to the "Pay snapshot" label**

Find ([`EmployeeDashboard.tsx:3604-3606`](../../../src/components/employee/EmployeeDashboard.tsx#L3604-L3606)):

```tsx
                <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
                  Pay snapshot
                </p>
```

Replace with:

```tsx
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
                    Pay snapshot
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleDownloadSnapshot()}
                    disabled={snapshotDownloading}
                    aria-label="Download pay summary PDF"
                    title="Download this week's pay summary as a PDF"
                    className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-[10px] font-medium text-zinc-600 shadow-sm transition hover:border-orange-300 hover:text-orange-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-orange-800 dark:hover:text-orange-300"
                  >
                    {snapshotDownloading ? (
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    ) : (
                      <Download className="h-3 w-3" aria-hidden />
                    )}
                    {snapshotDownloading ? 'Preparing…' : 'PDF'}
                  </button>
                </div>
```

- [ ] **Step 4: Turn the itemized rows into a tile grid**

Find the six row blocks between the wrapper div and the divider
([`EmployeeDashboard.tsx:3608-3647`](../../../src/components/employee/EmployeeDashboard.tsx#L3608-L3647),
just inside `<div className="space-y-2 text-xs">` and just before
`<div className="my-1 h-px bg-zinc-200 dark:bg-zinc-800" />`):

```tsx
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">Total hours</span>
                    <span className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{totalHours.toFixed(2)}h</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">Regular pay</span>
                    <span className="tabular-nums text-zinc-800 dark:text-zinc-200">
                      {regularPay != null ? formatPHP(regularPay) : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">OT pay</span>
                    <span className="tabular-nums text-zinc-800 dark:text-zinc-200">
                      {otPay != null ? formatPHP(otPay) : otHours > 0 ? '—' : formatPHP(0)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">PAB</span>
                    <span className="tabular-nums text-zinc-800 dark:text-zinc-200">
                      {perfectAttendanceBonusStatus === 'pending'
                        ? '—'
                        : pabBonusAmount > 0
                          ? `+${formatPHP(pabBonusAmount)}`
                          : formatPHP(0)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">Tech bonus</span>
                    <span className="tabular-nums text-zinc-800 dark:text-zinc-200">
                      {technologyBonusAmount > 0 ? `+${formatPHP(technologyBonusAmount)}` : formatPHP(0)}
                    </span>
                  </div>
                  {mesaDeductionPhp > 0 && (
                    <div className="flex justify-between gap-2">
                      <span className="text-teal-600 dark:text-teal-400">MESA contribution</span>
                      <span className="tabular-nums text-teal-700 dark:text-teal-300">
                        −{formatPHP(mesaDeductionPhp)}
                      </span>
                    </div>
                  )}
```

Replace with:

```tsx
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-zinc-200/80 bg-white/70 px-2.5 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
                      <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                        Total hours
                      </div>
                      <div className="mt-0.5 font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
                        {totalHours.toFixed(2)}h
                      </div>
                    </div>
                    <div className="rounded-lg border border-zinc-200/80 bg-white/70 px-2.5 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
                      <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                        Regular pay
                      </div>
                      <div className="mt-0.5 tabular-nums text-zinc-800 dark:text-zinc-200">
                        {regularPay != null ? formatPHP(regularPay) : '—'}
                      </div>
                    </div>
                    <div className="rounded-lg border border-zinc-200/80 bg-white/70 px-2.5 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
                      <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                        OT pay
                      </div>
                      <div className="mt-0.5 tabular-nums text-zinc-800 dark:text-zinc-200">
                        {otPay != null ? formatPHP(otPay) : otHours > 0 ? '—' : formatPHP(0)}
                      </div>
                    </div>
                    <div className="rounded-lg border border-indigo-200/70 bg-indigo-50/50 px-2.5 py-2 dark:border-indigo-900/40 dark:bg-indigo-950/20">
                      <div className="text-[9px] font-semibold uppercase tracking-wide text-indigo-600/80 dark:text-indigo-400/80">
                        PAB
                      </div>
                      <div className="mt-0.5 tabular-nums text-indigo-800 dark:text-indigo-300">
                        {perfectAttendanceBonusStatus === 'pending'
                          ? '—'
                          : pabBonusAmount > 0
                            ? `+${formatPHP(pabBonusAmount)}`
                            : formatPHP(0)}
                      </div>
                    </div>
                    <div className="rounded-lg border border-sky-200/70 bg-sky-50/50 px-2.5 py-2 dark:border-sky-900/40 dark:bg-sky-950/20">
                      <div className="text-[9px] font-semibold uppercase tracking-wide text-sky-600/80 dark:text-sky-400/80">
                        Tech bonus
                      </div>
                      <div className="mt-0.5 tabular-nums text-sky-800 dark:text-sky-300">
                        {technologyBonusAmount > 0 ? `+${formatPHP(technologyBonusAmount)}` : formatPHP(0)}
                      </div>
                    </div>
                    {mesaDeductionPhp > 0 && (
                      <div className="rounded-lg border border-teal-200/70 bg-teal-50/50 px-2.5 py-2 dark:border-teal-900/40 dark:bg-teal-950/20">
                        <div className="text-[9px] font-semibold uppercase tracking-wide text-teal-600/80 dark:text-teal-400/80">
                          MESA contribution
                        </div>
                        <div className="mt-0.5 tabular-nums text-teal-700 dark:text-teal-300">
                          −{formatPHP(mesaDeductionPhp)}
                        </div>
                      </div>
                    )}
                  </div>
```

The divider, Total/Take-home block, MESA-emergency-payout block, and the two footnote paragraphs
directly below this (unchanged, still lines you'll see immediately after what you just replaced)
are **not** touched by this step.

- [ ] **Step 5: Typecheck**

Run: `npm run lint`
Expected: no errors. If `otHours`, `pabBonusAmount`, etc. show as unused/undefined, the edit
landed in the wrong place — these must resolve to the existing component-level `const`s.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 7: Manual verification**

Run: `npm run dev`, then in a browser:

1. Sign in as an employee and open Overview.
2. Click "Details" (desktop) or the help icon (mobile) to open the "PAB & bonuses" popup.
3. Confirm the Pay snapshot section now shows a 2-column tile grid (Total hours, Regular pay, OT
   pay, PAB, Tech bonus, and MESA contribution if applicable), with the Total/Take-home row and USD
   line unchanged below it.
4. Click the "PDF" button next to "Pay snapshot": it should show a spinner + "Preparing…", then
   download a file named `pay-summary-<name>-<date>.pdf`.
5. Open the downloaded file: confirm it is one portrait page, shows the same figures as the grid,
   and includes the "Estimated figures — not an official pay stub." disclaimer line.
6. Pick a pay week where MESA applies (`mesaDeductionPhp > 0` and, if available, one with
   `mesaDisbursementPhp > 0`) and repeat steps 3-5 to confirm the MESA tile and the extra
   payout/grand-total rows appear correctly both on screen and in the PDF.

- [ ] **Step 8: Commit**

```bash
git add src/components/employee/EmployeeDashboard.tsx
git commit -m "feat(employee): grid the Pay snapshot and add a PDF download"
```
