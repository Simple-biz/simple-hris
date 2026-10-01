/**
 * HRIS vs NPD — SAVE OUTPUT: the snapshot the Validation step's Output saves, built in the
 * browser from what is on screen and validated again on the server before it is stored.
 *
 * PURE: no React, no fetch, no Date, no crypto. Kane, 2026-10-01: "Give me an SQL Migration
 * for this one so I can save the output for the current week". Tables + save function:
 * references/sql/create/2026-10-01_payroll_wizard_npd_comparisons.sql. Governing doc:
 * docs/features/payroll-wizard-hris-vs-npd.md § Saving the output.
 *
 * THE RULES
 * ---------
 * 1. **An output whose verdicts are held is never saved.** `buildHrisNpdSnapshot` refuses
 *    while `comparison.hold` is set (loading, a failed source, FX 0, nothing pasted), and
 *    the database refuses a row with no verdict. An unjudged output is not a result.
 * 2. **The snapshot is the output exactly as shown**: every row (verdict, HRIS and NPD
 *    dollars in cents, the difference, HRIS's pesos, the paste lines), the left-out list,
 *    the refused lines, the tolerance and the FX rate, the counts and totals, and the paste
 *    text VERBATIM. Nothing is re-sorted, re-rounded or dropped.
 * 3. **The server re-derives the NPD side from the stored paste** (`validateHrisNpdSnapshot`
 *    runs `parseNpdPaste` on `paste_text`): every parsed line must land exactly once, on a
 *    row or a left-out person with that address, and their cents must add up to the figure
 *    saved. HRIS's figures are the browser's — the server cannot recompute the wizard — so
 *    they are checked for consistency (verdict vs tolerance, difference, totals), not rerun.
 * 4. **Keys are snake_case, in a fixed order**, because they are the SQL columns
 *    (`hris-npd-snapshot.test.ts` reads the SQL file) and because the route hashes
 *    `JSON.stringify` of the validated snapshot: the same output must give the same hash.
 */

import { normEmail } from '@/lib/email/norm-email';

import {
  HRIS_NPD_STATUSES,
  MAX_MATCH_TOLERANCE_CENTS,
  parseNpdPaste,
  type HrisNpdComparison,
  type HrisNpdHold,
  type HrisNpdLeftOutReason,
  type HrisNpdStatus,
  type NpdPasteParse,
} from './hris-npd-compare';

/** The save function's cap (`pw_npd_cmp_too_many_rows`). A week is ~1,200 people. */
export const MAX_SNAPSHOT_ROWS = 5000;
/** The paste column's cap (`pw_npd_cmp_paste_present`). */
export const MAX_SNAPSHOT_PASTE_CHARS = 2_000_000;
/** The source-file key's cap, as the Manual Validation route has it. */
export const MAX_SOURCE_FILE_CHARS = 300;

export interface HrisNpdSnapshotRow {
  row_no: number;
  work_email: string;
  name: string | null;
  status: HrisNpdStatus;
  hris_cents: number | null;
  npd_cents: number | null;
  delta_cents: number | null;
  hris_php: number | null;
  hris_row_count: number;
  excluded_row_count: number;
  no_payout_row_count: number;
  npd_lines: number[];
  implied_npd_rate: number | null;
}

export interface HrisNpdSnapshotLeftOut {
  work_email: string;
  name: string | null;
  reason: HrisNpdLeftOutReason;
  npd_cents: number | null;
  npd_lines: number[];
}

export interface HrisNpdSnapshotRefusal {
  line: number;
  raw: string;
  reason: string;
}

export interface HrisNpdSnapshotHeader {
  tolerance_cents: number;
  fx_rate: number;
  match_count: number;
  mismatch_count: number;
  not_in_hris_count: number;
  not_in_npd_count: number;
  row_count: number;
  left_out_count: number;
  npd_lines_read: number;
  refusal_count: number;
  hris_total_cents: number;
  npd_total_cents: number;
  paste_text: string;
  refusals: HrisNpdSnapshotRefusal[];
  left_out: HrisNpdSnapshotLeftOut[];
}

export interface HrisNpdSnapshot {
  header: HrisNpdSnapshotHeader;
  rows: HrisNpdSnapshotRow[];
}

/** Why Save output is not available, in the words the button's hint uses. */
export function heldSaveReason(hold: HrisNpdHold): string {
  switch (hold.kind) {
    case 'no_npd_rows':
      return 'Paste at least one readable NPD line first.';
    case 'loading':
      return 'Rows are not marked yet: this week’s pay is still loading.';
    case 'unavailable':
      return 'Part of this week’s pay failed to load, so no row is marked. Reload the wizard first.';
    case 'no_fx':
      return 'This cycle’s USD→PHP rate is still 0, so no row is marked.';
  }
}

