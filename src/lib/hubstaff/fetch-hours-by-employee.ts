/**
 * Fetch every Hubstaff source file and build a `email → (dayKey → maxSeconds)` map.
 *
 * Used by the Orphanage / Accounting "Create disputes" dialog (red-day calendar) and
 * any other surface that needs per-employee daily totals across all uploads. Browser-only
 * — talks to `/api/hubstaff-hours`. The result is cheap to keep around in component state;
 * keep the parsing/fetching out of the dialog open path so opening is instant.
 *
 * `rosterFilter` (optional set of normalized work emails) skips rows whose emails aren't
 * in the roster — cuts Map allocations and `pabDateKey` calls when the dataset is large.
 */

import { normEmail } from '@/lib/email/norm-email';
import {
  columnsAreAllCanonical,
  groupDateColumnsByCalendarDay,
  pabDateKey,
  parseColDate,
  resolveCanonicalColumnsToIso,
} from './calendar-column-dedupe';

const HUBSTAFF_EMAIL_KEYS = ['Email', 'email', 'Work Email', 'work_email', 'user_email'] as const;

const NON_DATE_COLS = new Set([
  'id', 'email', 'member', 'total worked', 'activity', 'organization',
  'time zone', 'job type', 'job title', 'work email', 'personal email',
  'employee id', 'tax info', 'location', 'date added', 'spent total', 'currency',
]);

const CANONICAL_WEEKDAYS = new Set([
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
]);

function isDateCol(col: string): boolean {
  const lower = col.trim().toLowerCase();
  if (NON_DATE_COLS.has(lower)) return false;
  if (CANONICAL_WEEKDAYS.has(lower)) return true;
  if (/^(mon|tue|wed|thu|fri|sat|sun)/i.test(col.trim())) return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(col.trim());
}

/** Parse Hubstaff "h:mm:ss" / "h:mm" / decimal-hours strings into integer seconds. */
function parseHMS(v: unknown): number {
  if (v == null) return 0;
  const s = String(v).trim();
  if (!s) return 0;
  const hms = /^(\d+):(\d{2}):(\d{2})$/.exec(s);
  if (hms) return parseInt(hms[1], 10) * 3600 + parseInt(hms[2], 10) * 60 + parseInt(hms[3], 10);
  const hm = /^(\d+):(\d{2})$/.exec(s);
  if (hm) return parseInt(hm[1], 10) * 3600 + parseInt(hm[2], 10) * 60;
  const dec = parseFloat(s);
  return Number.isFinite(dec) ? Math.round(dec * 3600) : 0;
}

function getRowEmails(row: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  for (const k of HUBSTAFF_EMAIL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(row, k)) {
      const v = row[k];
      if (v != null && String(v).trim()) seen.add(String(v).trim());
    }
  }
  const lower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) lower.set(k.toLowerCase(), v);
  for (const alias of ['work email', 'personal email', 'work_email', 'personal_email']) {
    const v = lower.get(alias);
    if (v != null && String(v).trim()) seen.add(String(v).trim());
  }
  const norm: string[] = [];
  for (const e of seen) {
    const n = normEmail(e);
    if (n) norm.push(n);
  }
  return norm;
}

export type HubstaffHoursByEmployee = Map<string, Map<string, number>>;

/**
 * Fetches all Hubstaff source files in parallel and returns the per-employee daily-seconds map.
 * Returns an empty map on any error (callers can show a fallback).
 */
export async function fetchHoursByEmployee(opts?: {
  /** Optional filter — only rows whose normalized emails are in this set are included. */
  rosterFilter?: ReadonlySet<string>;
  /** AbortSignal so callers can cancel mid-flight (e.g. unmount). */
  signal?: AbortSignal;
}): Promise<HubstaffHoursByEmployee> {
  const filter = opts?.rosterFilter;
  const signal = opts?.signal;
  const out = new Map<string, Map<string, number>>();

  try {
    const filesRes = await fetch(`/api/hubstaff-hours?source_files=1&_=${Date.now()}`, {
      cache: 'no-store',
      signal,
    });
    const filesJson = (await filesRes.json()) as { files?: string[] };
    const files = filesJson.files ?? [];
    if (files.length === 0) return out;

    const responses = await Promise.all(
      files.map((file) =>
        fetch(`/api/hubstaff-hours?source_file=${encodeURIComponent(file)}&_=${Date.now()}`, {
          cache: 'no-store',
          signal,
        })
          .then(async (res) => {
            const json = (await res.json()) as {
              columns?: string[] | null;
              rows?: Record<string, unknown>[] | null;
            };
            return { file, json };
          })
          .catch(() => ({ file, json: { columns: null, rows: null } as { columns: string[] | null; rows: Record<string, unknown>[] | null } })),
      ),
    );

    for (const { file, json } of responses) {
      if (!json.columns || !json.rows) continue;
      const needsResolve = columnsAreAllCanonical(json.columns);
      for (const row of json.rows) {
        const emails = getRowEmails(row);
        if (emails.length === 0) continue;
        // Cut parse cost: skip rows that aren't in the roster we care about.
        if (filter) {
          let any = false;
          for (const e of emails) {
            if (filter.has(e)) { any = true; break; }
          }
          if (!any) continue;
        }
        const resolved = needsResolve ? resolveCanonicalColumnsToIso(row, file) : row;
        const cols = needsResolve ? Object.keys(resolved) : json.columns;
        const dateCols = cols.filter(isDateCol);
        const groups = groupDateColumnsByCalendarDay(dateCols, cols);
        for (const group of groups) {
          let d: Date | null = null;
          for (const c of group) {
            d = parseColDate(c);
            if (d) break;
          }
          if (!d) continue;
          let maxS = 0;
          for (const c of group) {
            const raw = Object.prototype.hasOwnProperty.call(resolved, c) ? resolved[c] : undefined;
            maxS = Math.max(maxS, parseHMS(raw));
          }
          if (maxS <= 0) continue;
          const key = pabDateKey(d);
          for (const em of emails) {
            if (filter && !filter.has(em)) continue;
            if (!out.has(em)) out.set(em, new Map());
            const m = out.get(em)!;
            m.set(key, Math.max(m.get(key) ?? 0, maxS));
          }
        }
      }
    }
  } catch {
    // swallow — caller falls back to empty map
  }
  return out;
}
