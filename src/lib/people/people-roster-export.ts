// People roster → CSV + XLSX + PDF export.
//
// Turns the roster currently in view (respecting the active search, department,
// OT-only filter, and the selected pay week / custom range) into a portable
// payout-oriented directory in three formats:
//
//   - CSV   → one flat, spreadsheet-friendly table (UTF-8 BOM so Excel renders
//             the peso symbol correctly), with a short provenance preamble.
//   - XLSX  → a native Excel workbook (title banner + an at-a-glance summary +
//             one row per person, numeric hours columns, sized columns,
//             autofilter over the header).
//   - PDF   → a branded document built from scratch with pdf-lib so it deploys
//             cleanly on Vercel (no template file read at runtime), carrying the
//             Simple logo in the masthead.
//
// All three run entirely in the browser (in-memory Blob download) — the rows are
// already loaded in the tab, so there's no server round-trip.
//
// The visual theme deliberately mirrors the CEO dashboard (the warm orange→rose
// gradient + amber/gold accents on warm-neutral surfaces), matching the sibling
// `global-master-list-export.ts`. pdf-lib fills are single-colour, so the
// orange→rose gradient is reproduced by interpolating a strip of thin rectangles
// (see drawHGradient).
//
// NOTE on XLSX theming: the pure-JS `xlsx` (SheetJS community) build does not
// emit cell fills / font colours — that's a Pro-only feature. So the sheet's
// "theme" is structural (title/summary banner rows, sized columns, an
// auto-filtered header) rather than coloured cells. The PDF carries the full
// colour treatment.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import * as XLSX from 'xlsx';

// ---------------------------------------------------------------------------
// Input + structured model
// ---------------------------------------------------------------------------

type Currency = 'PHP' | 'USD' | 'COP';

/**
 * The subset of a roster row this export reads. Kept loose so the People tab's
 * `RosterRow` is structurally assignable without a hard import.
 */
export interface RosterExportInput {
  employee_id: string | null;
  name: string | null;
  department: string | null;
  work_email?: string | null;
  personal_email?: string | null;
  location?: string | null;
  city?: string | null;
  province?: string | null;
  full_address?: string | null;
  start_date: string | null;
  rate: { regular: number | null; ot: number | null; currency: Currency };
  hours: { thisWeek: number; ot: number };
  processor: string | null;
  hasBanking: boolean;
}

/** One person, normalized for the flat table (raw numerics kept for XLSX sums). */
export interface RosterExportRecord {
  employeeId: string;
  name: string;
  department: string;
  workEmail: string;
  personalEmail: string;
  hours: number;
  otHours: number;
  rateRegular: number | null;
  rateOt: number | null;
  currency: Currency;
  payout: string;
  hasBanking: boolean;
  startDate: string; // formatted, or ''
  location: string;
}

export interface RosterExportModel {
  generatedAt: Date;
  rows: RosterExportRecord[];
  /** Total people in the current period BEFORE the in-view filter. */
  periodTotal: number;
  /** Friendly pay-week / range label the roster is scoped to. */
  periodLabel: string;
  /** Describes the in-view filter, e.g. "All departments" or
   *  "Engineering · OT only · matching \"kane\"". */
  filterLabel: string;
  /** Column header for the hours column ("Hours this week" / "Hours in range"). */
  hoursHeader: string;
  /** True when scoped to a custom multi-week range rather than a single week. */
  rangeMode: boolean;
  /** Period-wide OT payout (server summary), shown as provenance. Period-scoped,
   *  NOT recomputed for a filtered subset — labelled as such. */
  periodOtPayoutUsd: number | null;
  periodOtPayoutPhp: number;
  // ── Derived over the exported (filtered) rows — no FX needed ──
  departmentCount: number;
  otCount: number;
  otHours: number;
  payoutCount: number;
  missingBankCount: number;
}

export interface BuildRosterExportInput {
  rows: readonly RosterExportInput[];
  periodTotal: number;
  periodLabel: string;
  filterLabel?: string;
  hoursHeader?: string;
  rangeMode?: boolean;
  periodOtPayoutUsd?: number | null;
  periodOtPayoutPhp?: number | null;
}

const DASH = '-';

function clean(v: string | null | undefined): string {
  return (v ?? '').toString().trim();
}

function join(parts: (string | null | undefined)[], sep = ', '): string {
  return parts.map(clean).filter(Boolean).join(sep);
}