/**
 * The output on screen → the snapshot Save output sends, or why it cannot be saved.
 * Built from the SAME comparison and parse the table renders, so what is saved is what
 * was seen.
 */
export function buildHrisNpdSnapshot(input: {
  comparison: HrisNpdComparison;
  parse: NpdPasteParse;
  pasteText: string;
  fxRate: number;
}): { ok: true; snapshot: HrisNpdSnapshot } | { ok: false; reason: string } {
  const { comparison, parse, pasteText, fxRate } = input;
  if (comparison.hold) return { ok: false, reason: heldSaveReason(comparison.hold) };
  if (comparison.counts == null) return { ok: false, reason: 'Rows are not marked yet.' };
  if (comparison.rows.length === 0) return { ok: false, reason: 'There is no output to save.' };
  if (!(fxRate > 0)) return { ok: false, reason: heldSaveReason({ kind: 'no_fx' }) };
  if (comparison.totals.hrisCents == null) return { ok: false, reason: 'HRIS’s total could not be priced.' };

  const rows: HrisNpdSnapshotRow[] = [];
  for (const [i, r] of comparison.rows.entries()) {
    if (r.status == null) return { ok: false, reason: 'Rows are not marked yet.' };
    rows.push({
      row_no: i + 1,
      work_email: r.workEmail,
      name: r.name,
      status: r.status,
      hris_cents: r.hrisCents,
      npd_cents: r.npdCents,
      delta_cents: r.deltaCents,
      hris_php: r.hrisPhp,
      hris_row_count: r.hrisRowCount,
      excluded_row_count: r.excludedRowCount,
      no_payout_row_count: r.noPayoutRowCount,
      npd_lines: [...r.npdLines],
      implied_npd_rate: r.impliedNpdRate,
    });
  }

  const c = comparison.counts;
  return {
    ok: true,
    snapshot: {
      header: {
        tolerance_cents: comparison.toleranceCents,
        fx_rate: fxRate,
        match_count: c.match,
        mismatch_count: c.mismatch,
        not_in_hris_count: c.not_in_hris,
        not_in_npd_count: c.not_in_npd,
        row_count: rows.length,
        left_out_count: comparison.leftOut.length,
        npd_lines_read: parse.rows.length,
        refusal_count: parse.refusals.length,
        hris_total_cents: comparison.totals.hrisCents,
        npd_total_cents: comparison.totals.npdCents,
        paste_text: pasteText,
        refusals: parse.refusals.map((f) => ({ line: f.line, raw: f.raw, reason: f.reason })),
        left_out: comparison.leftOut.map((l) => ({
          work_email: l.workEmail,
          name: l.name,
          reason: l.reason,
          npd_cents: l.npdCents,
          npd_lines: [...l.npdLines],
        })),
      },
      rows,
    },
  };
}

// ─── Server-side validation ───────────────────────────────────────────────────

/** A filename-shaped week key: trimmed, 1–300 chars, no control characters. Same rule as
 *  the Manual Validation route's `cleanSourceFile`. */
export function cleanSnapshotSourceFile(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s === '' || s.length > MAX_SOURCE_FILE_CHARS) return null;
  for (let j = 0; j < s.length; j += 1) {
    const code = s.charCodeAt(j);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return s;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}
function isCents(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}
function isLineList(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0);
}
function isTwoDp(v: number): boolean {
  return Number.isFinite(v) && Math.round(v * 100) / 100 === v;
}
function strOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

const STATUS_SET: ReadonlySet<string> = new Set(HRIS_NPD_STATUSES);

/**
 * The request body's snapshot → a clean snapshot in canonical key order, or every reason
 * it is refused. Mirrors the SQL's CHECKs and the save function's proofs, so a bad snapshot
 * gets a readable 400 instead of a constraint name, and adds the one check the database
 * cannot make: the NPD side is exactly the stored paste (rule 3).
 */
