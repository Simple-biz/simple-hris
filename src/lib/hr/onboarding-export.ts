// HR Onboarding (Submitted new hires) -> CSV + XLSX + PDF export.
//
// Turns the onboarding submissions currently in view (typically the "Submitted"
// tab) into a portable new-hire record in three formats:
//
//   - CSV   -> one flat, spreadsheet-friendly table (UTF-8 BOM so Excel renders
//              symbols correctly), with a short provenance preamble.
//   - XLSX  -> a native Excel workbook (title + header + one row per hire, sized
//              columns) built with the `xlsx` package.
//   - PDF   -> a branded, sectioned document built from scratch with pdf-lib so
//              it deploys cleanly on Vercel (no template file read at runtime).
//              A summary table up top, then a per-hire detail block below.
//
// All three run entirely in the browser (in-memory Blob download) -- the rows
// are already loaded in the Onboarding tab, so there's no server round-trip.
//
// The visual theme (navy + orange brand palette, provenance masthead + footer)
// deliberately mirrors the Payment Catalog / Accounting export
// (src/lib/payment-catalog/catalog-export.ts) so the two exports feel like one
// system.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import * as XLSX from 'xlsx';

import { payoutBrandLabel } from '../onboarding/payout-brand';

// ---------------------------------------------------------------------------
// Input + structured model
// ---------------------------------------------------------------------------

/**
 * The subset of an onboarding-submission row this export reads. Kept loose
 * (plain `string | null` etc.) so the HR tab's local `SubmissionRow` type is
 * structurally assignable without importing it.
 */
export interface OnboardingExportInput {
  status: string;
  submitted_at: string | null;
  created_at: string;
  invite_name: string | null;
  invite_personal_email: string | null;
  invite_department: string | null;
  invite_country: string | null;
  full_name: string | null;
  display_name: string | null;
  phone: string | null;
  email: string | null;
  location: string | null;
  country: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_province: string | null;
  address_region: string | null;
  address_postal_code: string | null;
  ip_agreement_agreed: boolean | null;
  ip_agreement_signature: string | null;
  non_solicitation_signature: string | null;
  privacy_signature: string | null;
  contract_signature: string | null;
  w8ben_applicable: boolean | null;
  w8ben_file_name: string | null;
  payment_method: string | null;
  hurupay_email: string | null;
  /** Brand stamp; null on pre-2026-08-24 paperwork. See lib/onboarding/payout-brand.ts. */
  payout_brand?: string | null;
  bank_full_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_swift_code: string | null;
  bank_street: string | null;
  bank_city: string | null;
  bank_province: string | null;
  bank_postal_code: string | null;
  bank_full_address: string | null;
  work_email: string | null;
}

/** One new hire, normalized to clean display strings. */
export interface HireRecord {
  name: string;
  department: string;
  country: string;
  personalEmail: string;
  workEmail: string;
  phone: string;
  location: string;
  homeAddress: string;
  status: string;
  submitted: string; // date only, or ''
  paymentMethod: string;
  paymentSummary: string; // single-line, for table/CSV/XLSX
  paymentLines: string[]; // multi-line, for the PDF detail block
  w8ben: string;
  agreements: string;
}

export interface OnboardingExportModel {
  generatedAt: Date;
  hires: HireRecord[];
  /** The filter the rows were pulled from, e.g. "Submitted" — shown in headings. */
  scopeLabel: string;
}

export interface BuildOnboardingInput {
  rows: readonly OnboardingExportInput[];
  scopeLabel?: string;
}

const DASH = '-';

function clean(v: string | null | undefined): string {
  return (v ?? '').toString().trim();
}

/** Join non-empty parts with a separator (drops blanks). */
function join(parts: (string | null | undefined)[], sep = ', '): string {
  return parts.map(clean).filter(Boolean).join(sep);
}

function titleCaseWord(w: string): string {
  return w ? w[0].toUpperCase() + w.slice(1) : w;
}