/** "Jul 4, 2026" for an ISO/free-text date; '' when absent, raw when unparseable. */
function formatDate(iso: string | null): string {
  const s = clean(iso);
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  try {
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return s;
  }
}

/** Best available location string for a person (mirrors the roster's own logic). */
function locationOf(r: RosterExportInput): string {
  return clean(r.location) || join([r.city, r.province]) || clean(r.full_address);
}

/** Payout method label — matches the on-screen chip: processor (capitalised),
 *  else "On file" when banking exists, else "None". */
function payoutOf(r: RosterExportInput): string {
  const p = clean(r.processor);
  if (p) return p.charAt(0).toUpperCase() + p.slice(1);
  return r.hasBanking ? 'On file' : 'None';
}

/** Shape the raw roster rows into a clean, per-person export model + rollups. */
export function buildRosterExport(input: BuildRosterExportInput): RosterExportModel {
  const rows: RosterExportRecord[] = input.rows.map((r) => ({
    employeeId: clean(r.employee_id) || DASH,
    name: clean(r.name) || 'Unknown',
    department: clean(r.department) || DASH,
    workEmail: clean(r.work_email) || DASH,
    personalEmail: clean(r.personal_email) || DASH,
    hours: Number.isFinite(r.hours?.thisWeek) ? r.hours.thisWeek : 0,
    otHours: Number.isFinite(r.hours?.ot) ? r.hours.ot : 0,
    rateRegular: r.rate?.regular ?? null,
    rateOt: r.rate?.ot ?? null,
    currency: r.rate?.currency ?? 'PHP',
    payout: payoutOf(r),
    hasBanking: !!r.hasBanking,
    startDate: formatDate(r.start_date),
    location: locationOf(r) || DASH,
  }));

  const depts = new Set<string>();
  for (const r of input.rows) {
    const d = clean(r.department);
    if (d) depts.add(d.toLowerCase());
  }

  let otCount = 0;
  let otHours = 0;
  let payoutCount = 0;
  let missingBankCount = 0;
  for (const r of rows) {
    if (r.otHours > 0) {
      otCount += 1;
      otHours += r.otHours;
    }
    if (r.hours > 0) payoutCount += 1;
    if (!r.hasBanking) missingBankCount += 1;
  }

  return {
    generatedAt: new Date(),
    rows,
    periodTotal: input.periodTotal,
    periodLabel: clean(input.periodLabel) || 'Current week',
    filterLabel: clean(input.filterLabel) || 'All departments',
    hoursHeader: clean(input.hoursHeader) || 'Hours this week',
    rangeMode: !!input.rangeMode,
    periodOtPayoutUsd: input.periodOtPayoutUsd ?? null,
    periodOtPayoutPhp: input.periodOtPayoutPhp ?? 0,
    departmentCount: depts.size,
    otCount,
    otHours: Math.round(otHours * 10) / 10,
    payoutCount,
    missingBankCount,
  };
}

// ---------------------------------------------------------------------------
// Shared: formatting helpers
// ---------------------------------------------------------------------------

/** Money for one person's NATIVE currency. `ascii` swaps the peso glyph for
 *  "PHP " so it survives pdf-lib's WinAnsi Helvetica encoding. */
function fmtMoney(amount: number | null | undefined, currency: Currency, ascii = false): string {
  if (amount == null) return DASH;
  if (currency === 'USD') return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (currency === 'COP') return `COP ${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const n = amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return ascii ? `PHP ${n}` : `₱${n}`;
}

/** "45.0h"; DASH for a zero/absent value when `dashZero` (OT columns hide 0). */
function fmtHours(h: number | null | undefined, dashZero = false): string {
  if (h == null) return DASH;
  if (dashZero && h <= 0) return DASH;
  return `${h.toLocaleString('en-US', { maximumFractionDigits: 1 })}h`;
}

/** Full export timestamp, e.g. "July 20, 2026, 3:45 PM GMT+8" (viewer local time). */
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

function countLabel(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? 'person' : 'people'}`;
}

/** "3 of 402 in period" (or just the count when the view is unfiltered). */
function scopeCountLabel(model: RosterExportModel): string {
  const shown = model.rows.length;
  if (shown === model.periodTotal) return `${countLabel(shown)} in period`;
  return `${countLabel(shown)} of ${model.periodTotal.toLocaleString()} in period`;
}

// ---------------------------------------------------------------------------
// Shared columns — the flat CSV / XLSX table
// ---------------------------------------------------------------------------

