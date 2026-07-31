import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { renderCoeDocument, __coeInternals } from './coe-document';
import { coeWorkerName, formatCoeMoney, formatCoeStartDate, type CoeFacts } from './coe-facts';

// A 1x1 transparent PNG — enough for pdf-lib to embed as a "signature".
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const FACTS: CoeFacts = {
  workerName: 'Juan Dela Cruz',
  employeeEmail: 'juan@simple.biz',
  employeeId: 'SP-1042',
  startDateLabel: 'March 4, 2024',
  startDateRaw: '2024-03-04',
  team: 'Sales Assistant',
  weeklyHours: 40,
  hourlyRate: '₱225.00',
  overtimeRate: '₱337.50',
  currency: 'PHP',
  rateSource: 'individual',
  standardBonuses: [
    { label: 'Monthly Attendance Bonus', amount: '₱5,000', qualifier: 'for meeting the required hours each week' },
    { label: 'Technology Allowance', amount: '₱1,850', qualifier: 'given every 3rd paycheck of each month for active workers' },
  ],
  performanceBonuses: [{ label: 'Sales Closer Bonus', amount: '₱2,500' }],
};

const REQUEST_ID = '8f3a1c22-4b7d-4c0e-9f11-2a5f6d3c7e10';
const GENERATED_AT = '2026-07-31T01:03:00.000Z';

test('renders an unsigned draft as a loadable PDF', async () => {
  const bytes = await renderCoeDocument({
    facts: FACTS,
    requestId: REQUEST_ID,
    generatedAtIso: GENERATED_AT,
  });
  assert.ok(bytes.byteLength > 1000, 'produced a non-trivial PDF');
  const reloaded = await PDFDocument.load(bytes);
  assert.ok(reloaded.getPageCount() >= 1);
  assert.equal(reloaded.getTitle(), `Certificate of Engagement — ${FACTS.workerName}`);
});

test('the peso sign survives into the PDF — no "PHP 225.00" fallback', async () => {
  // If the Unicode subset failed to embed, sanitize() would rewrite ₱ to "PHP "
  // and the rendered width would differ. Assert the font layer directly.
  const { embedPdfFonts } = await import('@/lib/pdf/fonts');
  const doc = await PDFDocument.create();
  const fonts = await embedPdfFonts(doc);
  assert.equal(fonts.unicode, true, 'the Noto Sans subset must embed');
  assert.equal(fonts.sanitize('₱225.00'), '₱225.00');
  assert.ok(fonts.regular.widthOfTextAtSize('₱', 11) > 0, 'the peso glyph has metrics');
});

test('signing draws into the certificate and appends nothing on its own', async () => {
  const draft = await renderCoeDocument({
    facts: FACTS,
    requestId: REQUEST_ID,
    generatedAtIso: GENERATED_AT,
  });
  const signed = await renderCoeDocument({
    facts: FACTS,
    requestId: REQUEST_ID,
    generatedAtIso: GENERATED_AT,
    signature: {
      dataUrl: PNG_1PX,
      name: 'Alissa Re',
      title: 'Payroll Coordinator',
      email: 'payroll@simple.biz',
      signedAtIso: GENERATED_AT,
    },
  });
  const draftPages = (await PDFDocument.load(draft)).getPageCount();
  const signedPages = (await PDFDocument.load(signed)).getPageCount();
  assert.equal(
    signedPages,
    draftPages,
    'the signature fills the existing block; the certification page is appended later by requests.ts',
  );
  assert.notEqual(draft.byteLength, signed.byteLength, 'the two states differ');
});

test('a corrupt signature is rejected rather than silently producing an unsigned copy', async () => {
  await assert.rejects(
    () =>
      renderCoeDocument({
        facts: FACTS,
        requestId: REQUEST_ID,
        generatedAtIso: GENERATED_AT,
        signature: {
          dataUrl: 'not-a-data-url',
          name: 'Alissa Re',
          title: 'Payroll Coordinator',
          email: 'payroll@simple.biz',
          signedAtIso: GENERATED_AT,
        },
      }),
    /not a valid data URL/,
  );
});

test('a worker with no performance bonuses still renders (line reads "none assigned")', async () => {
  const bytes = await renderCoeDocument({
    facts: { ...FACTS, performanceBonuses: [], standardBonuses: [] },
    requestId: REQUEST_ID,
    generatedAtIso: GENERATED_AT,
  });
  assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 1);
});

test('a very long name and team do not throw the layout off the page', async () => {
  const bytes = await renderCoeDocument({
    facts: {
      ...FACTS,
      workerName: 'Maria Cristina Bernadette Villanueva-Santos de los Reyes Magbanua',
      team: 'Healthcare Solutions — Specialty Dental Billing and Insurance Verification Team',
      performanceBonuses: Array.from({ length: 8 }, (_, i) => ({
        label: `Quarterly Performance Incentive Tier ${i + 1}`,
        amount: '₱1,000',
      })),
    },
    requestId: REQUEST_ID,
    generatedAtIso: GENERATED_AT,
  });
  const pages = (await PDFDocument.load(bytes)).getPageCount();
  assert.ok(pages >= 1 && pages <= 3, `expected the body to paginate sanely, got ${pages}`);
});