/** Home address from the structured personal-address fields. */
function homeAddress(r: OnboardingExportInput): string {
  const region = clean(r.address_state) || clean(r.address_province) || clean(r.address_region);
  return join([r.address_street, r.address_city, region, r.address_postal_code], ', ');
}

/** Which agreements the hire has signed / agreed to. */
function agreements(r: OnboardingExportInput): string {
  const signed: string[] = [];
  if (r.ip_agreement_agreed || clean(r.ip_agreement_signature)) signed.push('IP Assignment');
  if (clean(r.non_solicitation_signature)) signed.push('Non-Solicitation');
  if (clean(r.privacy_signature)) signed.push('Privacy');
  if (clean(r.contract_signature)) signed.push('Contract');
  return signed.length ? signed.join(', ') : DASH;
}

/** Payment method + its details as a single line and as multiple lines. */
function payment(r: OnboardingExportInput): { method: string; summary: string; lines: string[] } {
  const method = clean(r.payment_method);
  if (method === 'hurupay') {
    const email = clean(r.hurupay_email) || DASH;
    // The packet is a copy of what the hire signed, so it prints the brand THEY
    // saw — "Hurupay" for anyone onboarded before 2026-08-24.
    const brand = payoutBrandLabel(r.payout_brand);
    return { method: brand, summary: `${brand} ${email}`, lines: [`${brand}: ${email}`] };
  }
  if (method === 'wires') {
    const address = clean(r.bank_full_address) || join([r.bank_street, r.bank_city, r.bank_province, r.bank_postal_code]);
    const lines = [
      clean(r.bank_full_name) && `Bank: ${clean(r.bank_full_name)}`,
      clean(r.bank_account_name) && `Account name: ${clean(r.bank_account_name)}`,
      clean(r.bank_account_number) && `Account no: ${clean(r.bank_account_number)}`,
      clean(r.bank_swift_code) && `SWIFT: ${clean(r.bank_swift_code)}`,
      address && `Bank address: ${address}`,
    ].filter((s): s is string => Boolean(s));
    const summary = join(
      [clean(r.bank_full_name), clean(r.bank_account_name), clean(r.bank_account_number) && `#${clean(r.bank_account_number)}`, clean(r.bank_swift_code)],
      ' · ',
    );
    return { method: 'Bank wire', summary: summary || DASH, lines: lines.length ? lines : [DASH] };
  }
  return { method: method ? titleCaseWord(method) : DASH, summary: DASH, lines: [DASH] };
}

/** "Jul 4, 2026" for an ISO timestamp; '' when absent/unparseable. */
function formatDate(iso: string | null): string {
  const s = clean(iso);
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return s;
  }
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting submission',
  submitted: 'Submitted',
  archived: 'Archived',
};

/** Shape the raw submission rows into a clean, per-hire export model. */
export function buildOnboardingExport(input: BuildOnboardingInput): OnboardingExportModel {
  const hires: HireRecord[] = input.rows.map((r) => {
    const pay = payment(r);
    return {
      name: clean(r.display_name) || clean(r.full_name) || clean(r.invite_name) || 'Unknown',
      department: clean(r.invite_department) || DASH,
      country: clean(r.country) || clean(r.invite_country) || DASH,
      personalEmail: clean(r.invite_personal_email) || clean(r.email) || DASH,
      workEmail: clean(r.work_email) || DASH,
      phone: clean(r.phone) || DASH,
      location: clean(r.location) || DASH,
      homeAddress: homeAddress(r) || DASH,
      status: STATUS_LABEL[clean(r.status)] ?? (clean(r.status) || DASH),
      submitted: formatDate(r.submitted_at) || formatDate(r.created_at),
      paymentMethod: pay.method,
      paymentSummary: pay.summary,
      paymentLines: pay.lines,
      w8ben: r.w8ben_applicable
        ? `Applicable${clean(r.w8ben_file_name) ? ` (${clean(r.w8ben_file_name)})` : ''}`
        : 'Not applicable',
      agreements: agreements(r),
    };
  });

  return { generatedAt: new Date(), hires, scopeLabel: input.scopeLabel?.trim() || 'New hires' };
}