/** Per-column value accessors. `num` marks columns kept numeric in the XLSX. */
interface FlatColumn {
  header: (m: RosterExportModel) => string;
  get: (r: RosterExportRecord) => string;
  num?: (r: RosterExportRecord) => number;
}

const FLAT_COLUMNS: FlatColumn[] = [
  { header: () => 'Employee ID', get: (r) => r.employeeId },
  { header: () => 'Name', get: (r) => r.name },
  { header: () => 'Department', get: (r) => r.department },
  { header: () => 'Work Email', get: (r) => r.workEmail },
  { header: () => 'Personal Email', get: (r) => r.personalEmail },
  { header: (m) => m.hoursHeader, get: (r) => String(r.hours), num: (r) => r.hours },
  { header: () => 'OT Hours', get: (r) => String(r.otHours), num: (r) => r.otHours },
  { header: () => 'Pay Rate', get: (r) => fmtMoney(r.rateRegular, r.currency) },
  { header: () => 'OT Rate', get: (r) => fmtMoney(r.rateOt, r.currency) },
  { header: () => 'Currency', get: (r) => r.currency },
  { header: () => 'Payout Method', get: (r) => r.payout },
  { header: () => 'Banking on File', get: (r) => (r.hasBanking ? 'Yes' : 'No') },
  { header: () => 'Start Date', get: (r) => r.startDate || DASH },
  { header: () => 'Location', get: (r) => r.location },
];

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC 4180 escaping: wrap in quotes when the value has a comma/quote/newline. */
function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Serialize the model to a single flat CSV table (with a UTF-8 BOM). */
export function rosterToCsv(model: RosterExportModel): string {
  const year = model.generatedAt.getFullYear();
  const payout = model.periodOtPayoutUsd != null
    ? `Period OT payout: ${fmtMoney(model.periodOtPayoutUsd, 'USD')} (${fmtMoney(model.periodOtPayoutPhp, 'PHP')})`
    : `Period OT payout: ${fmtMoney(model.periodOtPayoutPhp, 'PHP')}`;
  const preamble = [
    ['People Roster'],
    [`Period: ${model.periodLabel}`],
    [`Filter: ${model.filterLabel}`],
    ['Pulled from Simple-HRIS System'],
    [`Exported: ${formatTimestamp(model.generatedAt)}`],
    [`${scopeCountLabel(model)} · ${model.departmentCount} department${model.departmentCount === 1 ? '' : 's'} · ${model.otCount} on overtime`],
    [payout],
    [`Developed by AI/API Team / Simple.biz (c) ${year}`],
    [''],
  ].map((row) => row.map(csvEscape).join(','));

  const header = ['#', ...FLAT_COLUMNS.map((c) => c.header(model))].map(csvEscape).join(',');
  const body = model.rows.map((r, i) =>
    [i + 1, ...FLAT_COLUMNS.map((c) => c.get(r))].map(csvEscape).join(','),
  );
  return '﻿' + [...preamble, header, ...body].join('\r\n');
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

const XLSX_COLUMN_WIDTHS = [14, 26, 20, 32, 32, 15, 11, 14, 14, 9, 16, 15, 14, 26];

/** Build a native Excel workbook: a titled sheet with one row per person. */
export function buildRosterWorkbook(model: RosterExportModel): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const payout = model.periodOtPayoutUsd != null
    ? `${fmtMoney(model.periodOtPayoutUsd, 'USD')} (${fmtMoney(model.periodOtPayoutPhp, 'PHP')})`
    : fmtMoney(model.periodOtPayoutPhp, 'PHP');
  const aoa: (string | number)[][] = [
    ['People Roster'],
    [`Period: ${model.periodLabel}  ·  Filter: ${model.filterLabel}`],
    [`Exported ${formatTimestamp(model.generatedAt)} · ${scopeCountLabel(model)} · ${model.departmentCount} department${model.departmentCount === 1 ? '' : 's'} · ${model.otCount} on overtime · Period OT payout ${payout}`],
    [],
    ['#', ...FLAT_COLUMNS.map((c) => c.header(model))],
  ];
  model.rows.forEach((r, i) => {
    aoa.push([
      i + 1,
      ...FLAT_COLUMNS.map((c) => (c.num ? c.num(r) : c.get(r))),
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 5 }, ...XLSX_COLUMN_WIDTHS.map((wch) => ({ wch }))];
  const headerRow = 5; // 1-indexed row that holds the column headers
  const lastCol = FLAT_COLUMNS.length; // 0=`#`, then one per column
  ws['!autofilter'] = { ref: `A${headerRow}:${XLSX.utils.encode_col(lastCol)}${headerRow + model.rows.length}` };
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: lastCol } },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'People Roster');
  return wb;
}

