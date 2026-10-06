/**
 * HRIS vs NPD → **Export CSV**: the Validation step's output as a file.
 *
 * Kane, 2026-10-06: "Payroll Wizard - Validation - Payroll Wizard vs HRIS - add an export CSV
 * please". Rules: docs/features/payroll-wizard-hris-vs-npd.md § Export CSV.
 *
 * ── What this file promises ────────────────────────────────────────────────
 * **Every row of the output, whatever the screen is narrowed to.** The search and the chips are
 * display only (§ The search and the chips never narrow the totals), and the wizard's money
 * exports ignore the search permanently (Reports, 2026-09-09): a filtered file cannot be told
 * apart from a short week once it is in someone's Downloads folder. So the rows are
 * `comparison.rows`, every compared row, and no filter is ever an input here.
 *
 * **People configured not to be paid this week are not in it** (Kane, 2026-10-06: "they should
 * not reach the validation step … because they are not getting paid for that week"), exactly
 * as they are not rows on screen. The notes and the counts block say how many were left out,
 * why, and how many of them NPD lists (`summarizeHrisNpdLeftOut`, the screen's own count).
 *
 * **Nothing the comparison did not decide.** Verdicts, differences, counts and totals are
 * `compareHrisNpd`'s, copied, never recomputed. The TOTAL row is a row, not a SUM(): a formula
 * would recompute from whatever the reader has since edited and stop matching the screen.
 *
 * **No file while the verdicts are held** (loading, a failed source, FX 0, nothing read). A file
 * travels and the hold banner does not, so an unjudged output never becomes one — the same rule
 * as Save output (`heldSaveReason` is the shared wording).
 *
 * **A refused NPD line is never hidden** (§ Two steps): the skipped lines are listed under the
 * totals, with their reason and text.
 *
 * Deliberately pure: comparison in, CSV text out. No fetch, no DOM, no Supabase.
 */

import {
  hrisNpdLeftOutWhy,
  summarizeHrisNpdLeftOut,
  type HrisNpdComparison,
  type HrisNpdRow,
  type HrisNpdStatus,
  type NpdPasteParse,
} from './hris-npd-compare';
import { heldSaveReason } from './hris-npd-snapshot';
import { NPD_SHEETS, NPD_SHEET_LABELS, type NpdSheetKind } from '@/lib/npd/columns';

/** Where the NPD side came from: NPD's locked sheets (2026-10-02), or a paste on step 1. */
export type HrisNpdExportSource =
  | {
      kind: 'locked_sheets';
      /** NPD's pay-week Sunday. */
      week: string;
      versions: Readonly<Record<NpdSheetKind, number>>;
      /** NPD rows that also fill Total Pay US Workers, which is never compared. */
      usWorkersRows: number;
    }
  | { kind: 'paste' };

const STATUS_LABEL: Record<HrisNpdStatus, string> = {
  match: 'Match',
  mismatch: 'Mismatch',
  not_in_hris: 'Not in HRIS',
  not_in_npd: 'Not in NPD',
};

/**
 * Neutralize spreadsheet formula injection for FREE-TEXT cells. A name, an NPD address as
 * pasted, or a refused line's raw text starting with `=`, `+`, `-` or `@` runs as a formula
 * when the CSV is opened in Excel. A leading `'` renders it inert.
 *
 * Text only. Money cells are built here from integer cents and must NOT pass through this: a
 * negative difference legitimately starts with `-`. Same split as `cycle-processor-export.ts`.
 */
function neutralize(v: string | null | undefined): string {
  const s = (v ?? '').toString();
  if (/^[=+\-@]/.test(s.trim()) && s.trim().length > 0) return `'${s}`;
  return s;
}