// ---------------------------------------------------------------------------
// Shared: columns + timestamp
// ---------------------------------------------------------------------------

/** Column order shared by the CSV and XLSX flat tables. */
const COLUMNS: { header: string; get: (h: HireRecord) => string }[] = [
  { header: 'Name', get: (h) => h.name },
  { header: 'Department', get: (h) => h.department },
  { header: 'Country', get: (h) => h.country },
  { header: 'Personal Email', get: (h) => h.personalEmail },
  { header: 'Work Email', get: (h) => h.workEmail },
  { header: 'Phone', get: (h) => h.phone },
  { header: 'Location', get: (h) => h.location },
  { header: 'Home Address', get: (h) => h.homeAddress },
  { header: 'Status', get: (h) => h.status },
  { header: 'Submitted', get: (h) => h.submitted || DASH },
  { header: 'Payment Method', get: (h) => h.paymentMethod },
  { header: 'Payment Details', get: (h) => h.paymentSummary },
  { header: 'W-8BEN', get: (h) => h.w8ben },
  { header: 'Agreements Signed', get: (h) => h.agreements },
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
export function onboardingToCsv(model: OnboardingExportModel): string {
  const year = model.generatedAt.getFullYear();
  const preamble = [
    [`New Hire Onboarding - ${model.scopeLabel}`],
    ['Pulled from Simple-HRIS System'],
    [`Exported: ${formatTimestamp(model.generatedAt)}`],
    [`${model.hires.length} hire${model.hires.length === 1 ? '' : 's'}`],
    [`Developed by AI/API Team / Simple.biz (c) ${year}`],
    [''],
  ].map((row) => row.map(csvEscape).join(','));

  const header = COLUMNS.map((c) => csvEscape(c.header)).join(',');
  const body = model.hires.map((h) => COLUMNS.map((c) => csvEscape(c.get(h))).join(','));
  return '﻿' + [...preamble, header, ...body].join('\r\n');
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

const XLSX_COLUMN_WIDTHS = [24, 18, 16, 30, 30, 16, 18, 40, 20, 14, 16, 40, 24, 28];

/** Build a native Excel workbook: a titled sheet with one row per hire. */
export function buildOnboardingWorkbook(model: OnboardingExportModel): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const aoa: (string | number)[][] = [
    [`New Hire Onboarding — ${model.scopeLabel}`],
    [`Exported ${formatTimestamp(model.generatedAt)} · ${model.hires.length} hire${model.hires.length === 1 ? '' : 's'}`],
    [],
    ['#', ...COLUMNS.map((c) => c.header)],
  ];
  model.hires.forEach((h, i) => {
    aoa.push([i + 1, ...COLUMNS.map((c) => c.get(h))]);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 4 }, ...XLSX_COLUMN_WIDTHS.map((wch) => ({ wch }))];
  XLSX.utils.book_append_sheet(wb, ws, 'New Hires');
  return wb;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const PAGE_W = 612; // US Letter, portrait
const PAGE_H = 792;
const MARGIN = 44;
const CONTENT_W = PAGE_W - MARGIN * 2; // 524
const BOTTOM = 56; // keep content clear of the footer

// Brand-ish palette pulled from the Simple logo (navy + orange) — matches the
// Payment Catalog export so the two documents look like one family.
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

/** Build the branded PDF report. Returns the raw PDF bytes. */
export async function generateOnboardingPdf(
  model: OnboardingExportModel,
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

    const right = (text: string, y: number, size: number, f: PDFFont, color = MUTED) => {
      const s = sanitize(text);
      const w = f.widthOfTextAtSize(s, size);
      state.page.drawText(s, { x: PAGE_W - MARGIN - w, y, size, font: f, color });
    };
    right('Pulled from Simple-HRIS System', top - 8, 9.5, bold, NAVY);
    right(`Exported ${formatTimestamp(model.generatedAt)}`, top - 21, 8.5, font);
    right(`${String.fromCharCode(0xa9)} ${year} Simple.biz`, top - 32, 8, font);

    state.y = top - 46;
    state.page.drawText(`New Hire Onboarding - ${model.scopeLabel}`, {
      x: MARGIN, y: state.y, size: 16, font: bold, color: NAVY,
    });
    state.y -= 15;
    const subtitle = `${model.hires.length} hire${model.hires.length === 1 ? '' : 's'} - personal info, agreements, payment & tax.`;
    state.page.drawText(subtitle, { x: MARGIN, y: state.y, size: 9, font, color: MUTED });
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

  if (model.hires.length === 0) {
    ensure(20);
    state.page.drawText('No hires to export for this view.', { x: MARGIN, y: state.y - 10, size: 10, font, color: MUTED });
    state.y -= 22;
  }

  // ── At-a-glance summary table ─────────────────────────────────────────────
  if (model.hires.length > 0) {
    sectionLabel('SUMMARY');
    const cols: Col[] = [
      { header: 'Name', width: 128 },
      { header: 'Department', width: 92 },
      { header: 'Country', width: 74 },
      { header: 'Work Email', width: 150 },
      { header: 'Submitted', width: 80 },
    ];
    const rows = model.hires.map((h) => [h.name, h.department, h.country, h.workEmail, h.submitted || DASH]);
    drawTable(cols, rows);
    state.y -= 4;
  }

  // ── Per-hire detail ───────────────────────────────────────────────────────
  const hireHeader = (name: string) => {
    ensure(58); // don't orphan the header at the very bottom of a page
    const h = 22;
    state.page.drawRectangle({ x: MARGIN, y: state.y - h, width: CONTENT_W, height: h, color: NAVY });
    state.page.drawRectangle({ x: MARGIN, y: state.y - h, width: 5, height: h, color: ORANGE });
    state.page.drawText(sanitize(name), { x: MARGIN + 14, y: state.y - 15, size: 12.5, font: bold, color: WHITE });
    state.y -= h + 6;
  };

  for (const h of model.hires) {
    hireHeader(h.name);
    const kv: string[][] = [
      ['Department', h.department],
      ['Country', h.country],
      ['Personal Email', h.personalEmail],
      ['Work Email', h.workEmail],
      ['Phone', h.phone],
      ['Location', h.location],
      ['Home Address', h.homeAddress],
      ['Status', h.status],
      ['Submitted', h.submitted || DASH],
      ['Payment Method', h.paymentMethod],
      ['Payment Details', h.paymentLines.join('\n')],
      ['W-8BEN', h.w8ben],
      ['Agreements Signed', h.agreements],
    ];
    // Payment details can be multi-line; flatten newlines to " · " for the cell.
    const rows = kv.map(([k, v]) => [k, (v || DASH).replace(/\n/g, ' · ')]);
    drawTable(
      [
        { header: 'Field', width: 140 },
        { header: 'Value', width: CONTENT_W - 140 },
      ],
      rows,
    );
    state.y -= 8;
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

function baseName(model: OnboardingExportModel): string {
  return `new-hire-onboarding-${dateSuffix(model.generatedAt)}`;
}

/** Build + download the CSV report. */
export function downloadOnboardingCsv(model: OnboardingExportModel): void {
  downloadBlob(
    `${baseName(model)}.csv`,
    new Blob([onboardingToCsv(model)], { type: 'text/csv;charset=utf-8' }),
  );
}

/** Build + download the XLSX workbook. */
export function downloadOnboardingXlsx(model: OnboardingExportModel): void {
  const wb = buildOnboardingWorkbook(model);
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  downloadBlob(
    `${baseName(model)}.xlsx`,
    new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  );
}

/** Build + download the branded PDF report. */
export async function downloadOnboardingPdf(model: OnboardingExportModel, opts?: { logoUrl?: string }): Promise<void> {
  const bytes = await generateOnboardingPdf(model, opts);
  // Copy into a fresh ArrayBuffer so the Blob gets a plain ArrayBuffer (not a
  // possibly-shared view) -- keeps TS + every browser happy.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  downloadBlob(`${baseName(model)}.pdf`, new Blob([ab], { type: 'application/pdf' }));
}
