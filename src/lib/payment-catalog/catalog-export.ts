// Payment Catalog -- CSV + PDF export.
//
// Turns the three Payment Catalog data sets (pay structures, the bonus library,
// and bonus assignments) into a single "how much we pay each department" report,
// grouped per category (Pay Structure / Bonuses) per department.
//
//   - CSV  -> one flat, spreadsheet-friendly table (filter/pivot by Department +
//             Category) with a UTF-8 BOM so Excel renders symbols correctly.
//   - PDF  -> a branded, sectioned document built from scratch with pdf-lib so it
//             deploys cleanly on Vercel (no template file read at runtime). The
//             header carries the Simple logo + "Pulled from Simple-HRIS System",
//             and every page footer reads "Developed by AI/API Team / Simple.biz".
//
// Both run entirely in the browser (in-memory Blob download) -- the catalog data
// is already loaded in the Payment Catalog tab, so there's no server round-trip.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import type { PayStructure, PayCurrency } from './pay-structure';
import type { BonusDef, BonusAssignment } from '@/lib/bonus-catalog/types';

// ---------------------------------------------------------------------------
// Structured model
// ---------------------------------------------------------------------------

export interface PayRow {
  /** "Department default" or an employee's display name. */
  scope: string;
  employee: string;
  regularRate: number;
  otRate?: number;
  currency: PayCurrency;
}

export interface CommonBonusRow {
  name: string;
  kind: 'Flat' | 'Formula';
  detail: string; // flat amount (currency-prefixed) or the formula text
  currency: PayCurrency;
  appliesTo: string;
}

export interface EmployeeBonusRow {
  employee: string;
  name: string;
  kind: 'Flat' | 'Formula';
  detail: string;
  currency: PayCurrency;
}

export interface DeptBlock {
  key: string;
  name: string;
  deptPay?: PayRow; // the department-wide default rate, if set
  individualPay: PayRow[];
  commonBonuses: CommonBonusRow[];
  employeeBonuses: EmployeeBonusRow[];
}

export interface CatalogExportModel {
  generatedAt: Date;
  departments: DeptBlock[];
  /** Departments with no catalog entries at all (gaps worth flagging). */
  emptyDepartments: string[];
}

export interface BuildCatalogInput {
  payStructures: PayStructure[];
  bonuses: BonusDef[];
  assignments: BonusAssignment[];
  /** Canonical department list ({ key, name }) -- drives ordering + display names. */
  departments: { key: string; name: string }[];
  /** Optional name lookup (lower-cased email -> display name) for fallbacks. */
  resolveName?: (email: string) => string | undefined;
}