export function validateHrisNpdSnapshot(
  raw: unknown,
): { ok: true; snapshot: HrisNpdSnapshot } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const fail = (e: string) => ({ ok: false as const, errors: [...errors, e] });
  if (!isObj(raw) || !isObj(raw.header) || !Array.isArray(raw.rows)) return fail('snapshot must be { header, rows[] }');
  const h = raw.header;

  // ── Header ──
  const tol = h.tolerance_cents;
  if (!(typeof tol === 'number' && Number.isInteger(tol) && tol >= 0 && tol <= MAX_MATCH_TOLERANCE_CENTS)) {
    errors.push(`tolerance_cents must be a whole number from 0 to ${MAX_MATCH_TOLERANCE_CENTS}`);
  }
  if (!(typeof h.fx_rate === 'number' && Number.isFinite(h.fx_rate) && h.fx_rate > 0)) errors.push('fx_rate must be above 0');
  const countKeys = ['match_count', 'mismatch_count', 'not_in_hris_count', 'not_in_npd_count', 'row_count', 'left_out_count', 'npd_lines_read', 'refusal_count'] as const;
  for (const k of countKeys) if (!isCount(h[k])) errors.push(`${k} must be a whole number ≥ 0`);
  for (const k of ['hris_total_cents', 'npd_total_cents'] as const) if (!isCents(h[k])) errors.push(`${k} must be whole cents`);
  if (typeof h.paste_text !== 'string' || h.paste_text.length === 0) errors.push('paste_text is required');
  else if (h.paste_text.length > MAX_SNAPSHOT_PASTE_CHARS) errors.push(`paste_text is over ${MAX_SNAPSHOT_PASTE_CHARS} characters`);
  if (!Array.isArray(h.refusals)) errors.push('refusals must be an array');
  if (!Array.isArray(h.left_out)) errors.push('left_out must be an array');
  if (errors.length) return { ok: false, errors };

  const tolerance = tol as number;
  const header = h as unknown as HrisNpdSnapshotHeader;

  // ── Rows ──
  const rawRows = raw.rows as unknown[];
  if (rawRows.length === 0) return fail('there is no output to save');
  if (rawRows.length > MAX_SNAPSHOT_ROWS) return fail(`an output is limited to ${MAX_SNAPSHOT_ROWS} rows`);

  const rows: HrisNpdSnapshotRow[] = [];
  const counts: Record<HrisNpdStatus, number> = { match: 0, mismatch: 0, not_in_hris: 0, not_in_npd: 0 };
  let hrisSum = 0;
  let npdSum = 0;
  rawRows.forEach((rr, i) => {
    const at = `row ${i + 1}`;
    if (!isObj(rr)) {
      errors.push(`${at} is not an object`);
      return;
    }
    if (rr.row_no !== i + 1) errors.push(`${at}: row_no must be ${i + 1}`);
    if (typeof rr.work_email !== 'string' || rr.work_email.trim() === '') errors.push(`${at}: work_email is required`);
    if (!strOrNull(rr.name)) errors.push(`${at}: name must be text or null`);
    const status = rr.status;
    if (typeof status !== 'string' || !STATUS_SET.has(status)) {
      errors.push(`${at}: status must be one of ${HRIS_NPD_STATUSES.join(', ')} (an output with unmarked rows is not saved)`);
      return;
    }
    const s = status as HrisNpdStatus;
    const inHris = s !== 'not_in_hris';
    const inNpd = s !== 'not_in_npd';
    for (const k of ['hris_row_count', 'excluded_row_count', 'no_payout_row_count'] as const) {
      if (!isCount(rr[k])) errors.push(`${at}: ${k} must be a whole number ≥ 0`);
    }
    if (!isLineList(rr.npd_lines)) errors.push(`${at}: npd_lines must be paste line numbers`);
    if (inHris ? !isCents(rr.hris_cents) : rr.hris_cents !== null) errors.push(`${at}: hris_cents must be ${inHris ? 'whole cents' : 'null on a Not in HRIS row'}`);
    if (inNpd ? !isCents(rr.npd_cents) : rr.npd_cents !== null) errors.push(`${at}: npd_cents must be ${inNpd ? 'whole cents' : 'null on a Not in NPD row'}`);
    if (inHris ? !(typeof rr.hris_php === 'number' && isTwoDp(rr.hris_php)) : rr.hris_php !== null) errors.push(`${at}: hris_php must be ${inHris ? 'pesos to 2 decimals' : 'null on a Not in HRIS row'}`);
    if (inHris !== (rr.hris_row_count !== 0)) errors.push(`${at}: hris_row_count must be ${inHris ? 'at least 1' : '0'} for ${s}`);
    if (isLineList(rr.npd_lines) && inNpd !== (rr.npd_lines.length > 0)) errors.push(`${at}: ${inNpd ? 'an NPD row needs its paste lines' : 'a Not in NPD row has no paste lines'}`);
    const both = inHris && inNpd;
    if (both) {
      if (!isCents(rr.delta_cents)) errors.push(`${at}: delta_cents is required on a ${s}`);
      else if (isCents(rr.hris_cents) && isCents(rr.npd_cents)) {
        if (rr.delta_cents !== rr.npd_cents - rr.hris_cents) errors.push(`${at}: delta_cents must be NPD − HRIS`);
        const within = Math.abs(rr.delta_cents) <= tolerance;
        if (s === 'match' && !within) errors.push(`${at}: a match must be within ${tolerance}¢`);
        if (s === 'mismatch' && within) errors.push(`${at}: a mismatch must be more than ${tolerance}¢ off`);
      }
    } else if (rr.delta_cents !== null) {
      errors.push(`${at}: delta_cents must be null on a ${s} row`);
    }
    const rate = rr.implied_npd_rate;
    if (rate !== null && !(s === 'mismatch' && typeof rate === 'number' && Number.isFinite(rate) && rate > 0)) {
      errors.push(`${at}: implied_npd_rate is only on a mismatch, and above 0`);
    }
    counts[s] += 1;
    if (isCents(rr.hris_cents)) hrisSum += rr.hris_cents;
    if (isCents(rr.npd_cents)) npdSum += rr.npd_cents;
    rows.push({
      row_no: rr.row_no as number,
      work_email: rr.work_email as string,
      name: (rr.name as string | null) ?? null,
      status: s,
      hris_cents: rr.hris_cents as number | null,
      npd_cents: rr.npd_cents as number | null,
      delta_cents: rr.delta_cents as number | null,
      hris_php: rr.hris_php as number | null,
      hris_row_count: rr.hris_row_count as number,
      excluded_row_count: rr.excluded_row_count as number,
      no_payout_row_count: rr.no_payout_row_count as number,
      npd_lines: [...((rr.npd_lines as number[]) ?? [])],
      implied_npd_rate: (rate as number | null) ?? null,
    });
  });
  if (errors.length) return { ok: false, errors };

  // ── Counts and totals are the rows' ──
  if (header.match_count !== counts.match || header.mismatch_count !== counts.mismatch
    || header.not_in_hris_count !== counts.not_in_hris || header.not_in_npd_count !== counts.not_in_npd) {
    errors.push('the counts are not the rows’ verdicts');
  }
  if (header.row_count !== rows.length) errors.push('row_count is not the number of rows');
  if (header.hris_total_cents !== hrisSum) errors.push('hris_total_cents is not the sum of the rows');
  if (header.npd_total_cents !== npdSum) errors.push('npd_total_cents is not the sum of the rows');

  // ── Left out ──
  const leftOut: HrisNpdSnapshotLeftOut[] = [];
  (h.left_out as unknown[]).forEach((lo, i) => {
    const at = `left_out ${i + 1}`;
    if (!isObj(lo)) {
      errors.push(`${at} is not an object`);
      return;
    }
    if (typeof lo.work_email !== 'string' || lo.work_email.trim() === '') errors.push(`${at}: work_email is required`);
    if (!strOrNull(lo.name)) errors.push(`${at}: name must be text or null`);
    if (lo.reason !== 'excluded' && lo.reason !== 'paused') errors.push(`${at}: reason must be excluded or paused`);
    if (!isLineList(lo.npd_lines)) errors.push(`${at}: npd_lines must be paste line numbers`);
    if (lo.npd_cents !== null && !isCents(lo.npd_cents)) errors.push(`${at}: npd_cents must be whole cents or null`);
    if (isLineList(lo.npd_lines) && (lo.npd_cents === null) !== (lo.npd_lines.length === 0)) {
      errors.push(`${at}: npd_cents is set exactly when NPD lists them`);
    }
    // A paused person is only ever listed because NPD lists them.
    if (lo.reason === 'paused' && lo.npd_cents === null) errors.push(`${at}: a paused-department person is listed only when NPD lists them`);
    leftOut.push({
      work_email: lo.work_email as string,
      name: (lo.name as string | null) ?? null,
      reason: lo.reason as HrisNpdLeftOutReason,
      npd_cents: (lo.npd_cents as number | null) ?? null,
      npd_lines: [...((lo.npd_lines as number[]) ?? [])],
    });
  });
  if (header.left_out_count !== leftOut.length) errors.push('left_out_count is not the number of people left out');
  if (errors.length) return { ok: false, errors };

  // ── The NPD side is exactly the stored paste (rule 3) ──
  const parse = parseNpdPaste(header.paste_text);
  if (parse.rows.length === 0) errors.push('the saved paste has no readable line');
  if (header.npd_lines_read !== parse.rows.length) errors.push(`npd_lines_read is ${header.npd_lines_read}, but the paste has ${parse.rows.length} readable lines`);
  const refusals = parse.refusals.map((f) => ({ line: f.line, raw: f.raw, reason: f.reason }));
  const sentRefusals = h.refusals as unknown[];
  if (header.refusal_count !== refusals.length || sentRefusals.length !== refusals.length
    || refusals.some((f, i) => {
      const s = sentRefusals[i];
      return !isObj(s) || s.line !== f.line || s.raw !== f.raw || s.reason !== f.reason;
    })) {
    errors.push('the refused lines are not the paste’s');
  }
  const byLine = new Map(parse.rows.map((r) => [r.line, r]));
  const seen = new Set<number>();
  const claim = (who: string, email: string, lines: readonly number[], cents: number | null) => {
    const key = normEmail(email);
    let sum = 0;
    for (const n of lines) {
      const line = byLine.get(n);
      if (!line) {
        errors.push(`${who}: paste line ${n} is not a readable line of the paste`);
        continue;
      }
      if (seen.has(n)) errors.push(`${who}: paste line ${n} is counted twice`);
      seen.add(n);
      if (normEmail(line.email) !== key) errors.push(`${who}: paste line ${n} is ${line.email}, not this address`);
      sum += line.cents;
    }
    if (cents != null && cents !== sum) errors.push(`${who}: NPD’s figure is not the sum of its paste lines`);
  };
  for (const r of rows) claim(`row ${r.row_no}`, r.work_email, r.npd_lines, r.npd_cents);
  leftOut.forEach((l, i) => claim(`left_out ${i + 1}`, l.work_email, l.npd_lines, l.npd_cents));
  const unclaimed = parse.rows.filter((r) => !seen.has(r.line));
  if (unclaimed.length > 0) {
    errors.push(`${unclaimed.length} paste line${unclaimed.length === 1 ? ' is' : 's are'} on no row (line ${unclaimed.slice(0, 5).map((r) => r.line).join(', ')})`);
  }
  if (errors.length) return { ok: false, errors };

  // Canonical key order (rule 4): the route hashes JSON.stringify of exactly this.
  return {
    ok: true,
    snapshot: {
      header: {
        tolerance_cents: header.tolerance_cents,
        fx_rate: header.fx_rate,
        match_count: header.match_count,
        mismatch_count: header.mismatch_count,
        not_in_hris_count: header.not_in_hris_count,
        not_in_npd_count: header.not_in_npd_count,
        row_count: header.row_count,
        left_out_count: header.left_out_count,
        npd_lines_read: header.npd_lines_read,
        refusal_count: header.refusal_count,
        hris_total_cents: header.hris_total_cents,
        npd_total_cents: header.npd_total_cents,
        paste_text: header.paste_text,
        refusals,
        left_out: leftOut,
      },
      rows,
    },
  };
}

