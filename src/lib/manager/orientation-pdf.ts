/**
 * Manager → My Team → New Hire Check List — "Export PDF".
 *
 * Page 1 is the weekly orientation tally (who showed up, who did not, per HR
 * checklist week). Page 2+ is the per-hire detail behind those counts, grouped
 * by the same weeks, so a manager can hand the whole thing to HR and every
 * number is traceable to named people.
 *
 * Deliberately mirrors the Payment Catalog export
 * (src/lib/payment-catalog/catalog-export.ts): pdf-lib built from scratch so it
 * deploys cleanly on Vercel (no template read at runtime), the Simple navy/orange
 * palette, the logo masthead with "Pulled from Simple-HRIS System", navy table
 * headers with alternating rows, orange section bullets, and the shared
 * "Developed by AI/API Team / Simple.biz" page footer. The two reports should
 * read as one family.
 *
 * **There is no money on this document, ever.** Managers see attendance and
 * profile data, never compensation (docs/features/manager-my-team.md). The hire
 * rows this renders come from a route that strips `regular_rate` / `ot_rate`
 * before they leave the server; this file additionally has no column for them.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import {
  attendanceRate,
  OFF_CHECKLIST_LABEL,
  UNDATED_WEEK,
  type OrientationHire,
  type OrientationSummary,
  type OrientationWeek,
} from './orientation-weekly';

const PAGE_W = 612; // US Letter, portrait
const PAGE_H = 792;
const MARGIN = 44;
const CONTENT_W = PAGE_W - MARGIN * 2; // 524
const BOTTOM = 56; // keep content clear of the footer

const NAVY = rgb(0.13, 0.15, 0.33);
const ORANGE = rgb(0.95, 0.45, 0.12);
const WHITE = rgb(1, 1, 1);
const TEXT = rgb(0.12, 0.12, 0.15);
const MUTED = rgb(0.42, 0.42, 0.48);
const ROW_ALT = rgb(0.96, 0.96, 0.985);
const BORDER = rgb(0.86, 0.86, 0.9);
const ROSE = rgb(0.72, 0.16, 0.28);

const BODY = 9;
const LH = 11.5;
const PAD_X = 6;
const PAD_Y = 5;

/** pdf-lib's Helvetica is WinAnsi-encoded; unencodable glyphs throw. */
function sanitize(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) out += ch;
    else if (ch === '–' || ch === '—') out += '-';
    else if (ch === '’' || ch === '‘') out += "'";
    else if (ch === '“' || ch === '”') out += '"';
    else if (ch === '…') out += '...';
    else out += '?';
  }
  return out;
}

function wrapText(raw: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const text = sanitize(raw).trim();
  if (!text) return [''];
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= maxWidth;
  const lines: string[] = [];
  let line = '';
  for (let word of text.split(/\s+/)) {
    while (!fits(word)) {
      let i = word.length;
      while (i > 1 && !fits(word.slice(0, i))) i--;
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, i));
      word = word.slice(i);
      if (i <= 1 && word.length) break;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (line && !fits(candidate)) { lines.push(line); line = word; } else line = candidate;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

type Col = { header: string; width: number; align?: 'left' | 'right' };

async function loadLogoBytes(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

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

/** A hire's orientation date, rendered in Manila (the company tz). */
function manilaDate(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-US', {
    timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric',
  });
}

/**
 * The status column. Mirrors the badge on the hire card, and — like every other
 * consumer of this model — reads the ATTENDED STAMP first, so a row carrying
 * both stamps reads "Attended" rather than "Did not attend".
 */
function statusLabel(h: OrientationHire): string {
  if (h.orientation_attended_at) return 'Attended';
  if (h.status === 'no_show') return 'Did not attend';
  return 'Awaiting orientation';
}

function weekTitle(w: OrientationWeek): string {
  if (w.weekStart === UNDATED_WEEK) return 'No date on record';
  return w.onChecklist ? w.label : `${w.label}  (${OFF_CHECKLIST_LABEL})`;
}

