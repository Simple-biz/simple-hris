/**
 * Shape an OMS pull + its HRIS resolution into the rows a Save writes. Pure.
 *
 * One output row per OMS row, by `line`: a resolved `ok` row becomes a MATCHED save
 * row (key, split, rates, amount); a resolver error becomes an UNMATCHED save row
 * carrying the reason. The two shapes are mutually exclusive — the table's
 * `resolution_shape` CHECK enforces the same thing on the other side.
 *
 * Doc: docs/features/orphanage-oms-pull.md § Saving
 */

import type { OrphanageHourRow, OrphanageResolveResult } from '@/lib/payroll/orphanage-rows';

export type OmsSaveMode = 'test' | 'live';

export interface OmsSaveRow {
  omsEmail: string;
  omsPayWeek: string | null;
  omsHoursRaw: string;
  omsHours: number | null;
  matched: boolean;
  employeeEmail: string | null;
  employeeName: string | null;
  regHours: number | null;
  otHours: number | null;
  regularRatePhp: number | null;
  otRatePhp: number | null;
  amountPhp: number | null;
  skipReason: string | null;
}

export interface OmsSaveInput {
  weekStart: string;
  sourceFile: string | null;
  mode: OmsSaveMode;
  pull: {
    rows: readonly OrphanageHourRow[];
    approvedCount: number;
    latestUpdatedAt: string | null;
    truncated: boolean;
  };
  resolved: OrphanageResolveResult;
}

export interface OmsSavePayload {
  week_start: string;
  source_file: string | null;
  mode: OmsSaveMode;
  approved_count: number;
  latest_updated_at: string | null;
  truncated: boolean;
  rows: OmsSaveRow[];
}

function parseHours(h: string | number): { raw: string; value: number | null } {
  const raw = typeof h === 'number' ? String(h) : h.trim();
  const n = Number(raw.replace(/,/g, ''));
  return { raw, value: raw !== '' && Number.isFinite(n) ? n : null };
}

export function buildOmsSavePayload(input: OmsSaveInput): OmsSavePayload {
  const okByLine = new Map(input.resolved.ok.map((r) => [r.line, r] as const));
  const errByLine = new Map(input.resolved.errors.map((e) => [e.line, e] as const));

  const rows: OmsSaveRow[] = input.pull.rows.map((r) => {
    const { raw, value } = parseHours(r.hours);
    const ok = okByLine.get(r.line);
    if (ok) {
      return {
        omsEmail: r.email.trim(),
        omsPayWeek: r.payWeek?.trim() || null,
        omsHoursRaw: raw,
        omsHours: value,
        matched: true,
        employeeEmail: ok.emailKey,
        employeeName: ok.name,
        regHours: ok.regH,
        otHours: ok.otH,
        regularRatePhp: ok.rate,
        otRatePhp: ok.otRate,
        amountPhp: ok.amount,
        skipReason: null,
      };
    }
    const err = errByLine.get(r.line);
    return {
      omsEmail: r.email.trim(),
      omsPayWeek: r.payWeek?.trim() || null,
      omsHoursRaw: raw,
      omsHours: value,
      matched: false,
      employeeEmail: null,
      employeeName: null,
      regHours: null,
      otHours: null,
      regularRatePhp: null,
      otRatePhp: null,
      amountPhp: null,
      // A row the resolver neither accepted nor refused cannot happen; say so rather
      // than inventing a match.
      skipReason: err?.reason ?? 'Not resolved',
    };
  });

  return {
    week_start: input.weekStart,
    source_file: input.sourceFile,
    mode: input.mode,
    approved_count: input.pull.approvedCount,
    latest_updated_at: input.pull.latestUpdatedAt,
    truncated: input.pull.truncated,
    rows,
  };
}

/** The route's body check. Refuses anything that would violate the table's shape. */
export function validateOmsSavePayload(raw: unknown): { ok: true; payload: OmsSavePayload } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'Body must be an object' };
  const b = raw as Record<string, unknown>;
  if (typeof b.week_start !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.week_start)) {
    return { ok: false, reason: 'week_start must be YYYY-MM-DD' };
  }
  if (b.mode !== 'test' && b.mode !== 'live') return { ok: false, reason: 'mode must be "test" or "live"' };
  if (!Array.isArray(b.rows) || b.rows.length === 0) return { ok: false, reason: 'rows must be a non-empty array' };
  const rows: OmsSaveRow[] = [];
  for (const [i, r] of (b.rows as unknown[]).entries()) {
    if (!r || typeof r !== 'object') return { ok: false, reason: `rows[${i}] must be an object` };
    const x = r as Record<string, unknown>;
    if (typeof x.omsEmail !== 'string' || !x.omsEmail.trim()) return { ok: false, reason: `rows[${i}].omsEmail is required` };
    if (typeof x.matched !== 'boolean') return { ok: false, reason: `rows[${i}].matched must be boolean` };
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
    const row: OmsSaveRow = {
      omsEmail: x.omsEmail.trim(),
      omsPayWeek: str(x.omsPayWeek),
      omsHoursRaw: typeof x.omsHoursRaw === 'string' ? x.omsHoursRaw : String(x.omsHours ?? ''),
      omsHours: num(x.omsHours),
      matched: x.matched,
      employeeEmail: str(x.employeeEmail),
      employeeName: str(x.employeeName),
      regHours: num(x.regHours),
      otHours: num(x.otHours),
      regularRatePhp: num(x.regularRatePhp),
      otRatePhp: num(x.otRatePhp),
      amountPhp: num(x.amountPhp),
      skipReason: str(x.skipReason),
    };
    if (row.matched && (!row.employeeEmail || row.amountPhp === null || row.skipReason !== null)) {
      return { ok: false, reason: `rows[${i}]: a matched row needs employeeEmail + amountPhp and no skipReason` };
    }
    if (!row.matched && (!row.skipReason || row.employeeEmail !== null || row.amountPhp !== null)) {
      return { ok: false, reason: `rows[${i}]: an unmatched row needs skipReason and no employeeEmail/amountPhp` };
    }
    rows.push(row);
  }
  return {
    ok: true,
    payload: {
      week_start: b.week_start,
      source_file: typeof b.source_file === 'string' && b.source_file.trim() ? b.source_file : null,
      mode: b.mode,
      approved_count: typeof b.approved_count === 'number' && Number.isFinite(b.approved_count) ? b.approved_count : rows.length,
      latest_updated_at: typeof b.latest_updated_at === 'string' && b.latest_updated_at ? b.latest_updated_at : null,
      truncated: b.truncated === true,
      rows,
    },
  };
}