// ---------------------------------------------------------------------------
// PDF — CEO-dashboard themed (warm orange → rose + amber/gold)
// ---------------------------------------------------------------------------

const PAGE_W = 612; // US Letter, portrait
const PAGE_H = 792;
const MARGIN = 44;
const CONTENT_W = PAGE_W - MARGIN * 2; // 524
const BOTTOM = 56; // keep content clear of the footer

// Palette lifted from the CEO dashboard (CeoOverviewKpis.tsx): orange-600 →
// rose-500 hero gradient, amber-500 accent, warm cream surfaces.
type RGB = readonly [number, number, number];
const C_ORANGE: RGB = [0.918, 0.345, 0.047]; // #EA580C  orange-600
const C_ORANGE_500: RGB = [0.976, 0.451, 0.086]; // #F97316  orange-500
const C_ROSE: RGB = [0.957, 0.247, 0.369]; // #F43F5E  rose-500
const C_AMBER: RGB = [0.961, 0.62, 0.043]; // #F59E0B  amber-500
const tup = (c: RGB) => rgb(c[0], c[1], c[2]);

const ORANGE = tup(C_ORANGE);
const AMBER = tup(C_AMBER);
const WHITE = rgb(1, 1, 1);
const INK = rgb(0.094, 0.094, 0.106); // zinc-900  #18181B
const MUTED = rgb(0.443, 0.443, 0.478); // zinc-500  #71717A
const ROW_ALT = rgb(1, 0.969, 0.929); // orange-50  #FFF7ED  (warm zebra)
const BORDER = rgb(0.914, 0.871, 0.812); // warm hairline

// pdf-lib's Helvetica is WinAnsi-encoded; characters outside it throw. Replace
// the few symbols that show up (smart punctuation) with safe equivalents, and
// anything else unencodable with '?'.
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

/** Wrap text to a width, hard-breaking tokens that are themselves too long. */
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

/** Draw a horizontal gradient bar by slicing into thin rectangles — pdf-lib has
 *  no native gradients, so this reproduces the dashboard's orange→rose accent. */
function drawHGradient(
  page: PDFPage,
  x: number,
  y: number,
  w: number,
  h: number,
  from: RGB,
  to: RGB,
  steps = 60,
): void {
  const sw = w / steps;
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    const r = from[0] + (to[0] - from[0]) * t;
    const g = from[1] + (to[1] - from[1]) * t;
    const b = from[2] + (to[2] - from[2]) * t;
    page.drawRectangle({ x: x + i * sw, y, width: sw + 0.6, height: h, color: rgb(r, g, b) });
  }
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

