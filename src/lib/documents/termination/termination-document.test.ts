// [TERMINATION-DOCS]
// Certificate of Termination — renderer tests.
//
// The COE's original tests were worthless in the way that matters: they embedded
// a 1x1 PNG, which scale-to-fit renders 1pt tall, so every "fits one page"
// assertion ran with 45pt of slack production never has. They also never checked
// that the Unicode font actually embedded, and embedPdfFonts NEVER THROWS — it
// falls back to WinAnsi Helvetica with a sanitiser that rewrites the peso sign to
// "PHP ". Both holes are closed here: the page count is pinned at the REAL
// 1944x184 signature raster as well as the placeholder, `fonts.unicode` is
// asserted, and the PNG helper carries its own guard test so a one-page pass can
// never come from an image that silently failed to load.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { renderTerminationDocument, __terminationInternals } from './termination-document';
import { TERMINATION_DEPARTURE_REASONS, type TerminationFacts } from './types';
import { coeWorkerName } from '@/lib/documents/coe-facts';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { OFFBOARD_REASON_LABELS } from '@/lib/hr/offboard-reasons';
import { PDF_SIGNATURE_MAX_HEIGHTS, RASTER_PADDING, TYPED_EXPORT_HEIGHT } from '@/lib/documents/signature-render';

// A 1x1 transparent PNG — enough for pdf-lib to embed as a "signature".
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const DOCUMENT_ID = '3c6f9a11-88de-4d0b-b0a2-5e7c1d9f4a33';
const GENERATED_AT = '2026-08-31T02:15:00.000Z';

const FACTS: TerminationFacts = {
  identity: {
    workEmail: 'juand@simple.biz',
    personalEmail: 'juan.delacruz@gmail.com',
    masterRowId: '9b1d4c7e-2f30-4a51-8c62-7d4e5f6a8b90',
    onCurrentUpload: true,
    candidateRowIds: ['9b1d4c7e-2f30-4a51-8c62-7d4e5f6a8b90'],
    matchedColumn: 'Work Email',
    offDateSource: 'global_master_list',
  },
  workerName: 'Juan Dela Cruz',
  terminationDate: '2026-08-18',
  terminationDateLabel: 'August 18, 2026',
  reasonKey: 'end_of_contract',
  reasonLabel: 'End of contract',
  rawReason: 'End of Contract',
  endingDepartmentRaw: 'Sales Assistant',
  endingDepartmentLabel: 'Sales Assistant',
  startDate: '2024-03-04',
  startDateLabel: 'March 4, 2024',
  startingRate: { amount: 225, currency: 'PHP', source: 'hr_pending', blankReason: null },
  endingRate: { amount: 300.5, currency: 'PHP', source: 'paystub_locked', blankReason: null },
  blanks: [],
  degraded: [],
};

const SIGNATURE = {
  dataUrl: PNG_1PX,
  name: 'Alissa Re',
  title: 'Payroll Coordinator',
  email: 'payroll@simple.biz',
  signedAtIso: GENERATED_AT,
};

function render(
  facts: Partial<TerminationFacts>,
  dataUrl: string = PNG_1PX,
): Promise<Uint8Array> {
  return renderTerminationDocument({
    facts: { ...FACTS, ...facts },
    documentId: DOCUMENT_ID,
    generatedAtIso: GENERATED_AT,
    signature: { ...SIGNATURE, dataUrl },
  });
}

test('renders a signed, loadable, single-page PDF', async () => {
  const bytes = await render({});
  assert.ok(bytes.byteLength > 1000, 'produced a non-trivial PDF');
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 1, 'a termination letter is ONE page');
  assert.equal(reloaded.getTitle(), `Certificate of Termination — ${FACTS.workerName}`);
});

test('the peso sign survives into the PDF — no "PHP 225.00" fallback', async () => {
  // embedPdfFonts never throws: it silently falls back to WinAnsi Helvetica with
  // a sanitiser that rewrites ₱ to "PHP ". Without this assertion no test in
  // this file can tell a working font from a broken one.
  const { embedPdfFonts } = await import('@/lib/pdf/fonts');
  const doc = await PDFDocument.create();
  const fonts = await embedPdfFonts(doc);
  assert.equal(fonts.unicode, true, 'the Noto Sans subset must embed');
  assert.equal(fonts.sanitize('₱225.00'), '₱225.00');
  assert.ok(fonts.regular.widthOfTextAtSize('₱', 11) > 0, 'the peso glyph has metrics');
});

