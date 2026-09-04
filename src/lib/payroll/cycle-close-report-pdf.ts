/**
 * Cycle close-out — the FINAL artifact as a PDF (2026-09-04).
 *
 * Third format of the same record the CSV and XLSX carry
 * (`cycle-close-report-export.ts`), attached to the `payment_cycle_complete`
 * email so Accounting gets something readable on a phone. Same rules:
 *
 *   - every headline figure renders VERBATIM from the stored `CycleCloseoutRecord`;
 *   - the unpaid list is the stored payees — nothing re-derived;
 *   - live paid rows appear ONLY behind the "live, not part of the frozen record"
 *     disclosure, and carry bank LAST-4 only (the input type has no other field);
 *   - the retired, gated artifact's name (pay-cycle "report") never appears; this
 *     file titles itself "Cycle Close-Out".
 *
 * Look mirrors `src/lib/ceo/report-pdf.ts` (Simple navy/orange, "Pulled from
 * Simple-HRIS System" masthead, navy table headers, alternating rows). pdf-lib's
 * Helvetica is WinAnsi — non-Latin glyphs and the peso sign are sanitized the
 * same way that module does it.
 *
 * Pure apart from reading the logo off disk: no fetch, no Supabase. Server-side
 * by use (the attachments builder), but deliberately NOT `server-only` so the
 * node:test suite can render it.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage } from 'pdf-lib';
import type { FinalCloseReportModel } from './cycle-close-report-export';
import type { CycleCloseoutUnpaidPayee } from './cycle-closeout';

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 44;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM = 56;

const NAVY = rgb(0.13, 0.15, 0.33);
const ORANGE = rgb(0.95, 0.45, 0.12);
const WHITE = rgb(1, 1, 1);
const TEXT = rgb(0.12, 0.12, 0.15);
const MUTED = rgb(0.42, 0.42, 0.48);
const ROW_ALT = rgb(0.96, 0.96, 0.985);
const BORDER = rgb(0.86, 0.86, 0.9);
const AMBER_BG = rgb(1, 0.97, 0.9);
const AMBER = rgb(0.6, 0.35, 0.05);

const BODY = 8.5;
const LH = 11;
const PAD_X = 5;
const PAD_Y = 4;

const KNOWN_PROCESSOR_IDS = ['hurupay', 'wepay', 'higlobe', 'wise', 'jeeves', 'wires'] as const;

const REASON_LABEL: Record<CycleCloseoutUnpaidPayee['reason'], string> = {
  pending: 'Never dispatched',
  problem: 'Problem',
  threshold: 'Held - threshold',
};

function sanitize(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) out += ch;
    else if (ch === '–' || ch === '—') out += '-';
    else if (ch === '’' || ch === '‘') out += "'";
    else if (ch === '“' || ch === '”') out += '"';
    else if (ch === '…') out += '...';
    else if (ch === '₱') out += 'PHP ';
    else if (ch === '·') out += '-';
    else out += '?';
  }
  return out;
}

function wrapText(raw: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const text = sanitize(raw);
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    const trimmed = para.trim();
    if (!trimmed) {
      lines.push('');
      continue;
    }
    const fits = (s: string) => font.widthOfTextAtSize(s, size) <= maxWidth;
    let line = '';
    for (let word of trimmed.split(/\s+/)) {
      while (!fits(word)) {
        let i = word.length;
        while (i > 1 && !fits(word.slice(0, i))) i--;
        if (line) {
          lines.push(line);
          line = '';
        }
        lines.push(word.slice(0, i));
        word = word.slice(i);
        if (i <= 1 && word.length) break;
      }
      const candidate = line ? `${line} ${word}` : word;
      if (line && !fits(candidate)) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [''];
}

async function loadLogoFromDisk(): Promise<Uint8Array | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    return new Uint8Array(await readFile(join(process.cwd(), 'public', 'simple-logo.png')));
  } catch {
    return null;
  }
}

/** Money for the PDF: 2dp, grouped; null stays BLANK (a null marker amount means
 *  "owed an unknown amount", never 0.00). */