/** RFC 4180 quoting over an already-neutralized value. */
function csvEscape(v: string): string {
  if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

function textCell(v: string | null | undefined): string {
  return csvEscape(neutralize(v));
}

/**
 * Whole cents → `1234.05` / `-2.68`, ungrouped so a spreadsheet reads a number. Built from the
 * integer, never through `cents / 100`: the comparison's cents ARE the figure.
 */
export function centsCell(cents: number | null | undefined): string {
  if (cents == null || !Number.isSafeInteger(cents)) return '';
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Pesos (the pivot behind HRIS's dollars) at 2dp. */
function pesoCell(php: number | null | undefined): string {
  return php != null && Number.isFinite(php) ? php.toFixed(2) : '';
}

function intCell(n: number): string {
  return Number.isFinite(n) ? String(Math.trunc(n)) : '';
}

/** `2026-10-06T14-32-05`: filename-safe, sorts correctly. */
function exportTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

/**
 * `hris-vs-npd_2026-09-20_to_2026-09-26_2026-10-06T14-32-05.csv`. The week is IN the name, so
 * two weeks' files are never confusable once downloaded. A week key with no date range falls
 * back to the key itself, slugged.
 */
export function hrisNpdExportFilename(periodLabel: string | null, now: Date): string {
  const range = /(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})/.exec(periodLabel ?? '');
  const week = range
    ? `${range[1]}_to_${range[2]}`
    : (periodLabel ?? '')
        .replace(/\.csv$/i, '')
        .replace(/[^a-zA-Z0-9_.-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'no-week';
  return `hris-vs-npd_${week}_${exportTimestamp(now)}.csv`;
}

/** Why the output can't be exported right now, or null. Also the button's title. */
export function hrisNpdExportBlockedReason(comparison: HrisNpdComparison): string | null {
  if (comparison.hold) return heldSaveReason(comparison.hold);
  if (comparison.counts == null) return 'Rows are not marked yet.';
  if (comparison.rows.length === 0) return 'There is no output to export.';
  return null;
}

export const HRIS_NPD_EXPORT_HEADER = [
  'Work Email',
  'Name',
  'Match',
  'HRIS USD',
  'NPD USD',
  'Difference USD (NPD - HRIS)',
  'HRIS PHP (final pay)',
  'HRIS rows added',
  'NPD lines added',
  'Notes',
] as const;

function comparedNotes(r: HrisNpdRow, fxRate: number): string {
  const notes: string[] = [];
  if (r.noPayoutRowCount > 0) notes.push('No payout this week (no payout address on file; HRIS figure is Gross)');
  if (r.excludedRowCount > 0) {
    notes.push(`${r.excludedRowCount} excluded row${r.excludedRowCount === 1 ? '' : 's'} not counted`);
  }
  if (r.status === 'match' && r.deltaCents) notes.push('Within the off-by setting, so counted as a match');
  if (r.status === 'mismatch' && r.impliedNpdRate != null) {
    notes.push(`NPD's figure implies PHP ${r.impliedNpdRate.toFixed(2)} per $1 (this cycle: PHP ${fxRate.toFixed(2)})`);
  }
  return notes.join('; ');
}

function comparedRow(r: HrisNpdRow, fxRate: number): string {
  return [
    textCell(r.workEmail),
    textCell(r.name),
    // Held rows never reach here: the builder refuses while held.
    textCell(r.status ? STATUS_LABEL[r.status] : ''),
    centsCell(r.hrisCents),
    centsCell(r.npdCents),
    centsCell(r.deltaCents),
    pesoCell(r.hrisPhp),
    intCell(r.hrisRowCount),
    intCell(r.npdLines.length),
    textCell(comparedNotes(r, fxRate)),
  ].join(',');
}

function sourceLine(source: HrisNpdExportSource, parse: NpdPasteParse): string {
  if (source.kind === 'paste') {
    return `NPD figures: pasted on step 1 (NPD Figures), ${parse.rows.length} line${parse.rows.length === 1 ? '' : 's'} read`;
  }
  const versions = NPD_SHEETS.map((s) => `${NPD_SHEET_LABELS[s]} v${source.versions[s]}`).join(', ');
  return `NPD figures: NPD's locked sheets for week ${source.week} (${versions}), PHP USD Conversion column, ${parse.rows.length} row${parse.rows.length === 1 ? '' : 's'} read`;
}

/**
 * Build the file, or say why not. `comparison` and `parse` are the SAME objects the table
 * renders (`hrisNpdPanelProps`), so the file cannot drift from the view.
 */
export function buildHrisNpdCsv(input: {
  comparison: HrisNpdComparison;
  parse: NpdPasteParse;
  /** This cycle's USD→PHP rate — the divisor behind every HRIS dollar figure. */
  fxRate: number;
  /** The wizard's week key (the Hubstaff filename). */
  periodLabel: string | null;
  source: HrisNpdExportSource;
  now: Date;
}): { ok: true; csv: string } | { ok: false; reason: string } {
  const { comparison, parse, fxRate, periodLabel, source, now } = input;
  const blocked = hrisNpdExportBlockedReason(comparison);
  if (blocked) return { ok: false, reason: blocked };
  const counts = comparison.counts!;
  const { totals, toleranceCents } = comparison;
  const left = summarizeHrisNpdLeftOut(comparison.leftOut);

  const notes: string[] = [
    'HRIS vs NPD - Payroll Wizard > Validation',
    `Week: ${periodLabel ?? 'unknown'}`,
    `Exported: ${now.toISOString()}`,
    sourceLine(source, parse),
    `HRIS figure: what Payment Dispatch will be sent - final pay / PHP ${fxRate.toFixed(2)} per $1 (this cycle's USD->PHP rate), rounded to the cent as staged.`,
    `Match: HRIS and NPD off by at most ${toleranceCents} cent${toleranceCents === 1 ? '' : 's'} (the output's "off by" setting). A match inside that still shows its Difference.`,
    'Difference = NPD - HRIS.',
    'Every row of the output is here. The search and the chips on screen do not narrow this file.',
    left.total > 0
      ? `Left out, not paid this week: ${left.total} (${hrisNpdLeftOutWhy(left)}).${left.inNpd > 0 ? ` NPD lists ${left.inNpd} of them.` : ''} They are not in this file, not compared and not in the counts or totals.`
      : 'Nobody is configured not to be paid this week.',
  ];
  if (source.kind === 'locked_sheets' && source.usWorkersRows > 0) {
    notes.push(
      `NOTE: ${source.usWorkersRows} NPD row${source.usWorkersRows === 1 ? '' : 's'} also fill Total Pay US Workers. That column is not compared.`,
    );
  }
  if (parse.refusals.length > 0) {
    notes.push(
      `NOTE: ${parse.refusals.length} NPD line${parse.refusals.length === 1 ? ' was' : 's were'} skipped and not compared. They are listed at the bottom of this file.`,
    );
  }

  const lines: string[] = [
    ...notes.map(textCell),
    '',
    HRIS_NPD_EXPORT_HEADER.join(','),
    ...comparison.rows.map((r) => comparedRow(r, fxRate)),
    [
      textCell(`TOTAL - ${totals.people} ${totals.people === 1 ? 'person' : 'people'}`),
      '',
      '',
      centsCell(totals.hrisCents),
      centsCell(totals.npdCents),
      totals.hrisCents == null ? '' : centsCell(totals.npdCents - totals.hrisCents),
      '',
      '',
      '',
      '',
    ].join(','),
    '',
    'Match,' + intCell(counts.match),
    'Mismatch,' + intCell(counts.mismatch),
    'Not in HRIS,' + intCell(counts.not_in_hris),
    'Not in NPD,' + intCell(counts.not_in_npd),
    'Left out - not paid this week,' + intCell(left.total),
  ];

  if (parse.refusals.length > 0) {
    lines.push(
      '',
      textCell(`Skipped NPD lines (${parse.refusals.length}) - not read, so not compared`),
      'Line,Reason,Text',
      ...parse.refusals.map((f) => [intCell(f.line), textCell(f.reason), textCell(f.raw)].join(',')),
    );
  }

  // CRLF per RFC 4180, matching cycle-processor-export.ts.
  return { ok: true, csv: lines.join('\r\n') + '\r\n' };
}
