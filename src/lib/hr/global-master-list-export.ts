// HR — Global Master List → CSV + XLSX + PDF export.
//
// Turns the roster currently in view (respecting the active search + department
// filter) into a portable directory in three formats:
//
//   - CSV   → one flat, spreadsheet-friendly table (UTF-8 BOM so Excel renders
//             symbols correctly), with a short provenance preamble.
//   - XLSX  → a native Excel workbook (title banner + an at-a-glance summary +
//             one row per employee, sized columns, frozen header, autofilter).
//   - PDF   → a branded document built from scratch with pdf-lib so it deploys
//             cleanly on Vercel (no template file read at runtime).
//
// All three run entirely in the browser (in-memory Blob download) — the rows
// are already loaded in the tab, so there's no server round-trip.
//
// The visual theme deliberately mirrors the CEO dashboard rather than the older
// navy/orange "Payment Catalog" family: the warm orange→rose gradient accents
// and amber/gold highlights from src/components/ceo/CeoOverviewKpis.tsx, on the
// #0d1117-adjacent warm-neutral surfaces. pdf-lib fills are single-colour, so
// the dashboard's signature orange→rose gradient is reproduced by interpolating
// a strip of thin rectangles (see drawHGradient).
//
// NOTE on XLSX theming: the pure-JS `xlsx` (SheetJS community) build does not
// emit cell fills / font colours when it writes a workbook — that's a Pro-only
// feature. So the spreadsheet's "theme" is necessarily structural (title/summary
// banner rows, sized columns, a frozen + auto-filtered header) rather than
// coloured cells. The PDF carries the full colour treatment.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import * as XLSX from 'xlsx';

// ---------------------------------------------------------------------------
// Input + structured model
// ---------------------------------------------------------------------------

/**
 * The subset of an EmployeeRow this export reads. Kept loose (plain
 * `string | null` etc.) so the roster's `EmployeeRow` is structurally
 * assignable without a hard import.
 */
export interface MasterListExportInput {
  employee_id: string | null;
  name: string | null;
  department: string | null;
  work_email?: string | null;
  personal_email: string | null;
  phone_number?: string | null;
  location?: string | null;
  city?: string | null;
  province?: string | null;
  full_address?: string | null;
  start_date: string | null;
}

/** One employee, normalized to clean display strings. */
export interface MasterListRecord {
  employeeId: string;
  name: string;
  department: string;
  workEmail: string;
  personalEmail: string;
  phone: string;
  location: string;
  startDate: string; // formatted, or ''
  tenure: string;
}

export interface MasterListExportModel {
  generatedAt: Date;
  rows: MasterListRecord[];
  /** Total roster size (before the in-view filter) — shown in the summary band. */
  totalRoster: number;
  /** How many distinct departments are represented in the exported rows. */
  departmentCount: number;
  /** Describes the filter the rows were pulled from, e.g. "All departments" or
   *  "Engineering · matching \"kane\"" — shown in headings. */
  scopeLabel: string;
}

export interface BuildMasterListInput {
  rows: readonly MasterListExportInput[];
  totalRoster: number;
  scopeLabel?: string;
}

const DASH = '-';

function clean(v: string | null | undefined): string {
  return (v ?? '').toString().trim();
}

function join(parts: (string | null | undefined)[], sep = ', '): string {
  return parts.map(clean).filter(Boolean).join(sep);
}

/** "Jul 4, 2026" for an ISO date; '' when absent/unparseable. */
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

/** Compact tenure from a start date — mirrors the roster's on-screen tenure(). */
function tenureOf(iso: string | null): string {
  const s = clean(iso);
  if (!s) return DASH;
  const start = new Date(s);
  if (Number.isNaN(start.getTime())) return DASH;
  const now = new Date();
  let years = now.getFullYear() - start.getFullYear();
  let months = now.getMonth() - start.getMonth();
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (years > 0 && months > 0) return `${years}y ${months}m`;
  if (years > 0) return `${years}y`;
  if (months > 0) return `${months}mo`;
  const days = Math.floor((now.getTime() - start.getTime()) / 86_400_000);
  return days <= 0 ? 'New' : `${days}d`;
}

/** Best available location string for an employee. */
function locationOf(r: MasterListExportInput): string {
  return clean(r.location) || join([r.city, r.province]) || clean(r.full_address);
}

/** Shape the raw roster rows into a clean, per-employee export model. */
export function buildMasterListExport(input: BuildMasterListInput): MasterListExportModel {
  const rows: MasterListRecord[] = input.rows.map((r) => ({
    employeeId: clean(r.employee_id) || DASH,
    name: clean(r.name) || 'Unknown',
    department: clean(r.department) || DASH,
    workEmail: clean(r.work_email) || DASH,
    personalEmail: clean(r.personal_email) || DASH,
    phone: clean(r.phone_number) || DASH,
    location: locationOf(r) || DASH,
    startDate: formatDate(r.start_date),
    tenure: tenureOf(r.start_date),
  }));

  const depts = new Set<string>();
  for (const r of input.rows) {
    const d = clean(r.department);
    if (d) depts.add(d.toLowerCase());
  }

  return {
    generatedAt: new Date(),
    rows,
    totalRoster: input.totalRoster,
    departmentCount: depts.size,
    scopeLabel: input.scopeLabel?.trim() || 'All departments',
  };
}