/** Build the CEO-themed PDF report. Returns the raw PDF bytes. */
export async function generateRosterPdf(
  model: RosterExportModel,
  opts: { logoUrl?: string } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let logo: PDFImage | null = null;
  const logoBytes = await loadLogoBytes(opts.logoUrl ?? '/simple-logo.png');
  if (logoBytes) {
    try {
      logo = await doc.embedPng(logoBytes);
    } catch {
      logo = null;
    }
  }

  const year = model.generatedAt.getFullYear();
  const state = { page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN };

  const newPage = () => {
    state.page = doc.addPage([PAGE_W, PAGE_H]);
    state.y = PAGE_H - MARGIN;
  };
  const ensure = (space: number) => {
    if (state.y - space < BOTTOM) newPage();
  };

  // ── Masthead (page 1) ─────────────────────────────────────────────────────
  {
    const top = state.y;
    if (logo) {
      const h = 30;
      const w = (logo.width / logo.height) * h;
      state.page.drawImage(logo, { x: MARGIN, y: top - h, width: w, height: h });
    } else {
      state.page.drawText('Simple', { x: MARGIN, y: top - 24, size: 24, font: bold, color: ORANGE });
    }

    const right = (text: string, y: number, size: number, f: PDFFont, color = MUTED) => {
      const s = sanitize(text);
      const w = f.widthOfTextAtSize(s, size);
      state.page.drawText(s, { x: PAGE_W - MARGIN - w, y, size, font: f, color });
    };
    right('Pulled from Simple-HRIS System', top - 8, 9.5, bold, INK);
    right(`Exported ${formatTimestamp(model.generatedAt)}`, top - 21, 8.5, font);
    right(`${String.fromCharCode(0xa9)} ${year} Simple.biz`, top - 32, 8, font);

    state.y = top - 48;
    // Orange eyebrow → warm-branded, then the report title.
    state.page.drawText('ACCOUNTING - PEOPLE ROSTER', { x: MARGIN, y: state.y, size: 8.5, font: bold, color: ORANGE });
    state.y -= 18;
    state.page.drawText('People Roster', { x: MARGIN, y: state.y, size: 17, font: bold, color: INK });
    state.y -= 14;
    state.page.drawText(
      sanitize(`${model.periodLabel}  -  ${model.filterLabel}`),
      { x: MARGIN, y: state.y, size: 9, font, color: MUTED },
    );
    state.y -= 11;
    state.page.drawText(
      sanitize(scopeCountLabel(model)),
      { x: MARGIN, y: state.y, size: 9, font, color: MUTED },
    );
    state.y -= 9;
    // Signature orange→rose accent rule (the dashboard's hero hairline).
    drawHGradient(state.page, MARGIN, state.y - 2.4, CONTENT_W, 2.4, C_ORANGE_500, C_ROSE);
    state.y -= 18;
  }

  // ── At-a-glance metric band (amber-topped stat cards, like the hero tiles) ──
  {
    const payoutSub = model.periodOtPayoutUsd != null
      ? fmtMoney(model.periodOtPayoutUsd, 'USD', true)
      : fmtMoney(model.periodOtPayoutPhp, 'PHP', true);
    const items: { label: string; value: string; sub: string }[] = [
      { label: 'People', value: model.rows.length.toLocaleString(), sub: `${model.departmentCount} dept${model.departmentCount === 1 ? '' : 's'}` },
      { label: 'On overtime', value: model.otCount.toLocaleString(), sub: `${fmtHours(model.otHours)} OT` },
      { label: 'Payouts to send', value: model.payoutCount.toLocaleString(), sub: payoutSub },
      { label: 'Missing bank info', value: model.missingBankCount.toLocaleString(), sub: 'no payout method' },
    ];
    const gap = 10;
    const boxW = (CONTENT_W - gap * (items.length - 1)) / items.length;
    const boxH = 52;
    ensure(boxH + 10);
    state.y -= boxH;
    items.forEach((item, i) => {
      const x = MARGIN + i * (boxW + gap);
      state.page.drawRectangle({ x, y: state.y, width: boxW, height: boxH, color: ROW_ALT, borderColor: BORDER, borderWidth: 0.5 });
      // Amber top accent — the dashboard's headcount/gold highlight.
      state.page.drawRectangle({ x, y: state.y + boxH - 3, width: boxW, height: 3, color: AMBER });
      state.page.drawText(sanitize(item.label.toUpperCase()), { x: x + 9, y: state.y + boxH - 16, size: 7, font: bold, color: MUTED });
      state.page.drawText(sanitize(item.value), { x: x + 9, y: state.y + 17, size: 18, font: bold, color: ORANGE });
      state.page.drawText(sanitize(item.sub), { x: x + 9, y: state.y + 7, size: 7, font, color: MUTED });
    });
    state.y -= 16;
  }

  // ── Roster table (orange header, warm zebra; paginates with redrawn header) ─
  const BODY = 8.5;
  const LH = 11;
  const PAD_X = 6;
  const PAD_Y = 5;

  const columns: Col[] = [
    { header: '#', width: 22, align: 'right' },
    { header: 'ID', width: 50 },
    { header: 'Name', width: 100 },
    { header: 'Department', width: 82 },
    { header: 'Hours', width: 46, align: 'right' },
    { header: 'OT', width: 40, align: 'right' },
    { header: 'Rate', width: 74, align: 'right' },
    { header: 'Payout', width: CONTENT_W - 22 - 50 - 100 - 82 - 46 - 40 - 74 },
  ];
  const tableRows = model.rows.map((r, i) => [
    String(i + 1),
    r.employeeId,
    r.name,
    r.department,
    fmtHours(r.hours),
    fmtHours(r.otHours, true),
    fmtMoney(r.rateRegular, r.currency, true),
    r.payout,
  ]);

  const drawTable = (cols: Col[], rows: string[][]) => {
    const headerH = LH + PAD_Y * 2;
    const drawHeader = () => {
      state.page.drawRectangle({ x: MARGIN, y: state.y - headerH, width: CONTENT_W, height: headerH, color: ORANGE });
      let x = MARGIN;
      for (const c of cols) {
        const label = wrapText(c.header, bold, BODY, c.width - PAD_X * 2)[0];
        const tw = bold.widthOfTextAtSize(label, BODY);
        const tx = c.align === 'right' ? x + c.width - PAD_X - tw : x + PAD_X;
        state.page.drawText(label, { x: tx, y: state.y - PAD_Y - BODY, size: BODY, font: bold, color: WHITE });
        x += c.width;
      }
      state.y -= headerH;
    };

    ensure(headerH + LH + PAD_Y * 2);
    drawHeader();

    let alt = false;
    for (const row of rows) {
      const cellLines = cols.map((c, i) => wrapText(row[i] ?? '', font, BODY, c.width - PAD_X * 2));
      const maxLines = Math.max(1, ...cellLines.map((l) => l.length));
      const rowH = maxLines * LH + PAD_Y * 2;

      if (state.y - rowH < BOTTOM) {
        newPage();
        drawHeader();
        alt = false;
      }
      if (alt) {
        state.page.drawRectangle({ x: MARGIN, y: state.y - rowH, width: CONTENT_W, height: rowH, color: ROW_ALT });
      }

      let x = MARGIN;
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        const lines = cellLines[i];
        for (let li = 0; li < lines.length; li++) {
          const tw = font.widthOfTextAtSize(lines[li], BODY);
          const tx = c.align === 'right' ? x + c.width - PAD_X - tw : x + PAD_X;
          state.page.drawText(lines[li], { x: tx, y: state.y - PAD_Y - BODY - li * LH, size: BODY, font, color: INK });
        }
        x += c.width;
      }
      state.page.drawLine({
        start: { x: MARGIN, y: state.y - rowH },
        end: { x: MARGIN + CONTENT_W, y: state.y - rowH },
        thickness: 0.5,
        color: BORDER,
      });
      state.y -= rowH;
      alt = !alt;
    }
    state.y -= 8;
  };

  if (model.rows.length === 0) {
    ensure(20);
    state.page.drawText('No people match this view.', { x: MARGIN, y: state.y - 10, size: 10, font, color: MUTED });
    state.y -= 22;
  } else {
    drawTable(columns, tableRows);
  }

  // ── Footers on every page ───────────────────────────────────────────────────
  const pages = doc.getPages();
  const total = pages.length;
  const footerText = `Developed by AI/API Team / Simple.biz ${String.fromCharCode(0xa9)} ${year}`;
  pages.forEach((p: PDFPage, i: number) => {
    // Thin gradient rule above the footer echoes the masthead accent.
    drawHGradient(p, MARGIN, 41, CONTENT_W, 1, C_ORANGE_500, C_ROSE, 40);
    p.drawText(sanitize(footerText), { x: MARGIN, y: 28, size: 8, font, color: MUTED });
    const pg = `Page ${i + 1} of ${total}`;
    const w = font.widthOfTextAtSize(pg, 8);
    p.drawText(pg, { x: PAGE_W - MARGIN - w, y: 28, size: 8, font, color: MUTED });
  });

  return doc.save();
}

// ---------------------------------------------------------------------------
// Browser download helpers
// ---------------------------------------------------------------------------

/** YYYY-MM-DD for filename suffixes. */
function dateSuffix(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

function baseName(model: RosterExportModel): string {
  return `people-roster-${dateSuffix(model.generatedAt)}`;
}

/** Build + download the CSV report. */
export function downloadRosterCsv(model: RosterExportModel): void {
  downloadBlob(
    `${baseName(model)}.csv`,
    new Blob([rosterToCsv(model)], { type: 'text/csv;charset=utf-8' }),
  );
}

/** Build + download the XLSX workbook. */
export function downloadRosterXlsx(model: RosterExportModel): void {
  const wb = buildRosterWorkbook(model);
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  downloadBlob(
    `${baseName(model)}.xlsx`,
    new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  );
}

/** Build + download the CEO-themed PDF report. */
export async function downloadRosterPdf(
  model: RosterExportModel,
  opts?: { logoUrl?: string },
): Promise<void> {
  const bytes = await generateRosterPdf(model, opts);
  // Copy into a fresh ArrayBuffer so the Blob gets a plain ArrayBuffer.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  downloadBlob(`${baseName(model)}.pdf`, new Blob([ab], { type: 'application/pdf' }));
}