// ─── What the Output shows about the last save ────────────────────────────────

/** The newest save of a week, as `GET /api/payroll-wizard/npd-comparison` returns it. */
export interface HrisNpdSaveMeta {
  id: string;
  version: number;
  savedAt: string;
  savedBy: string;
  toleranceCents: number;
  rowCount: number;
  counts: Record<HrisNpdStatus, number>;
  leftOutCount: number;
}

/** A GET/POST body's `latest` → a meta, or null when it is not one (a bad payload is not a save). */
export function parseHrisNpdSaveMeta(raw: unknown): HrisNpdSaveMeta | null {
  if (!isObj(raw) || !isObj(raw.counts)) return null;
  const c = raw.counts;
  if (
    typeof raw.id !== 'string' || !isCount(raw.version) || raw.version < 1
    || typeof raw.savedAt !== 'string' || typeof raw.savedBy !== 'string'
    || !isCount(raw.toleranceCents) || !isCount(raw.rowCount) || !isCount(raw.leftOutCount)
    || !HRIS_NPD_STATUSES.every((s) => isCount(c[s]))
  ) {
    return null;
  }
  return {
    id: raw.id,
    version: raw.version,
    savedAt: raw.savedAt,
    savedBy: raw.savedBy,
    toleranceCents: raw.toleranceCents,
    rowCount: raw.rowCount,
    counts: { match: c.match as number, mismatch: c.mismatch as number, not_in_hris: c.not_in_hris as number, not_in_npd: c.not_in_npd as number },
    leftOutCount: raw.leftOutCount,
  };
}