// ---------------------------------------------------------------------------
// Shared: columns + timestamp
// ---------------------------------------------------------------------------

/** Column order shared by the CSV and XLSX flat tables. */
const COLUMNS: { header: string; get: (r: MasterListRecord) => string }[] = [
  { header: 'Employee ID', get: (r) => r.employeeId },
  { header: 'Name', get: (r) => r.name },
  { header: 'Department', get: (r) => r.department },
  { header: 'Work Email', get: (r) => r.workEmail },
  { header: 'Personal Email', get: (r) => r.personalEmail },
  { header: 'Phone', get: (r) => r.phone },
  { header: 'Location', get: (r) => r.location },
  { header: 'Start Date', get: (r) => r.startDate || DASH },
  { header: 'Tenure', get: (r) => r.tenure },
];

/** Full export timestamp, e.g. "July 13, 2026, 3:45 PM GMT+8" (viewer's local time). */
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
export function masterListToCsv(model: MasterListExportModel): string {
  const year = model.generatedAt.getFullYear();
  const preamble = [
    ['Global Master List'],
    [`Scope: ${model.scopeLabel}`],
    ['Pulled from Simple-HRIS System'],
    [`Exported: ${formatTimestamp(model.generatedAt)}`],
    [`${countLabel(model.rows.length)} of ${model.totalRoster.toLocaleString()} in roster · ${model.departmentCount} department${model.departmentCount === 1 ? '' : 's'}`],
    [`Developed by AI/API Team / Simple.biz (c) ${year}`],
    [''],
  ].map((row) => row.map(csvEscape).join(','));

  const header = ['#', ...COLUMNS.map((c) => c.header)].map(csvEscape).join(',');
  const body = model.rows.map((r, i) =>
    [i + 1, ...COLUMNS.map((c) => c.get(r))].map(csvEscape).join(','),
  );
  return '﻿' + [...preamble, header, ...body].join('\r\n');
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

const XLSX_COLUMN_WIDTHS = [14, 26, 20, 32, 32, 16, 26, 14, 10];

/** Build a native Excel workbook: a titled sheet with one row per employee. */
export function buildMasterListWorkbook(model: MasterListExportModel): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const aoa: (string | number)[][] = [
    ['Global Master List'],
    [`Scope: ${model.scopeLabel}`],
    [`Exported ${formatTimestamp(model.generatedAt)} · ${countLabel(model.rows.length)} of ${model.totalRoster.toLocaleString()} in roster · ${model.departmentCount} department${model.departmentCount === 1 ? '' : 's'}`],
    [],
    ['#', ...COLUMNS.map((c) => c.header)],
  ];
  model.rows.forEach((r, i) => {
    aoa.push([i + 1, ...COLUMNS.map((c) => c.get(r))]);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 5 }, ...XLSX_COLUMN_WIDTHS.map((wch) => ({ wch }))];
  // Turn on an autofilter across the header row so the sheet opens ready to
  // sort/filter. (Freeze panes aren't emitted by the pure-JS xlsx writer, so
  // there's no header freeze — that's a SheetJS-Pro-only feature.)
  const headerRow = 5; // 1-indexed row that holds the column headers
  const lastCol = COLUMNS.length; // 0=`#`, then one per column
  ws['!autofilter'] = { ref: `A${headerRow}:${XLSX.utils.encode_col(lastCol)}${headerRow + model.rows.length}` };
  // Merge the three banner rows across the full width so the title reads cleanly.
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: lastCol } },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Master List');
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
// rose-500 hero gradient, amber-500 headcount accent, warm cream surfaces.
type RGB = readonly [number, number, number];
const C_ORANGE: RGB = [0.918, 0.345, 0.047]; // #EA580C  orange-600
const C_ORANGE_500: RGB = [0.976, 0.451, 0.086]; // #F97316  orange-500
const C_ROSE: RGB = [0.957, 0.247, 0.369]; // #F43F5E  rose-500
const C_AMBER: RGB = [0.961, 0.62, 0.043]; // #F59E0B  amber-500
const tup = (c: RGB) => rgb(c[0], c[1], c[2]);

const ORANGE = tup(C_ORANGE);
const ROSE = tup(C_ROSE);
const AMBER = tup(C_AMBER);
const WHITE = rgb(1, 1, 1);
const INK = rgb(0.094, 0.094, 0.106); // zinc-900  #18181B
const MUTED = rgb(0.443, 0.443, 0.478); // zinc-500  #71717A
const ROW_ALT = rgb(1, 0.969, 0.929); // orange-50  #FFF7ED  (warm zebra)
const BORDER = rgb(0.914, 0.871, 0.812); // warm hairline

