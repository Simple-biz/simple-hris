/**
 * Send to OMS — what the HRIS returns to the Orphanage Management System for a week.
 *
 * Pure. The route reads the two carriers and the dispatch lock, this module turns them
 * into rows, and the writer inserts them into OMS's own table in one call.
 *
 * Rules (docs/features/orphanage-oms-pull.md § Sending to OMS):
 *   - The AMOUNT is the additions blob's `orphanageAmounts` — the value that PAYS — never
 *     the `orphanage_pay` record's `amount_php`. The record only supplies the hours, the
 *     regular/OT split and the rates (orphanage-pay-step.md § Two carriers).
 *   - A hand-typed amount has no record: it is sent with hours BLANK and the verdict
 *     `unverifiable`, never dropped and never given invented hours.
 *   - A record with no amount on the column pays ₱0 today (the step's red panel). It is
 *     NOT sent; it is counted so the modal can say so.
 *   - A corrupt blob amount REFUSES the whole build. A send is an accounting report; a
 *     partial one that silently omits a person is worse than none.
 *   - Aliases relabel `work_email` to the address OMS itself sent us. They never add a
 *     row and never touch money.
 */

import { parseDateRangeFromFilename } from '@/lib/hubstaff/calendar-column-dedupe';
import {
  reconcileLockedOrphanageAmount,
  type OrphanageReconcileStatus,
} from '@/lib/payroll/orphanage-pay-pricing';

/**
 * The period's Sunday, from the source file's PARSED DATE RANGE — the same derivation
 * the wizard uses for `hubstaffWeekStart` (never the filename's other text: see
 * [[orphanage-source-file-drift-hides-a-week]]). The route derives the week itself and
 * refuses a tab that names a different one, so a week's money is never sent under
 * another week's label. Null when the file carries no range.
 */
export function weekStartFromSourceFile(sourceFile: string): string | null {
  const r = parseDateRangeFromFilename(sourceFile);
  if (!r) return null;
  const d = r.start;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** Columns of the OMS-side table, in the order the DDL in the feature doc lists them.
 *  `oms-return.test.ts` pins every one of these against that DDL. */
export const OMS_RETURN_COLUMNS = [
  'push_id',
  'pushed_at',
  'pushed_by',
  'source_file',
  'week_start',
  'pay_week',
  'work_email',
  'hris_email',
  'employee_name',
  'hours',
  'regular_hours',
  'ot_hours',
  'regular_rate_php',
  'ot_rate_php',
  'amount_php',
  'verdict',
  'cycle_locked',
] as const;

export type OmsReturnColumn = (typeof OMS_RETURN_COLUMNS)[number];

export interface OmsReturnRow {
  /** Lower-cased key the HRIS pays under (the Additions row's email). */
  hrisEmail: string;
  /** The address OMS knows the person by — OMS's own, when the tab's pull carried it. */
  workEmail: string;
  name: string | null;
  payWeek: string | null;
  /** Null when there is no `orphanage_pay` record behind the amount (hand-typed). */
  hours: number | null;
  regularHours: number | null;
  otHours: number | null;
  regularRatePhp: number | null;
  otRatePhp: number | null;
  /** The paying value, from the additions blob. */
  amountPhp: number;
  verdict: OrphanageReconcileStatus;
}

export interface OmsReturnTotals {
  people: number;
  amountPhp: number;
  regularHours: number;
  otHours: number;
}

export interface OmsReturnBuild {
  rows: OmsReturnRow[];
  totals: OmsReturnTotals;
  /** Emails with hours on record but NO amount on the column — not sent. */
  recordsWithoutAmount: string[];
  verdictCounts: Record<OrphanageReconcileStatus, number>;
}

/** One `orphanage_pay` row as the table stores it (numeric columns may arrive as strings). */
export interface OrphanagePayRecordLike {
  employee_email?: unknown;
  employee_name?: unknown;
  pay_week?: unknown;
  hours?: unknown;
  reg_hours?: unknown;
  ot_hours?: unknown;
  regular_rate_php?: unknown;
  ot_rate_php?: unknown;
}

export type OmsReturnBuildResult = { ok: true; build: OmsReturnBuild } | { ok: false; reason: string };

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

const norm = (e: string) => e.trim().toLowerCase();

/**
 * Read `orphanageAmounts` out of the stored blob STRICTLY. Absent blob or absent map ⇒
 * an empty map (nothing locked in). A blob that is not a JSON object is refused — it
 * is the paying carrier, and reading garbage as "nothing" would send an empty week.
 */
export function parseOrphanageAmounts(blobValue: string | null): { ok: true; amounts: Record<string, unknown> } | { ok: false; reason: string } {
  if (blobValue == null) return { ok: true, amounts: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(blobValue);
  } catch {
    return { ok: false, reason: 'The additions record for this period is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'The additions record for this period is not an object' };
  }
  const map = (parsed as { orphanageAmounts?: unknown }).orphanageAmounts;
  if (map == null) return { ok: true, amounts: {} };
  if (typeof map !== 'object' || Array.isArray(map)) {
    return { ok: false, reason: 'orphanageAmounts in the additions record is not a map' };
  }
  return { ok: true, amounts: map as Record<string, unknown> };
}

const EMAILISH = /^[^\s@]{1,128}@[^\s@]{1,125}$/;
const MAX_ALIASES = 5_000;

/** The test {@link cleanReturnAliases} applies to both sides of a pair — exported so the
 *  panel offers only pairs the route will accept (one odd address must not 400 a send). */
export function isReturnAliasEmail(s: string): boolean {
  return EMAILISH.test(s.trim());
}

/**
 * Validate the tab's `hrisEmail → omsEmail` relabels. Strict: a malformed pair is a
 * 400, never quietly dropped, so a caller cannot believe it relabelled someone it did not.
 */
export function cleanReturnAliases(raw: unknown): { ok: true; aliases: Map<string, string> } | { ok: false; reason: string } {
  const out = new Map<string, string>();
  if (raw == null) return { ok: true, aliases: out };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'aliases must be an object of email → email' };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_ALIASES) return { ok: false, reason: `aliases may hold at most ${MAX_ALIASES} entries` };
  for (const [k, v] of entries) {
    if (typeof v !== 'string' || !isReturnAliasEmail(k) || !isReturnAliasEmail(v)) {
      return { ok: false, reason: `aliases entry "${k.slice(0, 80)}" is not an email → email pair` };
    }
    out.set(norm(k), v.trim());
  }
  return { ok: true, aliases: out };
}

