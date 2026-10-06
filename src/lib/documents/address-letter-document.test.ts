import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import {
  __addressLetterInternals,
  renderAddressLetterDocument,
  type AddressLetterLayoutReport,
  type AddressLetterRenderParams,
} from './address-letter-document';
import { RASTER_PADDING, TYPED_EXPORT_HEIGHT } from './signature-render';

const ISSUED = '2026-10-06T15:30:00Z'; // Oct 6 23:30 Manila
const REQUEST_ID = 'e5d1c6a0-1f6b-4b7e-9a51-3f0f7a2c9d10';

const BASE: Omit<AddressLetterRenderParams, 'signature'> = {
  facts: {
    workerName: 'Juan Dela Cruz',
    workEmail: 'juand@simple.biz',
    employeeId: '2511-0001',
    team: 'Lead Gen',
    startDateLabel: 'March 4, 2024',
  },
  address: {
    street: '252 Labesang Aguedo St Brgy 168 Brgy Deparo Caloocan City, Metro Manila 1420',
    cityProvince: 'Caloocan, Metro Manila',
    postalCode: '1420',
    country: 'Philippines',
  },
  requestId: REQUEST_ID,
  issuedAtIso: ISSUED,
};

/** A valid RGBA PNG of exactly width x height (the COE tests' fixture). */
function makePng(width: number, height: number): string {
  const bytesPerRow = width * 4 + 1;
  const raw = Buffer.alloc(bytesPerRow * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * bytesPerRow] = 0;
    for (let x = 0; x < width; x += 1) raw[y * bytesPerRow + 1 + x * 4 + 3] = 255;
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed));
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** The raster Type mode really produces — the full height the block allows. A 1x1
 *  placeholder renders 1pt tall and would test the layout with slack production
 *  never has (documents-tab.md § Layout). */
const FULL_HEIGHT_SIGNATURE = makePng(
  Math.round(TYPED_EXPORT_HEIGHT * 12 + RASTER_PADDING * 2),
  TYPED_EXPORT_HEIGHT + RASTER_PADDING * 2,
);

const SIGNATURE = { dataUrl: FULL_HEIGHT_SIGNATURE, name: 'Carla Reyes', email: 'carla@simple.biz' };

test('the draft renders, reloads, and is one page', async () => {
  const bytes = await renderAddressLetterDocument(BASE);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
  assert.equal(doc.getTitle(), 'Proof of Residential Address — Juan Dela Cruz');
});

test('the signed copy, at FULL signature height, is one page', async () => {
  const bytes = await renderAddressLetterDocument({ ...BASE, signature: SIGNATURE });
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
});

test('signed and draft differ — the signature replaces the UNSIGNED block', async () => {
  const draft = await renderAddressLetterDocument(BASE);
  const signed = await renderAddressLetterDocument({ ...BASE, signature: SIGNATURE });
  assert.notDeepEqual(Buffer.from(draft), Buffer.from(signed));
});

test('the realistic worst case — long name, team and a three-line address — still fits one page', async () => {
  let report: AddressLetterLayoutReport | null = null;
  const bytes = await renderAddressLetterDocument({
    ...BASE,
    facts: {
      ...BASE.facts,
      workerName: 'Maria Cristina Villanueva-Santos de los Reyes',
      team: 'Healthcare Solutions — Dental Billing',
      workEmail: 'mariacristinavillanuevasantos@simple.biz',
    },
    address: {
      street:
        'Block 5 Lot 5 Hugo St. KS20 Lancaster New City Phase 2, Barangay Navarro, General Trias, ' +
        'Cavite, CALABARZON, Region IV-A, Philippines 4107, near the Saint Francis Chapel',
      cityProvince: 'General Trias, Cavite, CALABARZON (Region IV-A)',
      postalCode: '4107',
      country: 'Philippines',
    },
    signature: SIGNATURE,
    onLayout: (r) => {
      report = r;
    },
  });
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  const r = report as AddressLetterLayoutReport | null;
  assert.ok(r, 'the renderer reports its layout');
  assert.equal(r.pages, 1);
  // Headroom for the next change. Recover space from whitespace, never from the box.
  assert.ok(r.slack >= 40, `worst case leaves only ${r.slack.toFixed(1)}pt of the one-page budget`);
});

test('non-Latin and accented names degrade instead of throwing', async () => {
  const bytes = await renderAddressLetterDocument({
    ...BASE,
    facts: { ...BASE.facts, workerName: 'José Ñuñez 王' },
    address: { ...BASE.address, cityProvince: 'Parañaque, Metro Manila' },
  });
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
});

test('a corrupt signature is refused, never drawn blank', async () => {
  await assert.rejects(
    renderAddressLetterDocument({ ...BASE, signature: { ...SIGNATURE, dataUrl: 'not-a-data-url' } }),
    /not a valid data URL/,
  );
});

test('dates print in Manila — a late-evening UTC issue is the next Manila day', () => {
  const { formatLongDate, manilaYear } = __addressLetterInternals;
  assert.equal(formatLongDate('2026-10-06T15:30:00Z'), 'October 6, 2026');
  assert.equal(formatLongDate('2026-10-06T16:30:00Z'), 'October 7, 2026');
  assert.equal(manilaYear('2026-12-31T17:00:00Z'), '2027');
});

test('wrapText never leaves a line wider than the column, even for one unbroken word', async () => {
  const doc = await PDFDocument.create();
  const { embedPdfFonts } = await import('@/lib/pdf/fonts');
  const { bold } = await embedPdfFonts(doc);
  const lines = __addressLetterInternals.wrapText('x'.repeat(400) + ' tail', bold, 10, 200);
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(bold.widthOfTextAtSize(l, 10) <= 200, `"${l.slice(0, 20)}…" overflows`);
});
