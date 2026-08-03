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