/**
 * Build the rows for one period from the paying blob + the records. Sorted by name,
 * then email, so two builds of the same data are byte-identical.
 */
export function buildOmsReturnRows(input: {
  orphanageAmounts: Record<string, unknown>;
  records: readonly OrphanagePayRecordLike[];
  aliases?: ReadonlyMap<string, string>;
}): OmsReturnBuildResult {
  const recordByEmail = new Map<string, OrphanagePayRecordLike>();
  for (const r of input.records) {
    const e = typeof r.employee_email === 'string' ? norm(r.employee_email) : '';
    if (e) recordByEmail.set(e, r);
  }

  const seen = new Set<string>();
  const rows: OmsReturnRow[] = [];
  for (const [rawEmail, rawAmount] of Object.entries(input.orphanageAmounts)) {
    const hrisEmail = norm(rawEmail);
    if (!hrisEmail) return { ok: false, reason: 'An orphanage amount has an empty email key' };
    if (seen.has(hrisEmail)) {
      return { ok: false, reason: `${hrisEmail} has two orphanage amounts in the additions record (keys differ only in case)` };
    }
    seen.add(hrisEmail);
    const amount = num(rawAmount);
    if (amount == null) {
      return { ok: false, reason: `The orphanage amount for ${hrisEmail} is not a number — fix it on the step before sending` };
    }

    const rec = recordByEmail.get(hrisEmail) ?? null;
    const hours = rec ? num(rec.hours) : null;
    const regH = rec ? num(rec.reg_hours) : null;
    const otH = rec ? num(rec.ot_hours) : null;
    const regRate = rec ? num(rec.regular_rate_php) : null;
    const otRate = rec ? num(rec.ot_rate_php) : null;
    const check = reconcileLockedOrphanageAmount({
      storedAmountPhp: amount,
      record: rec
        ? { hours: hours ?? 0, regHours: regH ?? 0, otHours: otH ?? 0, regularRatePhp: regRate, otRatePhp: otRate }
        : null,
    });

    rows.push({
      hrisEmail,
      workEmail: input.aliases?.get(hrisEmail) ?? hrisEmail,
      name: rec ? text(rec.employee_name) : null,
      payWeek: rec ? text(rec.pay_week) : null,
      hours: hours == null ? null : round4(hours),
      regularHours: regH == null ? null : round4(regH),
      otHours: otH == null ? null : round4(otH),
      regularRatePhp: regRate,
      otRatePhp: otRate,
      amountPhp: round2(amount),
      verdict: check.status,
    });
  }

  rows.sort((a, b) => (a.name ?? a.hrisEmail).localeCompare(b.name ?? b.hrisEmail) || a.hrisEmail.localeCompare(b.hrisEmail));

  const recordsWithoutAmount = [...recordByEmail.keys()].filter((e) => !seen.has(e)).sort();
  const verdictCounts: Record<OrphanageReconcileStatus, number> = { ok: 0, amount_mismatch: 0, ot_underpriced: 0, unverifiable: 0 };
  for (const r of rows) verdictCounts[r.verdict] += 1;

  return {
    ok: true,
    build: {
      rows,
      totals: {
        people: rows.length,
        amountPhp: round2(rows.reduce((s, r) => s + r.amountPhp, 0)),
        regularHours: round4(rows.reduce((s, r) => s + (r.regularHours ?? 0), 0)),
        otHours: round4(rows.reduce((s, r) => s + (r.otHours ?? 0), 0)),
      },
      recordsWithoutAmount,
      verdictCounts,
    },
  };
}

/** The rows as OMS's table stores them — one object per row, keyed by {@link OMS_RETURN_COLUMNS}. */
export function toOmsReturnRecords(
  rows: readonly OmsReturnRow[],
  meta: { pushId: string; pushedAt: string; pushedBy: string; sourceFile: string; weekStart: string; cycleLocked: boolean },
): Array<Record<OmsReturnColumn, string | number | boolean | null>> {
  return rows.map((r) => ({
    push_id: meta.pushId,
    pushed_at: meta.pushedAt,
    pushed_by: meta.pushedBy,
    source_file: meta.sourceFile,
    week_start: meta.weekStart,
    pay_week: r.payWeek,
    work_email: r.workEmail,
    hris_email: r.hrisEmail,
    employee_name: r.name,
    hours: r.hours,
    regular_hours: r.regularHours,
    ot_hours: r.otHours,
    regular_rate_php: r.regularRatePhp,
    ot_rate_php: r.otRatePhp,
    amount_php: r.amountPhp,
    verdict: r.verdict,
    cycle_locked: meta.cycleLocked,
  }));
}