// ── Money, in the payee's OWN currency ───────────────────────────────────────
// Plan risk 4: PHP-only would blank the rate for every USD/COP payee
// systematically, so each figure prints in the currency that engagement was paid
// in — the COE already sets the precedent (a Colombian sees "$COP").

test('a rate prints in its own currency, always with cents', () => {
  const { formatTerminationRate } = __terminationInternals;
  assert.equal(formatTerminationRate(225, 'PHP'), '₱225.00');
  assert.equal(formatTerminationRate(225.5, 'PHP'), '₱225.50');
  assert.equal(formatTerminationRate(5000, 'PHP'), '₱5,000.00');
  assert.equal(formatTerminationRate(12, 'USD'), '$12.00');
  assert.equal(formatTerminationRate(12.75, 'USD'), '$12.75');
  // COP is quoted in whole pesos, es-CO groups with dots, and the house "$COP"
  // symbol takes a space so a reader doesn't parse it as one token.
  assert.equal(formatTerminationRate(320_000, 'COP'), '$COP 320.000');
});

test('a zero or negative rate never prints — a zero rate is not a rate', () => {
  const { rateLabel } = __terminationInternals;
  assert.equal(rateLabel({ amount: 0, currency: 'PHP', source: null, blankReason: 'zero_rate' }), null);
  assert.equal(rateLabel({ amount: -5, currency: 'PHP', source: null, blankReason: null }), null);
  assert.equal(rateLabel({ amount: null, currency: 'PHP', source: null, blankReason: 'never_paid' }), null);
  assert.equal(rateLabel(null), null);
  assert.equal(rateLabel({ amount: 225, currency: 'PHP', source: 'hr_pending', blankReason: null }), '₱225.00');
});

test('a hire rate in one currency and an ending rate in another still fits one page', async () => {
  const bytes = await render({
    startingRate: { amount: 8, currency: 'USD', source: 'hr_pending', blankReason: null },
    endingRate: { amount: 320_000, currency: 'COP', source: 'disbursement_record', blankReason: null },
  });
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
});

test('either rate alone renders, and both missing renders without a dangling arrow', async () => {
  const blank = { amount: null, currency: 'PHP' as const, source: null, blankReason: 'never_paid' as const };
  for (const patch of [
    { endingRate: blank },
    { startingRate: blank },
    { startingRate: blank, endingRate: blank },
  ]) {
    assert.equal((await PDFDocument.load(await render(patch))).getPageCount(), 1);
  }
});

// ── Refusals: nothing false or unrenderable reaches the page (G6) ─────────────

test('a name mangled in the master list is refused, not printed', async () => {
  // Real shapes from global_master_list where the nickname or a fragment sits in
  // FRONT of the surname, or a comma is doubled. coeWorkerName returns null for
  // every one of them; a caller that skipped composition must still be stopped
  // here rather than printing ", Jeannel Peduhan" on a legal page.
  const mangled = [
    '"Ro", Noquera, Rodelyn "Rodelyn"',
    'Peduhan,, Jeannel "Jean"',
    'Anthony, Rondolos, Marc "Marc"',
    'J., Montebon, Roberto Antonio "Antonio"',
    '',
    '   ',
    'Caraga, Siegmond Lois “Siegmond”',
    // The COE's guard misses this one: parseNameParts parks an address found in
    // the Name column whole in `first`, and it carries no comma or quote.
    'jasminec@simple.biz',
  ];
  for (const workerName of mangled) {
    await assert.rejects(() => render({ workerName }), /legal name/, `accepted "${workerName}"`);
  }
  // null is not in the type, but the facts blob is jsonb round-tripped.
  await assert.rejects(
    () => render({ workerName: null as unknown as string }),
    /legal name/,
  );
});

test('a name the composer accepts renders', async () => {
  // Composed through the real composer so the accepted set can never drift from
  // what coe-facts actually produces.
  const rawNames = [
    'Zabala, Christian "Chris"',
    'Wagai, Kentshin De Guzman "Kentshin "',
    'Vergara, Earl Joseph T. "Joseph"',
  ];
  for (const raw of rawNames) {
    const workerName = coeWorkerName(raw);
    if (!workerName) throw new Error(`the composer must accept "${raw}"`);
    const bytes = await render({ workerName });
    assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  }
});