test('non-Latin characters in a name degrade instead of throwing', async () => {
  const bytes = await renderCoeDocument({
    facts: { ...FACTS, workerName: '张伟 Zhang Wei' },
    requestId: REQUEST_ID,
    generatedAtIso: GENERATED_AT,
  });
  assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 1);
});

test('no wrapped line can overflow the content width, even with unbreakable input', async () => {
  const { embedPdfFonts } = await import('@/lib/pdf/fonts');
  const doc = await PDFDocument.create();
  const { regular, sanitize } = await embedPdfFonts(doc);

  // 612pt page - 64pt margins x2 = 484pt of content width (see coe-document.ts).
  const CONTENT_W = 612 - 64 * 2;
  const samples = [
    'This is to certify that Maria Cristina Bernadette Villanueva-Santos de los Reyes Magbanua has been contracted with Simple since March 4, 2024 as part of our Healthcare Solutions — Specialty Dental Billing team.',
    'Performance Bonuses: Sales Closer Bonus (₱2,500), Quarterly KPI Bonus, Attestation Tier 3 (₱50,000), Referral Bonus (₱1,000)',
    'short',
  ];
  for (const s of samples) {
    for (const line of __coeInternals.wrapText(sanitize(s), regular, 10.5, CONTENT_W)) {
      const w = regular.widthOfTextAtSize(line, 10.5);
      assert.ok(w <= CONTENT_W, `line overflows by ${(w - CONTENT_W).toFixed(1)}pt: "${line}"`);
    }
  }
});

test('a single unbreakable token is emitted rather than dropped', async () => {
  const { embedPdfFonts } = await import('@/lib/pdf/fonts');
  const doc = await PDFDocument.create();
  const { regular } = await embedPdfFonts(doc);
  // A 300-char word cannot fit; it must still appear (one over-wide line) so no
  // certificate silently loses a value.
  const lines = __coeInternals.wrapText('x'.repeat(300), regular, 10.5, 484);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 300);
});

test('the signature-block date uses the template\'s MM.DD.YYYY, in Manila time', () => {
  // 2026-07-31T01:03Z is 09:03 on the 31st in Manila (GMT+8).
  assert.equal(__coeInternals.formatDotDate('2026-07-31T01:03:00.000Z'), '07.31.2026');
  // 2026-07-30T17:30Z is already 01:30 on the 31st in Manila — the date must
  // follow Manila, not UTC.
  assert.equal(__coeInternals.formatDotDate('2026-07-30T17:30:00.000Z'), '07.31.2026');
});

test('formatCoeStartDate does not shift a date-only value across the dateline', () => {
  assert.equal(formatCoeStartDate('2024-03-04'), 'March 4, 2024');
  assert.equal(formatCoeStartDate('2024-01-01'), 'January 1, 2024');
  assert.equal(formatCoeStartDate('nonsense'), null);
  assert.equal(formatCoeStartDate(''), null);
});

// The master list stores names surname-first with the go-by in quotes. All of
// these are real shapes taken from global_master_list.
test('the worker name reads naturally, nickname dropped', () => {
  assert.equal(coeWorkerName('Zabala, Christian "Chris"'), 'Christian Zabala');
  assert.equal(coeWorkerName('Telen, James Theos "James"'), 'James Theos Telen');
  assert.equal(coeWorkerName('Pang-itan, Genelyn "Gen"'), 'Genelyn Pang-itan');
  assert.equal(coeWorkerName('Wagai, Kentshin De Guzman "Kentshin "'), 'Kentshin De Guzman Wagai');
  assert.equal(coeWorkerName('Vergara, Earl Joseph T. "Joseph"'), 'Earl Joseph T. Vergara');
  assert.equal(coeWorkerName('Lepley, Teal'), 'Teal Lepley');
  // Curly quotes appear in sheet round-trips too.
  assert.equal(coeWorkerName('Caraga, Siegmond Lois “Siegmond”'), 'Siegmond Lois Caraga');
});

test('a name mangled in the master list is refused, not printed', () => {
  // These rows have the nickname or a fragment in FRONT of the surname, or a
  // doubled comma. Composing them leaves a comma behind — printing
  // ", Jeannel Peduhan" on a legal document is worse than declining.
  assert.equal(coeWorkerName('"Ro", Noquera, Rodelyn "Rodelyn"'), null);
  assert.equal(coeWorkerName('Peduhan,, Jeannel "Jean"'), null);
  assert.equal(coeWorkerName('Anthony, Rondolos, Marc "Marc"'), null);
  assert.equal(coeWorkerName('J., Montebon, Roberto Antonio "Antonio"'), null);
  assert.equal(coeWorkerName(''), null);
  assert.equal(coeWorkerName(null), null);
  assert.equal(coeWorkerName('   '), null);
});

test('money renders in each currency the way the business writes it', () => {
  assert.equal(formatCoeMoney(5000, 'PHP'), '₱5,000');
  assert.equal(formatCoeMoney(1850, 'PHP'), '₱1,850');
  assert.equal(formatCoeMoney(225.5, 'PHP'), '₱225.50');
  assert.equal(formatCoeMoney(88, 'USD'), '$88');
  // COP is quoted in whole pesos, es-CO groups with dots, and the house "$COP"
  // symbol gets a space so a bank doesn't read it as one token.
  assert.equal(formatCoeMoney(320_000, 'COP'), '$COP 320.000');
});
