import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateOrderInvoicePdf, invoiceNumber, pdfPhp } from './order-invoice';
import type { InvoiceSnapshot } from './orders';

const SNAP: InvoiceSnapshot = {
  version: 1,
  groups: [
    { item: 'Tshirt', size: 'M', qty: 2, unitCentavos: 43000, amountCentavos: 86000 },
    { item: 'Tumbler', size: '', qty: 1, unitCentavos: 60000, amountCentavos: 60000 },
  ],
  recipients: [
    { name: 'Ana Cruz', personalEmail: 'a@x.com', milestone: '6-month (#1)', items: 'Tshirt (M)', shipTo: '1 Rizal St — Manila', contact: '0917', receivedBy: '' },
  ],
  totalCentavos: 146000,
  qtyTotal: 3,
  giftCount: 3,
};

test('invoice number and PDF money format', () => {
  assert.equal(invoiceNumber(42), 'GO-000042');
  assert.equal(pdfPhp(146000), 'PHP 1,460.00');
  assert.equal(pdfPhp(5), 'PHP 0.05');
});

test('builds a PDF from the snapshot alone, locked and reopened', async () => {
  for (const status of ['locked', 'reopened'] as const) {
    const bytes = await generateOrderInvoicePdf(
      { orderNo: 7, lockedAt: '2026-09-23T10:00:00Z', lockedBy: 'hr@simple.biz', status, reopenedAt: status === 'reopened' ? '2026-09-24T10:00:00Z' : null, reopenedBy: 'hr@simple.biz' },
      SNAP,
      { logoUrl: 'http://127.0.0.1:9/none.png' },
    );
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
  }
});

test('a long delivery list paginates without throwing', async () => {
  const many = { ...SNAP, recipients: Array.from({ length: 120 }, (_, i) => ({ ...SNAP.recipients[0], name: `Person ${i}` })) };
  const bytes = await generateOrderInvoicePdf(
    { orderNo: 8, lockedAt: '2026-09-23T10:00:00Z', lockedBy: 'hr@simple.biz', status: 'locked' },
    many,
    { logoUrl: 'http://127.0.0.1:9/none.png' },
  );
  assert.ok(bytes.byteLength > 1000);
});