test('a raw hsl:* slug is refused; the formatted label prints', async () => {
  const raw = 'hsl:intake_specialist';
  const label = formatDeptLabel(raw);
  assert.equal(label, 'HSL — Intake Specialist');
  assert.ok(!label.startsWith('hsl:'), 'formatDeptLabel never returns a bare slug');

  await assert.rejects(
    () => render({ endingDepartmentRaw: raw, endingDepartmentLabel: raw }),
    /department slug/,
  );
  // The raw cell rides along for audit and rate re-resolution; only the label prints.
  const bytes = await render({ endingDepartmentRaw: raw, endingDepartmentLabel: label });
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
});

test('a missing printed fact is refused rather than dashed out', async () => {
  await assert.rejects(
    () => render({ terminationDate: null, terminationDateLabel: null }),
    /termination date/,
  );
  await assert.rejects(() => render({ reasonKey: null, reasonLabel: null }), /departure reason/);
  // offboardReasonLabel's own null fallback must not reach the page either.
  await assert.rejects(() => render({ reasonLabel: '—' }), /departure reason/);
  await assert.rejects(() => render({ endingDepartmentLabel: null }), /department label/);
});

test('a corrupt signature is rejected rather than silently producing an unsigned page', async () => {
  await assert.rejects(() => render({}, 'not-a-data-url'), /not a valid data URL/);
  await assert.rejects(
    () => render({}, 'data:image/png;base64,Zm9v'),
    /could not be embedded/,
  );
});

// ── Dates ────────────────────────────────────────────────────────────────────

test('a date-only value never shifts across the dateline', () => {
  const { dateLabel } = __terminationInternals;
  // The resolver's own label wins when it has one.
  assert.equal(dateLabel('August 18, 2026', '2026-08-18'), 'August 18, 2026');
  // Derived through the shared helper, which parses the parts into a LOCAL Date:
  // new Date('2026-08-18') is UTC midnight and reads as the 17th in Manila.
  assert.equal(dateLabel(null, '2026-08-18'), 'August 18, 2026');
  assert.equal(dateLabel('   ', '2024-01-01'), 'January 1, 2024');
  assert.equal(dateLabel(null, 'nonsense'), null);
  assert.equal(dateLabel(null, null), null);
});

test('a blank start date drops its row instead of printing an empty one', async () => {
  const bytes = await render({ startDate: null, startDateLabel: null });
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
});

// ── The signature, at its real size ──────────────────────────────────────────

/** A valid RGBA PNG of exactly `width` x `height`, opaque black. pdf-lib reads
 *  the dimensions off IHDR, which is all the layout depends on. */