// pdf-lib's Helvetica is WinAnsi-encoded; characters outside it throw. Replace
// the few symbols that show up (peso, smart punctuation) with safe equivalents,
// and anything else unencodable with '?'.
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
    page.drawRectangle({
      x: x + i * sw,
      y,
      width: sw + 0.6, // tiny overlap so no seams show between slices
      height: h,
      color: rgb(r, g, b),
    });
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
export async function generateMasterListPdf(
  model: MasterListExportModel,
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
    state.page.drawText('HR - SIMPLE-HRIS DIRECTORY', { x: MARGIN, y: state.y, size: 8.5, font: bold, color: ORANGE });
    state.y -= 18;
    state.page.drawText('Global Master List', { x: MARGIN, y: state.y, size: 17, font: bold, color: INK });
    state.y -= 14;
    state.page.drawText(
      sanitize(`${model.scopeLabel} · ${countLabel(model.rows.length)} of ${model.totalRoster.toLocaleString()} in roster`),
      { x: MARGIN, y: state.y, size: 9, font, color: MUTED },
    );
    state.y -= 9;
    // Signature orange→rose accent rule (the dashboard's hero hairline).
    drawHGradient(state.page, MARGIN, state.y - 2.4, CONTENT_W, 2.4, C_ORANGE_500, C_ROSE);
    state.y -= 18;
  }

  // ── At-a-glance metric band (amber-topped stat cards, like the hero tiles) ──
  {
    const items: { label: string; value: string }[] = [
      { label: 'In this export', value: model.rows.length.toLocaleString() },
      { label: 'Total roster', value: model.totalRoster.toLocaleString() },
      { label: 'Departments', value: model.departmentCount.toLocaleString() },
    ];
    const gap = 12;
    const boxW = (CONTENT_W - gap * (items.length - 1)) / items.length;
    const boxH = 46;
    ensure(boxH + 10);
    state.y -= boxH;
    items.forEach((item, i) => {
      const x = MARGIN + i * (boxW + gap);
      state.page.drawRectangle({ x, y: state.y, width: boxW, height: boxH, color: ROW_ALT, borderColor: BORDER, borderWidth: 0.5 });
      // Amber top accent — the dashboard's headcount/gold highlight.
      state.page.drawRectangle({ x, y: state.y + boxH - 3, width: boxW, height: 3, color: AMBER });
      state.page.drawText(sanitize(item.label.toUpperCase()), { x: x + 10, y: state.y + boxH - 17, size: 7.5, font: bold, color: MUTED });
      state.page.drawText(sanitize(item.value), { x: x + 10, y: state.y + 10, size: 18, font: bold, color: ORANGE });
    });
    state.y -= 16;
  }

  // ── Roster table (orange header, warm zebra; paginates with redrawn header) ─
  const BODY = 8.5;
  const LH = 11;
  const PAD_X = 6;
  const PAD_Y = 5;

  const columns: Col[] = [
    { header: '#', width: 26, align: 'right' },
    { header: 'ID', width: 58 },
    { header: 'Name', width: 108 },
    { header: 'Department', width: 84 },
    { header: 'Work Email', width: 150 },
    { header: 'Start', width: 60 },
    { header: 'Tenure', width: CONTENT_W - 26 - 58 - 108 - 84 - 150 - 60 },
  ];
  const tableRows = model.rows.map((r, i) => [
    String(i + 1),
    r.employeeId,
    r.name,
    r.department,
    r.workEmail,
    r.startDate || DASH,
    r.tenure,
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
    state.page.drawText('No employees match this view.', { x: MARGIN, y: state.y - 10, size: 10, font, color: MUTED });
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

function baseName(model: MasterListExportModel): string {
  return `global-master-list-${dateSuffix(model.generatedAt)}`;
}

/** Build + download the CSV report. */
export function downloadMasterListCsv(model: MasterListExportModel): void {
  downloadBlob(
    `${baseName(model)}.csv`,
    new Blob([masterListToCsv(model)], { type: 'text/csv;charset=utf-8' }),
  );
}

/** Build + download the XLSX workbook. */
export function downloadMasterListXlsx(model: MasterListExportModel): void {
  const wb = buildMasterListWorkbook(model);
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  downloadBlob(
    `${baseName(model)}.xlsx`,
    new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  );
}

/** Build + download the CEO-themed PDF report. */
export async function downloadMasterListPdf(
  model: MasterListExportModel,
  opts?: { logoUrl?: string },
): Promise<void> {
  const bytes = await generateMasterListPdf(model, opts);
  // Copy into a fresh ArrayBuffer so the Blob gets a plain ArrayBuffer.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  downloadBlob(`${baseName(model)}.pdf`, new Blob([ab], { type: 'application/pdf' }));
}