function money(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function humanTimestamp(d: Date): string {
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
}

function processorRows(
  byProcessor: Record<string, { count: number; usd: number; php: number }>,
): Array<{ id: string; count: number; usd: number; php: number }> {
  const out: Array<{ id: string; count: number; usd: number; php: number }> = [];
  const seen = new Set<string>();
  for (const id of KNOWN_PROCESSOR_IDS) {
    const v = byProcessor[id];
    out.push({ id, count: v?.count ?? 0, usd: v?.usd ?? 0, php: v?.php ?? 0 });
    seen.add(id);
  }
  for (const [id, v] of Object.entries(byProcessor)) {
    if (seen.has(id)) continue;
    out.push({ id, count: v.count, usd: v.usd, php: v.php });
  }
  return out;
}

type Align = 'left' | 'right';
type Col = { header: string; width: number; align: Align };

export interface BuildFinalCloseoutPdfOptions {
  /** Skip the disk read for the logo (tests, or a runtime without `public/`). */
  logo?: boolean;
}

/**
 * Render the FINAL close-out PDF. Bytes out; the caller names the file with
 * `finalCloseReportFilename(label, now, 'pdf')`.
 */
export async function buildFinalCloseoutPdf(
  model: FinalCloseReportModel,
  options: BuildFinalCloseoutPdfOptions = {},
): Promise<Uint8Array> {
  const { record } = model;
  const doc = await PDFDocument.create();
  doc.setTitle(`Cycle Close-Out - ${sanitize(record.label)}`);
  doc.setProducer('Simple HRIS');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let logo: PDFImage | null = null;
  if (options.logo !== false) {
    const bytes = await loadLogoFromDisk();
    if (bytes) {
      try {
        logo = await doc.embedPng(bytes);
      } catch {
        logo = null;
      }
    }
  }

  const state = { page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN };
  const newPage = () => {
    state.page = doc.addPage([PAGE_W, PAGE_H]);
    state.y = PAGE_H - MARGIN;
  };
  const ensure = (space: number) => {
    if (state.y - space < BOTTOM) newPage();
  };
  const text = (s: string, x: number, y: number, size: number, f: PDFFont, color = TEXT) => {
    state.page.drawText(sanitize(s), { x, y, size, font: f, color });
  };
  const right = (s: string, y: number, size: number, f: PDFFont, color = MUTED) => {
    const t = sanitize(s);
    const w = f.widthOfTextAtSize(t, size);
    state.page.drawText(t, { x: PAGE_W - MARGIN - w, y, size, font: f, color });
  };
  const paragraph = (s: string, size = BODY, color = TEXT, f = font) => {
    for (const ln of wrapText(s, f, size, CONTENT_W)) {
      ensure(LH + 2);
      text(ln, MARGIN, state.y - size, size, f, color);
      state.y -= LH;
    }
  };
  const sectionLabel = (s: string) => {
    ensure(26);
    state.y -= 6;
    state.page.drawRectangle({ x: MARGIN, y: state.y - 9, width: 4, height: 10, color: ORANGE });
    text(s, MARGIN + 10, state.y - 8, 9.5, bold, NAVY);
    state.y -= 18;
  };
  const notice = (s: string) => {
    const lines = wrapText(s, font, BODY, CONTENT_W - PAD_X * 2);
    const h = lines.length * LH + PAD_Y * 2;
    ensure(h + 4);
    state.page.drawRectangle({ x: MARGIN, y: state.y - h, width: CONTENT_W, height: h, color: AMBER_BG, borderColor: AMBER, borderWidth: 0.5 });
    lines.forEach((ln, i) => text(ln, MARGIN + PAD_X, state.y - PAD_Y - BODY - i * LH, BODY, font, AMBER));
    state.y -= h + 6;
  };

  const drawTable = (columns: Col[], rows: string[][]) => {
    const headerH = LH + PAD_Y * 2;
    const drawHeader = () => {
      state.page.drawRectangle({ x: MARGIN, y: state.y - headerH, width: CONTENT_W, height: headerH, color: NAVY });
      let x = MARGIN;
      for (const c of columns) {
        const t = wrapText(c.header, bold, BODY, c.width - PAD_X * 2)[0];
        const tw = bold.widthOfTextAtSize(t, BODY);
        const tx = c.align === 'right' ? x + c.width - PAD_X - tw : x + PAD_X;
        state.page.drawText(t, { x: tx, y: state.y - PAD_Y - BODY, size: BODY, font: bold, color: WHITE });
        x += c.width;
      }
      state.y -= headerH;
    };
    ensure(headerH + LH + PAD_Y * 2);
    drawHeader();
    let alt = false;
    for (const row of rows) {
      const cellLines = columns.map((c, i) => wrapText(row[i] ?? '', font, BODY, c.width - PAD_X * 2));
      const maxLines = Math.max(1, ...cellLines.map((l) => l.length));
      const rowH = maxLines * LH + PAD_Y * 2;
      if (state.y - rowH < BOTTOM) {
        newPage();
        drawHeader();
        alt = false;
      }
      if (alt) state.page.drawRectangle({ x: MARGIN, y: state.y - rowH, width: CONTENT_W, height: rowH, color: ROW_ALT });
      let x = MARGIN;
      for (let i = 0; i < columns.length; i++) {
        const c = columns[i];
        const lines = cellLines[i];
        for (let li = 0; li < lines.length; li++) {
          const tw = font.widthOfTextAtSize(lines[li], BODY);
          const tx = c.align === 'right' ? x + c.width - PAD_X - tw : x + PAD_X;
          state.page.drawText(lines[li], { x: tx, y: state.y - PAD_Y - BODY - li * LH, size: BODY, font, color: TEXT });
        }
        x += c.width;
      }
      state.page.drawLine({ start: { x: MARGIN, y: state.y - rowH }, end: { x: MARGIN + CONTENT_W, y: state.y - rowH }, thickness: 0.5, color: BORDER });
      state.y -= rowH;
      alt = !alt;
    }
    state.y -= 8;
  };
  const cols = (spec: Array<[string, number, Align?]>): Col[] => {
    const sum = spec.reduce((a, [, w]) => a + w, 0);
    return spec.map(([header, w, align]) => ({ header, width: (w / sum) * CONTENT_W, align: align ?? 'left' }));
  };

  // ── Masthead ───────────────────────────────────────────────────────────────
  {
    const top = state.y;
    if (logo) {
      const h = 30;
      const w = (logo.width / logo.height) * h;
      state.page.drawImage(logo, { x: MARGIN, y: top - h, width: w, height: h });
    } else {
      text('Simple', MARGIN, top - 24, 24, bold, NAVY);
    }
    right('Pulled from Simple-HRIS System', top - 8, 9.5, bold, NAVY);
    right(`Exported ${humanTimestamp(model.generatedAt)}`, top - 21, 8.5, font);
    right(`Source file: ${record.source_file}`, top - 32, 7.5, font);
    state.y = top - 50;

    text('CYCLE CLOSE-OUT', MARGIN, state.y, 8.5, bold, ORANGE);
    state.y -= 16;
    text(record.label, MARGIN, state.y, 16, bold, NAVY);
    state.y -= 16;
    text(
      record.period_start && record.period_end
        ? `Period: ${record.period_start} to ${record.period_end}`
        : 'Period: unknown',
      MARGIN,
      state.y,
      9,
      font,
      MUTED,
    );
    state.y -= 12;
    text(`STATUS: FINAL - closed ${record.closed_at} by ${record.closed_by}`, MARGIN, state.y, 9, bold, NAVY);
    state.y -= 8;
    state.page.drawLine({ start: { x: MARGIN, y: state.y }, end: { x: PAGE_W - MARGIN, y: state.y }, thickness: 1.3, color: NAVY });
    state.y -= 10;
  }

  // ── Frozen headline ─────────────────────────────────────────────────────────
  sectionLabel('Frozen at close (server-computed)');
  const unpaidHeadline = record.unpaid.count + record.unpaid.truncated;
  drawTable(cols([['Figure', 3], ['Value', 1, 'right']]), [
    ['Payees paid', String(record.paid.payeeCount)],
    ['Employees paid', String(record.paid.employeeCount)],
    ['Contractor invoices paid', String(record.paid.contractorCount)],
    ['Paid dispatch rows', String(record.paid.dispatchCount)],
    ['Paid USD', money(record.paid.paidUSD)],
    ['Paid PHP', money(record.paid.paidPHP)],
    ['Payable not paid', String(unpaidHeadline)],
    ['Unpaid USD (listed rows)', money(record.unpaid.totalUSD)],
    ['Unpaid PHP (listed rows)', money(record.unpaid.totalPHP)],
  ]);
  if (record.unpaid.truncated > 0 || record.unpaid.dropped > 0) {
    notice(
      `NOTICE: ${record.unpaid.truncated} unpaid ${record.unpaid.truncated === 1 ? 'person is' : 'people are'} counted above but not listed (storage cap); ${record.unpaid.dropped} ${record.unpaid.dropped === 1 ? 'entry was' : 'entries were'} dropped as unidentifiable (no email).`,
    );
  }
  if ((record.unpaid.reconciledPaid ?? 0) > 0) {
    notice(
      `NOTICE: ${record.unpaid.reconciledPaid} ${record.unpaid.reconciledPaid === 1 ? 'person the screen listed' : 'people the screen listed'} as unpaid had already been paid when the cycle closed (recorded under Paid, not here).`,
    );
  }

  // ── Per processor ──────────────────────────────────────────────────────────
  sectionLabel('Paid by processor (frozen at close)');
  drawTable(
    cols([['Processor', 2], ['Payments', 1, 'right'], ['USD', 1.4, 'right'], ['PHP', 1.6, 'right']]),
    processorRows(record.byProcessor).map((p) => [p.id, String(p.count), money(p.usd), money(p.php)]),
  );

  // ── Unpaid list ────────────────────────────────────────────────────────────
  sectionLabel(`Payable, not paid (frozen at close) - ${record.unpaid.payees.length} listed`);
  if (record.unpaid.payees.length === 0) {
    paragraph('Nobody payable was left unpaid when the cycle closed.', BODY, MUTED);
    state.y -= 6;
  } else {
    drawTable(
      cols([['Name', 2.2], ['Email', 2.6], ['Type', 1], ['Reason', 1.4], ['Processor', 1], ['USD', 1, 'right'], ['PHP', 1.2, 'right']]),
      record.unpaid.payees.map((p) => [
        p.name ?? '',
        p.email,
        p.payeeType === 'contractor' ? 'Contractor' : 'Employee',
        REASON_LABEL[p.reason],
        p.processor ?? '',
        money(p.amountUSD),
        money(p.amountPHP),
      ]),
    );
  }

  // ── Audit cross-check ──────────────────────────────────────────────────────
  sectionLabel('Audit cross-check (includes Excluded - not the headline)');
  const ro = record.records_outstanding;
  paragraph(
    ro
      ? `disbursement_records outstanding at close: total ${ro.total} (not paid ${ro.notPaid}, threshold ${ro.threshold}, problem ${ro.problem}, never dispatched ${ro.neverDispatched})`
      : 'disbursement_records cross-check: unavailable',
    BODY,
    MUTED,
  );

  // ── Live paid detail, behind its disclosure ────────────────────────────────
  if (model.livePaidRows && model.livePaidRows.length > 0) {
    sectionLabel(`Paid detail - LIVE, not part of the frozen record - ${model.livePaidRows.length} rows`);
    notice(
      'Live payment_dispatches rows as held when this file was generated - the frozen close-out stores totals only; these rows may differ from the headline in either direction if anything was paid, undone, or re-marked around the close. Bank details are last-4 only.',
    );
    drawTable(
      cols([['Name', 2], ['Email', 2.4], ['Type', 0.9], ['Processor', 1], ['USD', 1, 'right'], ['PHP', 1.1, 'right'], ['Txn ID', 1.4], ['Bank', 1.2], ['Acct', 0.8], ['Sent', 1]]),
      model.livePaidRows.map((r) => [
        r.name ?? '',
        r.email,
        r.payeeType === 'contractor' ? 'Contractor' : 'Employee',
        r.processor ?? '',
        money(r.amountUSD),
        money(r.amountPHP),
        r.transactionId ?? '',
        r.bankUsed ?? '',
        r.accountLast4 ?? '',
        r.dateSent ?? '',
      ]),
    );
  }

  // ── Footer on every page ───────────────────────────────────────────────────
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN, y: BOTTOM - 14 }, end: { x: PAGE_W - MARGIN, y: BOTTOM - 14 }, thickness: 0.5, color: BORDER });
    p.drawText('Simple - Payroll - Cycle Close-Out', { x: MARGIN, y: BOTTOM - 26, size: 7.5, font, color: MUTED });
    const pg = `Page ${i + 1} of ${pages.length}`;
    p.drawText(pg, { x: PAGE_W - MARGIN - font.widthOfTextAtSize(pg, 7.5), y: BOTTOM - 26, size: 7.5, font, color: MUTED });
  });

  return doc.save();
}