/** Two-decimal number with no currency (for table columns that have a Currency col). */
function n2(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return '-';
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Shape the raw catalog into a per-department, per-category report model. */
export function buildCatalogExport(input: BuildCatalogInput): CatalogExportModel {
  const { payStructures, bonuses, assignments, departments, resolveName } = input;

  const bonusById = new Map<string, BonusDef>();
  for (const b of bonuses) bonusById.set(b.id, b);

  const nameFor = (email?: string | null, fallbackName?: string | null): string => {
    const e = (email ?? '').trim().toLowerCase();
    return (fallbackName?.trim() || (e && resolveName?.(e)) || email || 'Unknown').toString();
  };

  const bonusDetail = (b: BonusDef): { kind: 'Flat' | 'Formula'; detail: string; currency: PayCurrency } => {
    const currency: PayCurrency = b.currency === 'USD' ? 'USD' : 'PHP';
    if (b.kind === 'flat') {
      const amt = Number.isFinite(b.amount) ? (b.amount as number) : 0;
      // Use the ASCII currency code as the prefix so it renders cleanly in both
      // the CSV and the PDF (the peso glyph isn't in pdf-lib's Helvetica).
      return { kind: 'Flat', detail: `${currency} ${n2(amt)}`, currency };
    }
    return { kind: 'Formula', detail: (b.formula ?? '').trim() || '(empty formula)', currency };
  };

  const blocks: DeptBlock[] = [];
  const empty: string[] = [];

  for (const dept of departments) {
    const deptPayStruct = payStructures.find(
      (s) => s.scope === 'department' && s.departmentKey === dept.key,
    );
    const individuals = payStructures
      .filter((s) => s.scope === 'employee' && s.departmentKey === dept.key)
      .sort((a, b) => nameFor(a.employeeEmail, a.employeeName).localeCompare(nameFor(b.employeeEmail, b.employeeName)));

    const common = assignments.filter((a) => a.scope === 'department' && a.departmentKey === dept.key);
    const perEmployee = assignments.filter((a) => a.scope === 'employee' && a.departmentKey === dept.key);

    const hasAnything =
      !!deptPayStruct || individuals.length > 0 || common.length > 0 || perEmployee.length > 0;
    if (!hasAnything) {
      empty.push(dept.name);
      continue;
    }

    const commonBonuses: CommonBonusRow[] = common
      .map((a) => {
        const b = bonusById.get(a.bonusId);
        if (!b) return null;
        const excl = a.excludedEmails?.length ?? 0;
        let appliesTo = excl > 0 ? `Dept. minus ${excl} excluded` : 'Whole department';
        if (a.sharedTeam) appliesTo += ` ${String.fromCharCode(0xb7)} shared inputs`;
        const { kind, detail, currency } = bonusDetail(b);
        return { name: b.name || 'Untitled', kind, detail, currency, appliesTo };
      })
      .filter((r): r is CommonBonusRow => r !== null)
      .sort((a, b) => a.name.localeCompare(b.name));

    const employeeBonuses: EmployeeBonusRow[] = perEmployee
      .map((a) => {
        const b = bonusById.get(a.bonusId);
        if (!b) return null;
        const { kind, detail, currency } = bonusDetail(b);
        return {
          employee: nameFor(a.employeeEmail, a.employeeName),
          name: b.name || 'Untitled',
          kind,
          detail,
          currency,
        };
      })
      .filter((r): r is EmployeeBonusRow => r !== null)
      .sort((a, b) => a.employee.localeCompare(b.employee) || a.name.localeCompare(b.name));

    blocks.push({
      key: dept.key,
      name: dept.name,
      deptPay: deptPayStruct
        ? {
            scope: 'Department default',
            employee: '',
            regularRate: deptPayStruct.regularRate,
            otRate: deptPayStruct.otRate,
            currency: deptPayStruct.currency,
          }
        : undefined,
      individualPay: individuals.map((s) => ({
        scope: 'Individual',
        employee: nameFor(s.employeeEmail, s.employeeName),
        regularRate: s.regularRate,
        otRate: s.otRate,
        currency: s.currency,
      })),
      commonBonuses,
      employeeBonuses,
    });
  }

  return { generatedAt: new Date(), departments: blocks, emptyDepartments: empty };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const CSV_COLUMNS = [
  'Department',
  'Category',
  'Scope',
  'Employee',
  'Item',
  'Regular Rate',
  'OT Rate',
  'Currency',
  'Bonus Type',
  'Amount / Formula',
  'Applies To / Notes',
] as const;

/** RFC 4180 escaping: wrap in quotes when the value has a comma/quote/newline. */
function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Serialize the model to a single flat CSV table (with a UTF-8 BOM). */
export function catalogToCsv(model: CatalogExportModel): string {
  const lines: string[][] = [];

  for (const d of model.departments) {
    if (d.deptPay) {
      lines.push([
        d.name, 'Pay Structure', 'Department default', '', 'Hourly rate',
        n2(d.deptPay.regularRate), n2(d.deptPay.otRate), d.deptPay.currency, '', '', '',
      ]);
    }
    for (const p of d.individualPay) {
      lines.push([
        d.name, 'Pay Structure', 'Individual', p.employee, 'Hourly rate',
        n2(p.regularRate), n2(p.otRate), p.currency, '', '', '',
      ]);
    }
    for (const b of d.commonBonuses) {
      lines.push([
        d.name, 'Bonus', 'Common (department)', '', b.name,
        '', '', b.currency, b.kind, b.detail, b.appliesTo,
      ]);
    }
    for (const b of d.employeeBonuses) {
      lines.push([
        d.name, 'Bonus', 'Employee', b.employee, b.name,
        '', '', b.currency, b.kind, b.detail, '',
      ]);
    }
  }

  const year = model.generatedAt.getFullYear();
  // A short metadata preamble so the provenance + export time are visible in the
  // file itself, then a blank line before the table proper.
  const preamble = [
    ['Payment Catalog - Department Pay Report'],
    ['Pulled from Simple-HRIS System'],
    [`Exported: ${formatTimestamp(model.generatedAt)}`],
    [`Developed by AI/API Team / Simple.biz (c) ${year}`],
    [''],
  ].map((row) => row.map(csvEscape).join(','));

  const header = CSV_COLUMNS.map(csvEscape).join(',');
  const body = lines.map((row) => row.map(csvEscape).join(','));
  return '﻿' + [...preamble, header, ...body].join('\r\n');
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const PAGE_W = 612; // US Letter, portrait
const PAGE_H = 792;
const MARGIN = 44;
const CONTENT_W = PAGE_W - MARGIN * 2; // 524
const BOTTOM = 56; // keep content clear of the footer

// Brand-ish palette pulled from the Simple logo (navy + orange).
const NAVY = rgb(0.13, 0.15, 0.33);
const ORANGE = rgb(0.95, 0.45, 0.12);
const WHITE = rgb(1, 1, 1);
const TEXT = rgb(0.12, 0.12, 0.15);
const MUTED = rgb(0.42, 0.42, 0.48);
const ROW_ALT = rgb(0.96, 0.96, 0.985);
const BORDER = rgb(0.86, 0.86, 0.9);

// pdf-lib's Helvetica is WinAnsi-encoded; characters outside it throw. Replace
// anything unencodable with '?' so a stray glyph can never crash generation.
function sanitize(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    out += (code >= 32 && code <= 126) || (code >= 160 && code <= 255) ? ch : '?';
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
      if (i <= 1 && word.length) break; // never loop forever on a too-wide single char
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

/** Full export timestamp, e.g. "June 16, 2026, 3:45 PM GMT+8" (viewer's local time). */
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

/** Build the branded PDF report. Returns the raw PDF bytes. */
export async function generateCatalogPdf(
  model: CatalogExportModel,
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

  // ── Masthead (page 1) ───────────────────────────────────────────────────
  {
    const top = state.y;
    if (logo) {
      const h = 30;
      const w = (logo.width / logo.height) * h;
      state.page.drawImage(logo, { x: MARGIN, y: top - h, width: w, height: h });
    } else {
      state.page.drawText('Simple', { x: MARGIN, y: top - 24, size: 24, font: bold, color: NAVY });
    }

    // Right-aligned provenance tagline.
    const right = (text: string, y: number, size: number, f: PDFFont, color = MUTED) => {
      const s = sanitize(text);
      const w = f.widthOfTextAtSize(s, size);
      state.page.drawText(s, { x: PAGE_W - MARGIN - w, y, size, font: f, color });
    };
    right('Pulled from Simple-HRIS System', top - 8, 9.5, bold, NAVY);
    right(`Exported ${formatTimestamp(model.generatedAt)}`, top - 21, 8.5, font);
    right(`${String.fromCharCode(0xa9)} ${year} Simple.biz`, top - 32, 8, font);

    state.y = top - 46;
    state.page.drawText('Payment Catalog - Department Pay Report', {
      x: MARGIN, y: state.y, size: 16, font: bold, color: NAVY,
    });
    state.y -= 15;
    state.page.drawText('How much we pay, broken down by category and department.', {
      x: MARGIN, y: state.y, size: 9, font, color: MUTED,
    });
    state.y -= 10;
    state.page.drawLine({
      start: { x: MARGIN, y: state.y }, end: { x: PAGE_W - MARGIN, y: state.y },
      thickness: 1.3, color: NAVY,
    });
    state.y -= 18;
  }

  // ── Table renderer (wraps every cell; paginates with a redrawn header) ────
  const BODY = 9;
  const LH = 11.5;
  const PAD_X = 6;
  const PAD_Y = 5;

  const drawTable = (columns: Col[], rows: string[][]) => {
    const headerH = LH + PAD_Y * 2;

    const drawHeader = () => {
      state.page.drawRectangle({ x: MARGIN, y: state.y - headerH, width: CONTENT_W, height: headerH, color: NAVY });
      let x = MARGIN;
      for (const c of columns) {
        const lines = wrapText(c.header, bold, BODY, c.width - PAD_X * 2);
        state.page.drawText(lines[0], { x: x + PAD_X, y: state.y - PAD_Y - BODY, size: BODY, font: bold, color: WHITE });
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

      if (alt) {
        state.page.drawRectangle({ x: MARGIN, y: state.y - rowH, width: CONTENT_W, height: rowH, color: ROW_ALT });
      }

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
      state.page.drawLine({
        start: { x: MARGIN, y: state.y - rowH }, end: { x: MARGIN + CONTENT_W, y: state.y - rowH },
        thickness: 0.5, color: BORDER,
      });
      state.y -= rowH;
      alt = !alt;
    }
    state.y -= 8;
  };

  const sectionLabel = (text: string) => {
    ensure(24);
    state.page.drawRectangle({ x: MARGIN, y: state.y - 9, width: 4, height: 10, color: ORANGE });
    state.page.drawText(sanitize(text), { x: MARGIN + 10, y: state.y - 8, size: 9.5, font: bold, color: NAVY });
    state.y -= 17;
  };

  // ── At-a-glance summary table ─────────────────────────────────────────────
  if (model.departments.length > 0) {
    sectionLabel('DEPARTMENT SUMMARY');
    const cols: Col[] = [
      { header: 'Department', width: 150 },
      { header: 'Default Regular', width: 82, align: 'right' },
      { header: 'Default OT', width: 78, align: 'right' },
      { header: 'Currency', width: 56 },
      { header: 'Overrides', width: 59, align: 'right' },
      { header: 'Bonuses', width: 99, align: 'right' },
    ];
    const rows = model.departments.map((d) => [
      d.name,
      d.deptPay ? n2(d.deptPay.regularRate) : '-',
      d.deptPay ? n2(d.deptPay.otRate) : '-',
      d.deptPay ? d.deptPay.currency : '-',
      String(d.individualPay.length),
      String(d.commonBonuses.length + d.employeeBonuses.length),
    ]);
    drawTable(cols, rows);
    state.y -= 4;
  }

  // ── Per-department detail ─────────────────────────────────────────────────
  const deptHeader = (d: DeptBlock) => {
    ensure(58); // don't orphan the header at the very bottom of a page
    const h = 22;
    state.page.drawRectangle({ x: MARGIN, y: state.y - h, width: CONTENT_W, height: h, color: NAVY });
    state.page.drawRectangle({ x: MARGIN, y: state.y - h, width: 5, height: h, color: ORANGE });
    state.page.drawText(sanitize(d.name), { x: MARGIN + 14, y: state.y - 15, size: 12.5, font: bold, color: WHITE });
    state.y -= h + 6;
  };

  for (const d of model.departments) {
    deptHeader(d);

    // Category 1: Pay Structure
    sectionLabel('PAY STRUCTURE  (hourly rates)');
    const payRows: string[][] = [];
    if (d.deptPay) {
      payRows.push(['Department default', '-', n2(d.deptPay.regularRate), n2(d.deptPay.otRate), d.deptPay.currency]);
    }
    for (const p of d.individualPay) {
      payRows.push(['Individual', p.employee, n2(p.regularRate), n2(p.otRate), p.currency]);
    }
    if (payRows.length > 0) {
      drawTable(
        [
          { header: 'Scope', width: 128 },
          { header: 'Employee', width: 168 },
          { header: 'Regular', width: 78, align: 'right' },
          { header: 'OT', width: 74, align: 'right' },
          { header: 'Currency', width: 76 },
        ],
        payRows,
      );
    } else {
      ensure(16);
      state.page.drawText('No pay structure set for this department.', { x: MARGIN + 10, y: state.y - 9, size: 9, font, color: MUTED });
      state.y -= 18;
    }

    // Category 2: Bonuses
    sectionLabel('BONUSES');
    if (d.commonBonuses.length === 0 && d.employeeBonuses.length === 0) {
      ensure(16);
      state.page.drawText('No bonuses assigned to this department.', { x: MARGIN + 10, y: state.y - 9, size: 9, font, color: MUTED });
      state.y -= 18;
    }
    if (d.commonBonuses.length > 0) {
      ensure(16);
      state.page.drawText('Common (whole department)', { x: MARGIN + 10, y: state.y - 9, size: 8.5, font: bold, color: MUTED });
      state.y -= 15;
      drawTable(
        [
          { header: 'Bonus', width: 150 },
          { header: 'Type', width: 56 },
          { header: 'Amount / Formula', width: 200 },
          { header: 'Applies to', width: 118 },
        ],
        d.commonBonuses.map((b) => [b.name, b.kind, b.detail, b.appliesTo]),
      );
    }
    if (d.employeeBonuses.length > 0) {
      ensure(16);
      state.page.drawText('Employee-specific', { x: MARGIN + 10, y: state.y - 9, size: 8.5, font: bold, color: MUTED });
      state.y -= 15;
      drawTable(
        [
          { header: 'Employee', width: 144 },
          { header: 'Bonus', width: 142 },
          { header: 'Type', width: 54 },
          { header: 'Amount / Formula', width: 184 },
        ],
        d.employeeBonuses.map((b) => [b.employee, b.name, b.kind, b.detail]),
      );
    }
    state.y -= 8;
  }

  if (model.departments.length === 0) {
    ensure(20);
    state.page.drawText('No pay structures or bonuses have been configured yet.', { x: MARGIN, y: state.y - 10, size: 10, font, color: MUTED });
    state.y -= 22;
  }

  if (model.emptyDepartments.length > 0) {
    ensure(28);
    state.page.drawText('Departments with no catalog entries:', { x: MARGIN, y: state.y - 10, size: 8.5, font: bold, color: MUTED });
    state.y -= 13;
    for (const ln of wrapText(model.emptyDepartments.join(', '), font, 8.5, CONTENT_W)) {
      ensure(12);
      state.page.drawText(ln, { x: MARGIN, y: state.y - 10, size: 8.5, font, color: MUTED });
      state.y -= 11;
    }
  }

  // ── Footers on every page ─────────────────────────────────────────────────
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

/** Build + download the CSV report. */
export function downloadCatalogCsv(model: CatalogExportModel): void {
  const csv = catalogToCsv(model);
  downloadBlob(
    `payment-catalog-by-department-${dateSuffix(model.generatedAt)}.csv`,
    new Blob([csv], { type: 'text/csv;charset=utf-8' }),
  );
}

/** Build + download the branded PDF report. */
export async function downloadCatalogPdf(model: CatalogExportModel, opts?: { logoUrl?: string }): Promise<void> {
  const bytes = await generateCatalogPdf(model, opts);
  // Copy into a fresh ArrayBuffer so the Blob gets a plain ArrayBuffer (not a
  // possibly-shared view) -- keeps TS + every browser happy.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  downloadBlob(
    `payment-catalog-by-department-${dateSuffix(model.generatedAt)}.pdf`,
    new Blob([ab], { type: 'application/pdf' }),
  );
}