export interface OrientationPdfInput {
  summary: OrientationSummary;
  generatedAt: Date;
  /** "All departments" for elevated viewers, else the manager's dept list. */
  scopeLabel: string;
  logoUrl?: string;
}

/** Build the branded PDF report. Returns the raw PDF bytes. */
export async function generateOrientationPdf(input: OrientationPdfInput): Promise<Uint8Array> {
  const { summary, generatedAt, scopeLabel } = input;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let logo: PDFImage | null = null;
  const logoBytes = await loadLogoBytes(input.logoUrl ?? '/simple-logo.png');
  if (logoBytes) {
    try {
      logo = await doc.embedPng(logoBytes);
    } catch {
      logo = null;
    }
  }

  const year = generatedAt.getFullYear();
  const state = { page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN };

  const newPage = () => {
    state.page = doc.addPage([PAGE_W, PAGE_H]);
    state.y = PAGE_H - MARGIN;
  };
  const ensure = (space: number) => {
    if (state.y - space < BOTTOM) newPage();
  };

  // ── Masthead ──────────────────────────────────────────────────────────────
  {
    const top = state.y;
    if (logo) {
      const h = 30;
      const w = (logo.width / logo.height) * h;
      state.page.drawImage(logo, { x: MARGIN, y: top - h, width: w, height: h });
    } else {
      state.page.drawText('Simple', { x: MARGIN, y: top - 24, size: 24, font: bold, color: NAVY });
    }

    const right = (text: string, y: number, size: number, f: PDFFont, color = MUTED) => {
      const s = sanitize(text);
      const w = f.widthOfTextAtSize(s, size);
      state.page.drawText(s, { x: PAGE_W - MARGIN - w, y, size, font: f, color });
    };
    right('Pulled from Simple-HRIS System', top - 8, 9.5, bold, NAVY);
    right(`Exported ${formatTimestamp(generatedAt)}`, top - 21, 8.5, font);
    right(`${String.fromCharCode(0xa9)} ${year} Simple.biz`, top - 32, 8, font);

    state.y = top - 46;
    state.page.drawText('Orientation Attendance - Weekly Report', {
      x: MARGIN, y: state.y, size: 16, font: bold, color: NAVY,
    });
    state.y -= 15;
    state.page.drawText(
      sanitize(`Who showed up for orientation, by hiring week.  Scope: ${scopeLabel}`),
      { x: MARGIN, y: state.y, size: 9, font, color: MUTED },
    );
    state.y -= 11;
    state.page.drawText(
      'Weeks are HR\'s New Hire Checklist weeks. "Did not attend" = never marked orientation attended.',
      { x: MARGIN, y: state.y, size: 8, font, color: MUTED },
    );
    state.y -= 10;
    state.page.drawLine({
      start: { x: MARGIN, y: state.y }, end: { x: PAGE_W - MARGIN, y: state.y },
      thickness: 1.3, color: NAVY,
    });
    state.y -= 18;
  }

  // ── Table renderer ────────────────────────────────────────────────────────
  const drawTable = (columns: Col[], rows: string[][], opts: { emphasizeLast?: boolean } = {}) => {
    const headerH = LH + PAD_Y * 2;

    const drawHeader = () => {
      state.page.drawRectangle({ x: MARGIN, y: state.y - headerH, width: CONTENT_W, height: headerH, color: NAVY });
      let x = MARGIN;
      for (const c of columns) {
        const lines = wrapText(c.header, bold, BODY, c.width - PAD_X * 2);
        const tw = bold.widthOfTextAtSize(lines[0]!, BODY);
        const tx = c.align === 'right' ? x + c.width - PAD_X - tw : x + PAD_X;
        state.page.drawText(lines[0]!, { x: tx, y: state.y - PAD_Y - BODY, size: BODY, font: bold, color: WHITE });
        x += c.width;
      }
      state.y -= headerH;
    };

    ensure(headerH + LH + PAD_Y * 2);
    drawHeader();

    let alt = false;
    rows.forEach((row, ri) => {
      const isTotal = Boolean(opts.emphasizeLast) && ri === rows.length - 1;
      const f = isTotal ? bold : font;
      const cellLines = columns.map((c, i) => wrapText(row[i] ?? '', f, BODY, c.width - PAD_X * 2));
      const maxLines = Math.max(1, ...cellLines.map((l) => l.length));
      const rowH = maxLines * LH + PAD_Y * 2;

      if (state.y - rowH < BOTTOM) {
        newPage();
        drawHeader();
        alt = false;
      }

      if (alt && !isTotal) {
        state.page.drawRectangle({ x: MARGIN, y: state.y - rowH, width: CONTENT_W, height: rowH, color: ROW_ALT });
      }

      let x = MARGIN;
      for (let i = 0; i < columns.length; i++) {
        const c = columns[i]!;
        const lines = cellLines[i]!;
        // The "did not attend" count is the point of the document — colour it
        // so a non-zero week is findable at a glance.
        const isMiss = c.header === 'Did not attend' && (row[i] ?? '0') !== '0';
        for (let li = 0; li < lines.length; li++) {
          const tw = f.widthOfTextAtSize(lines[li]!, BODY);
          const tx = c.align === 'right' ? x + c.width - PAD_X - tw : x + PAD_X;
          state.page.drawText(lines[li]!, {
            x: tx, y: state.y - PAD_Y - BODY - li * LH, size: BODY,
            font: isMiss ? bold : f, color: isMiss ? ROSE : TEXT,
          });
        }
        x += c.width;
      }
      state.page.drawLine({
        start: { x: MARGIN, y: state.y - rowH }, end: { x: MARGIN + CONTENT_W, y: state.y - rowH },
        thickness: 0.5, color: BORDER,
      });
      state.y -= rowH;
      alt = !alt;
    });
    state.y -= 8;
  };

  const sectionLabel = (text: string) => {
    ensure(24);
    state.page.drawRectangle({ x: MARGIN, y: state.y - 9, width: 4, height: 10, color: ORANGE });
    state.page.drawText(sanitize(text), { x: MARGIN + 10, y: state.y - 8, size: 9.5, font: bold, color: NAVY });
    state.y -= 17;
  };

  const note = (text: string) => {
    for (const ln of wrapText(text, font, 8.5, CONTENT_W - 10)) {
      ensure(13);
      state.page.drawText(ln, { x: MARGIN + 10, y: state.y - 9, size: 8.5, font, color: MUTED });
      state.y -= 11;
    }
    state.y -= 6;
  };

  // ── Page 1: the weekly tally ──────────────────────────────────────────────
  const SUMMARY_COLS: Col[] = [
    { header: 'Hiring week', width: 150 },
    { header: 'Hires', width: 60, align: 'right' },
    { header: 'Attended', width: 70, align: 'right' },
    { header: 'Did not attend', width: 88, align: 'right' },
    { header: 'No-show', width: 62, align: 'right' },
    { header: 'Awaiting', width: 62, align: 'right' },
    { header: 'Rate', width: 32, align: 'right' },
  ];
  const summaryRow = (w: OrientationWeek): string[] => {
    const r = attendanceRate(w);
    return [
      weekTitle(w),
      String(w.total),
      String(w.attended),
      String(w.notAttended),
      String(w.noShow),
      String(w.stillOpen),
      r == null ? '-' : `${r}%`,
    ];
  };

  sectionLabel('ORIENTATION ATTENDANCE BY WEEK');
  const allWeeks = [...summary.weeks, ...summary.offChecklist];
  if (allWeeks.length === 0) {
    note('No hires on record for this scope.');
  } else {
    const t = summary.totals;
    const totalRate = t.total > 0 ? `${Math.round((t.attended / t.total) * 100)}%` : '-';
    drawTable(
      SUMMARY_COLS,
      [
        ...summary.weeks.map(summaryRow),
        ...summary.offChecklist.map(summaryRow),
        ['TOTAL', String(t.total), String(t.attended), String(t.notAttended), String(t.noShow), String(t.stillOpen), totalRate],
      ],
      { emphasizeLast: true },
    );
    if (summary.offChecklist.length > 0) {
      note(
        `${t.unmatched} ${t.unmatched === 1 ? 'hire is' : 'hires are'} not on any New Hire Checklist week ` +
          '- their personal email matches no checklist row. They are shown under their own ' +
          'staging week and are counted in the totals, never folded into an HR week.',
      );
    }
  }

  // ── Page 2+: the people behind the counts ────────────────────────────────
  const DETAIL_COLS: Col[] = [
    { header: 'Name', width: 118 },
    { header: 'Department', width: 92 },
    { header: 'Status', width: 92 },
    { header: 'Date', width: 74 },
    { header: 'Marked by', width: 148 },
  ];

  const detailRow = (h: OrientationHire): string[] => {
    const isNoShow = !h.orientation_attended_at && h.status === 'no_show';
    const when = h.orientation_attended_at ?? (isNoShow ? h.no_show_at : null);
    const by = h.orientation_attended_at
      ? h.orientation_attended_by
      : isNoShow
        ? h.no_show_by
        : null;
    return [
      h.name ?? '-',
      formatDeptLabel(h.department),
      statusLabel(h),
      manilaDate(when),
      by ?? '-',
    ];
  };

  const weekBlock = (w: OrientationWeek) => {
    ensure(58); // never orphan a week header at the foot of a page
    const h = 22;
    state.page.drawRectangle({ x: MARGIN, y: state.y - h, width: CONTENT_W, height: h, color: NAVY });
    state.page.drawRectangle({ x: MARGIN, y: state.y - h, width: 5, height: h, color: ORANGE });
    state.page.drawText(sanitize(weekTitle(w)), { x: MARGIN + 14, y: state.y - 15, size: 12.5, font: bold, color: WHITE });
    const tally = sanitize(`${w.attended} attended / ${w.notAttended} did not`);
    const tw = bold.widthOfTextAtSize(tally, 9);
    state.page.drawText(tally, { x: PAGE_W - MARGIN - tw - 10, y: state.y - 14, size: 9, font: bold, color: WHITE });
    state.y -= h + 6;

    // Not-attended first: this report exists to surface them.
    const missed = w.hires.filter((x) => !x.orientation_attended_at);
    const attended = w.hires.filter((x) => Boolean(x.orientation_attended_at));

    if (missed.length > 0) {
      sectionLabel(`DID NOT ATTEND  (${missed.length})`);
      drawTable(DETAIL_COLS, missed.map(detailRow));
    }
    if (attended.length > 0) {
      sectionLabel(`ATTENDED  (${attended.length})`);
      drawTable(DETAIL_COLS, attended.map(detailRow));
    }
    if (w.hires.length === 0) note('No hires in this week.');
  };

  if (allWeeks.length > 0) {
    newPage();
    for (const w of allWeeks) weekBlock(w);
  }

  // ── Footers on every page ────────────────────────────────────────────────
  const pages = doc.getPages();
  const total = pages.length;
  const footerText = `Developed by AI/API Team / Simple.biz ${String.fromCharCode(0xa9)} ${year}`;
  pages.forEach((p: PDFPage, i: number) => {
    p.drawLine({ start: { x: MARGIN, y: 40 }, end: { x: PAGE_W - MARGIN, y: 40 }, thickness: 0.5, color: BORDER });
    p.drawText(sanitize(footerText), { x: MARGIN, y: 28, size: 8, font, color: MUTED });
    const pg = `Page ${i + 1} of ${total}`;
    const w = font.widthOfTextAtSize(pg, 8);
    p.drawText(pg, { x: PAGE_W - MARGIN - w, y: 28, size: 8, font, color: MUTED });
  });

  return doc.save();
}

/** YYYY-MM-DD for the filename. */
function dateSuffix(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Build + download the report. */
export async function downloadOrientationPdf(input: OrientationPdfInput): Promise<void> {
  const bytes = await generateOrientationPdf(input);
  // Copy into a fresh ArrayBuffer so the Blob gets a plain buffer, not a view.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const url = URL.createObjectURL(new Blob([ab], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `orientation-attendance-${dateSuffix(input.generatedAt)}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 200);
}