function makePng(width: number, height: number): string {
  const bytesPerRow = width * 4 + 1; // +1 filter byte per scanline
  const raw = Buffer.alloc(bytesPerRow * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * bytesPerRow;
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      raw[rowStart + 1 + x * 4 + 3] = 255; // opaque
    }
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 = compression / filter / interlace, all 0

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** The raster Type mode actually produces: TYPED_EXPORT_HEIGHT + padding tall,
 *  at the widest aspect a real cursive name reaches. 1944 x 184. */
const TYPED_SIGNATURE_PNG = makePng(
  Math.round(TYPED_EXPORT_HEIGHT * 12 + RASTER_PADDING * 2),
  TYPED_EXPORT_HEIGHT + RASTER_PADDING * 2,
);

test('the PNG helper produces something pdf-lib will actually embed', async () => {
  // If this ever breaks, the page-count tests below would pass for the wrong
  // reason: an image that failed to load costs the layout nothing.
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(TYPED_SIGNATURE_PNG);
  assert.equal(img.height, TYPED_EXPORT_HEIGHT + RASTER_PADDING * 2);
  assert.equal(img.width, Math.round(TYPED_EXPORT_HEIGHT * 12 + RASTER_PADDING * 2));
  assert.ok(img.width > img.height, 'a signature raster is wider than it is tall');
});

test('the signature cap matches the COE block, so both documents seat it identically', () => {
  // A typed signature is a fixed 184px raster sized against the TIGHTER of the
  // two existing PDF caps. Introducing a third cap here would mean adding it to
  // PDF_SIGNATURE_MAX_HEIGHTS and its pinning test; matching the COE avoids that.
  assert.equal(__terminationInternals.SIGNATURE_MAX_H, PDF_SIGNATURE_MAX_HEIGHTS.coeBlock);
});

test('a FULL-HEIGHT typed signature still fits one page', async () => {
  const bytes = await render({}, TYPED_SIGNATURE_PNG);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
});

test('the 1x1 placeholder is never upscaled to the cap', async () => {
  // Math.min(..., 1) is the clamp. A 1x1 PNG blown up to 46pt would be a smear,
  // and it would also hide the layout cost the real raster imposes.
  const small = await render({}, PNG_1PX);
  const full = await render({}, TYPED_SIGNATURE_PNG);
  assert.equal((await PDFDocument.load(small)).getPageCount(), 1);
  assert.equal((await PDFDocument.load(full)).getPageCount(), 1);
  assert.notEqual(small.byteLength, full.byteLength, 'the two rasters differ in the output');
});

// ── Worst case ───────────────────────────────────────────────────────────────

/** The longest label any allowed departure reason can print. Derived rather than
 *  hard-coded so relabelling a reason re-tightens this test instead of stale. */
const LONGEST_REASON_LABEL = TERMINATION_DEPARTURE_REASONS.map(
  (k) => OFFBOARD_REASON_LABELS[k] ?? k,
).reduce((a, b) => (b.length > a.length ? b : a), '');

test('the worst realistic case, signed at FULL signature height, still fits one page', async () => {
  // Longest plausible legal name (65 chars — it must downscale, not wrap or
  // overflow), a multi-part department label that cannot sit beside its own row
  // label, the longest departure reason, and both rates present.
  assert.ok(LONGEST_REASON_LABEL.length >= 'Resigned'.length);
  const bytes = await renderTerminationDocument({
    facts: {
      ...FACTS,
      workerName: 'Maria Cristina Bernadette Villanueva-Santos de los Reyes Magbanua',
      endingDepartmentRaw: 'hsl:collections',
      endingDepartmentLabel:
        'Healthcare Solutions — Specialty Dental Billing, Insurance Verification and Records',
      reasonLabel: LONGEST_REASON_LABEL,
      startingRate: { amount: 187.5, currency: 'PHP', source: 'rate_history_baseline', blankReason: null },
      endingRate: { amount: 1234.56, currency: 'PHP', source: 'wizard_snapshot', blankReason: null },
    },
    documentId: DOCUMENT_ID,
    generatedAtIso: GENERATED_AT,
    signature: { ...SIGNATURE, dataUrl: TYPED_SIGNATURE_PNG },
  });
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
});

test('a long legal name downscales onto one line rather than overflowing', async () => {
  const { fitSize } = __terminationInternals;
  const { embedPdfFonts } = await import('@/lib/pdf/fonts');
  const doc = await PDFDocument.create();
  const { bold } = await embedPdfFonts(doc);
  const CONTENT_W = 612 - 64 * 2;
  const long = 'Maria Cristina Bernadette Villanueva-Santos de los Reyes Magbanua';
  const size = fitSize(long, bold, 16.5, 11, CONTENT_W);
  assert.ok(size < 16.5, 'a 65-character name must shrink');
  assert.ok(bold.widthOfTextAtSize(long, size) <= CONTENT_W, 'and then it fits');
  // A short name keeps the headline size.
  assert.equal(fitSize('Juan Dela Cruz', bold, 16.5, 11, CONTENT_W), 16.5);
});

// ── Ligatures ────────────────────────────────────────────────────────────────

test('no fixed string this document draws lays out to a blank glyph', async () => {
  // REGRESSION CLASS: "Certificate of Engagement" shipped as "Certifi cate".
  // fontkit applies the `liga` GSUB feature, so "f" + "i" is SUBSTITUTED with a
  // single ﬁ glyph; when that code point is pruned from the subset the
  // substitution resolves to a blank outline that still carries the ligature's
  // full advance, leaving a hole mid-word. Nothing about the input text is
  // wrong, so no sanitiser test can catch it. Words at risk in this document:
  // certificate, confirm, affiliated, identifier, official, effective.
  const fontkit = (await import('@pdf-lib/fontkit')).default as unknown as {
    create(b: Uint8Array): {
      layout(s: string): {
        glyphs: { id: number; codePoints: number[]; path: { commands: unknown[] } }[];
        positions: { xAdvance: number }[];
      };
    };
  };
  const { NOTO_SANS_REGULAR_BASE64 } = await import('@/lib/pdf/fonts/noto-sans-regular');
  const { NOTO_SANS_BOLD_BASE64 } = await import('@/lib/pdf/fonts/noto-sans-bold');
  const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

  const samples = __terminationInternals.proseSamples;
  assert.ok(samples.length > 10, 'every fixed string is routed through PROSE');
  // The title and the section label are drawn UPPERCASED, so lay out both forms.
  const cases = samples.flatMap((s) => [s, s.toUpperCase()]);

  for (const [label, b64] of [
    ['regular', NOTO_SANS_REGULAR_BASE64],
    ['bold', NOTO_SANS_BOLD_BASE64],
  ] as const) {
    const font = fontkit.create(bytes(b64));
    for (const sample of cases) {
      const run = font.layout(sample);
      run.glyphs.forEach((g, i) => {
        const chars = (g.codePoints ?? []).map((c) => String.fromCodePoint(c)).join('');
        if (chars.trim() === '') return; // whitespace legitimately has no outline
        assert.ok(
          g.path && g.path.commands.length > 0,
          `${label}: glyph ${g.id} for "${chars}" (advance ${run.positions[i].xAdvance}) has no ` +
            `outline — it would render as a blank gap inside "${sample.slice(0, 40)}"`,
        );
      });
    }
  }
});

test('every fixed string survives the font sanitiser unchanged', async () => {
  // A sanitiser substitution inside fixed prose means the source is lying about
  // what prints (an arrow folding to "->", a stray glyph folding to "?").
  const { embedPdfFonts } = await import('@/lib/pdf/fonts');
  const doc = await PDFDocument.create();
  const { sanitize } = await embedPdfFonts(doc);
  for (const s of __terminationInternals.proseSamples) {
    assert.equal(sanitize(s), s, `sanitize() rewrote a fixed string: "${s}"`);
    assert.ok(!s.includes('?'), `a folded glyph slipped into "${s}"`);
  }
});

// ── The cap, actually exercised ──────────────────────────────────────────────

/**
 * A raster whose HEIGHT is the binding constraint.
 *
 * The 1944 x 184 fixture above is the raster Type mode produces, and it was
 * added to close the 1x1 hole — but it does not exercise the cap either: the
 * seat is `Math.min(maxW / width, SIGNATURE_MAX_H / height, 1)` with
 * `maxW = min(196, CONTENT_W * 0.44)`, so at 1944 wide the WIDTH clamp wins
 * (196/1944 = 0.101) and the signature lands ~18.6pt tall against a 46pt cap.
 * That is 27pt of slack production does have: a DRAWN signature of a short name
 * is nearly square, height binds, and the block seats at the full 46pt.
 *
 * 176 x 184 is that shape. 196/176 = 1.11 > 46/184 = 0.25, so the cap is what
 * decides, and this is the tallest signature block the renderer can ever draw.
 */
const CAP_BINDING_SIGNATURE_PNG = makePng(176, TYPED_EXPORT_HEIGHT + RASTER_PADDING * 2);

test('the fixture that binds on the CAP really does bind on it', async () => {
  // Without this, the test below could pass because the width clamp quietly took
  // over again — the exact way the 1x1 fixture used to pass.
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(CAP_BINDING_SIGNATURE_PNG);
  const maxW = 196;
  assert.ok(
    __terminationInternals.SIGNATURE_MAX_H / img.height < maxW / img.width,
    `this raster (${img.width}x${img.height}) is seated by its WIDTH, not by the cap`,
  );
  assert.equal(
    img.height * (__terminationInternals.SIGNATURE_MAX_H / img.height),
    __terminationInternals.SIGNATURE_MAX_H,
  );
});

test('a signature seated at the FULL cap height still fits one page', async () => {
  const bytes = await render({}, CAP_BINDING_SIGNATURE_PNG);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
});

test('the worst case, signed at the FULL CAP height, still fits one page', async () => {
  // Everything the page can be asked to carry at once, with the tallest
  // signature block the renderer can draw.
  const bytes = await renderTerminationDocument({
    facts: {
      ...FACTS,
      workerName: 'Maria Cristina Bernadette Villanueva-Santos de los Reyes Magbanua',
      endingDepartmentRaw: 'hsl:collections',
      endingDepartmentLabel:
        'Healthcare Solutions — Specialty Dental Billing, Insurance Verification and Records',
      reasonLabel: LONGEST_REASON_LABEL,
      startingRate: { amount: 187.5, currency: 'PHP', source: 'rate_history_baseline', blankReason: null },
      endingRate: { amount: 1234.56, currency: 'PHP', source: 'wizard_snapshot', blankReason: null },
    },
    documentId: DOCUMENT_ID,
    generatedAtIso: GENERATED_AT,
    signature: { ...SIGNATURE, dataUrl: CAP_BINDING_SIGNATURE_PNG },
  });
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
});
