/**
 * NPD's client cache (Kane, 2026-10-02: "Make sure to add caching on this please so
 * we dont have to load the data everytime"). The store is the shared Accounting tab
 * cache (src/lib/accounting/tab-cache.ts: sessionStorage, identity-stamped, 12 h,
 * purged on sign-out). This module is the pure part: what NPD keeps there and how a
 * cached copy is re-checked before it is trusted. Governing docs:
 * docs/features/npd-dashboard.md § Caching · docs/features/accounting-dashboard-cache.md.
 *
 * The rules (each enforced in useNpdSheet / NpdDashboard, pinned by tests):
 *  - A cached sheet only PAINTS. It is read-only until the live read lands: nothing can
 *    be typed, saved, locked or synced onto a copy that may be stale. Every open still
 *    reads live (this store's banned category: per-person pay; no skip flag).
 *  - It is written from SERVER TRUTH only: a load, a confirmed save, a confirmed lock.
 *    Edits that have not been saved never reach it.
 *  - The envelope guarantees identity, version and age, not shape. A cached payload is
 *    re-validated here and dropped when anything is off.
 *  - At most NPD_CACHED_SHEETS_MAX sheets are kept (most recently used), because one
 *    sheet is a few hundred kB and the store's quota is shared with every Accounting tab.
 */

import { NPD_COLUMNS, isNpdSheetKind, type NpdSheetKind } from './columns';
import { isSundayIso } from './sheet';

/** One sheet, exactly as GET /api/accounting/npd?sheet&week returns it. */
export type NpdSheetPayload = {
  version: number;
  rowCount: number;
  updatedAt: string | null;
  updatedBy: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  usdPerPhp: string | null;
  columnFormulas: Record<string, string>;
  rows: Array<{ id: string; values: string[]; overrides: string[]; formulas: Record<string, string> }>;
};

/** One entry of GET /api/accounting/npd?list=weeks. */
export type NpdWeekListEntry = {
  sheet: NpdSheetKind;
  week: string;
  rowCount: number;
  updatedAt: string;
  updatedBy: string;
  lockedAt: string | null;
};

export const NPD_CACHED_SHEETS_MAX = 4;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isStringMap = (v: unknown): v is Record<string, string> => isObj(v) && Object.values(v).every((x) => typeof x === 'string');
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A cached sheet, re-checked field by field; null = do not trust it (the live read decides). */
export function parseNpdSheetPayload(sheet: NpdSheetKind, raw: unknown): NpdSheetPayload | null {
  if (!isObj(raw)) return null;
  const width = NPD_COLUMNS[sheet].length;
  const keys = new Set(NPD_COLUMNS[sheet].map((c) => c.key));
  const { version, rowCount, updatedAt, updatedBy, lockedAt, lockedBy, usdPerPhp, columnFormulas, rows } = raw;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return null;
  if (typeof rowCount !== 'number' || !Number.isInteger(rowCount) || rowCount < 0) return null;
  if (![updatedAt, updatedBy, lockedAt, lockedBy, usdPerPhp].every(strOrNull)) return null;
  if (!isStringMap(columnFormulas) || Object.keys(columnFormulas).some((k) => !keys.has(k))) return null;
  if (!Array.isArray(rows)) return null;
  const out: NpdSheetPayload['rows'] = [];
  for (const r of rows) {
    if (!isObj(r) || typeof r.id !== 'string' || r.id === '') return null;
    if (!Array.isArray(r.values) || r.values.length !== width || !r.values.every((v) => typeof v === 'string')) return null;
    if (!Array.isArray(r.overrides) || !r.overrides.every((k) => typeof k === 'string' && keys.has(k))) return null;
    if (!isStringMap(r.formulas) || Object.keys(r.formulas).some((k) => !keys.has(k))) return null;
    out.push({ id: r.id, values: [...r.values], overrides: [...r.overrides], formulas: { ...r.formulas } });
  }
  return {
    version,
    rowCount,
    updatedAt: updatedAt as string | null,
    updatedBy: updatedBy as string | null,
    lockedAt: lockedAt as string | null,
    lockedBy: lockedBy as string | null,
    usdPerPhp: usdPerPhp as string | null,
    columnFormulas: { ...columnFormulas },
    rows: out,
  };
}

/** The cached week list, re-checked; null = do not trust it. */
export function parseNpdWeeks(raw: unknown): NpdWeekListEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: NpdWeekListEntry[] = [];
  for (const w of raw) {
    if (!isObj(w) || !isNpdSheetKind(w.sheet) || typeof w.week !== 'string' || !ISO_DAY.test(w.week)) return null;
    if (typeof w.rowCount !== 'number' || typeof w.updatedAt !== 'string' || typeof w.updatedBy !== 'string') return null;
    if (!strOrNull(w.lockedAt)) return null;
    out.push({ sheet: w.sheet, week: w.week, rowCount: w.rowCount, updatedAt: w.updatedAt, updatedBy: w.updatedBy, lockedAt: w.lockedAt as string | null });
  }
  return out;
}

/**
 * The sheets to keep after `key` was written: most recently used first, at most
 * `max`. `evict` is what falls off the end and must be cleared from the store.
 */
export function touchNpdSheetIndex(index: unknown, key: string, max = NPD_CACHED_SHEETS_MAX): { keep: string[]; evict: string[] } {
  const prev = Array.isArray(index) ? index.filter((k): k is string => typeof k === 'string' && k !== key) : [];
  const all = [key, ...new Set(prev)];
  return { keep: all.slice(0, max), evict: all.slice(max) };
}

/** The sync bar's cached read: the Payroll Wizard's week and each tab's last sync. */
export type NpdSyncWeekCache = {
  week: string;
  sourceFile: string;
  lastSync: Record<NpdSheetKind, { at: string; by: string; tab: string | null } | null> | null;
  lastSyncError: string | null;
};

/** The cached sync-bar read, re-checked; null = do not trust it. */
export function parseNpdSyncWeek(raw: unknown): NpdSyncWeekCache | null {
  if (!isObj(raw) || typeof raw.week !== 'string' || !ISO_DAY.test(raw.week) || typeof raw.sourceFile !== 'string') return null;
  if (!strOrNull(raw.lastSyncError)) return null;
  let lastSync: NpdSyncWeekCache['lastSync'] = null;
  if (raw.lastSync !== null) {
    if (!isObj(raw.lastSync)) return null;
    const one = (v: unknown) => {
      if (v === null) return null;
      if (!isObj(v) || typeof v.at !== 'string' || typeof v.by !== 'string' || !strOrNull(v.tab)) return undefined;
      return { at: v.at, by: v.by, tab: v.tab as string | null };
    };
    const a = one(raw.lastSync.all_departments);
    const h = one(raw.lastSync.hsl);
    if (a === undefined || h === undefined) return null;
    lastSync = { all_departments: a, hsl: h };
  }
  return { week: raw.week, sourceFile: raw.sourceFile, lastSync, lastSyncError: raw.lastSyncError as string | null };
}

/** The week NPD was left on, re-checked: a real Sunday, or nothing (the default week rule applies). */
export function parseNpdView(raw: unknown): { week: string } | null {
  return isObj(raw) && isSundayIso(raw.week) ? { week: raw.week } : null;
}
