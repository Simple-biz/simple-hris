/**
 * Global PAB (Perfect Attendance Bonus) evaluation window.
 * When `pab_period_manual` is true, start/end dates override calendar-month inference from Hubstaff columns.
 * When `pab_scope_department_keys` is set to a JSON array, only those department keys are evaluated (employee dashboard + wizard).
 */

export const PAB_PERIOD_MANUAL_KEY = 'pab_period_manual';
export const PAB_PERIOD_START_KEY = 'pab_period_start';
export const PAB_PERIOD_END_KEY = 'pab_period_end';
export const PAB_SCOPE_DEPARTMENT_KEYS_KEY = 'pab_scope_department_keys';

/** Parse YYYY-MM-DD as a local calendar date (no UTC shift). */
export function parseLocalDateFromIso(value: string | null | undefined): Date | null {
  if (value == null || typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type PabPeriodFetchResult = {
  manual: boolean;
  start: Date | null;
  end: Date | null;
  /**
   * When null (setting missing or invalid), all departments are in scope.
   * When [], no department is in scope.
   * Otherwise only listed keys (e.g. accounting, edit) are in scope.
   */
  scopeDepartmentKeys: string[] | null;
};

/** Valid manual range: manual on, both dates parse, start ≤ end. */
export function isValidManualPabRange(r: PabPeriodFetchResult): r is PabPeriodFetchResult & { start: Date; end: Date } {
  return !!(r.manual && r.start && r.end && r.start.getTime() <= r.end.getTime());
}

export function parsePabScopeDepartmentKeys(value: string | null | undefined): string[] | null {
  if (value == null || String(value).trim() === '') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    return null;
  }
}

/**
 * @param deptKey — normalized department key from `normalizeDeptToKey` or wizard tab assignment
 * @param scope — null = all departments; [] = none; non-empty = allowlist
 */
export function isDeptInPabScope(deptKey: string | null, scope: string[] | null): boolean {
  if (scope === null) return true;
  if (scope.length === 0) return false;
  if (!deptKey) return false;
  return scope.includes(deptKey);
}

export async function fetchPabPeriodSettings(): Promise<PabPeriodFetchResult> {
  const [mj, sj, ej, sk] = await Promise.all([
    fetch(`/api/app-settings?key=${encodeURIComponent(PAB_PERIOD_MANUAL_KEY)}`, { cache: 'no-store' }).then(
      (res) => res.json() as Promise<{ value: string | null }>,
    ),
    fetch(`/api/app-settings?key=${encodeURIComponent(PAB_PERIOD_START_KEY)}`, { cache: 'no-store' }).then(
      (res) => res.json() as Promise<{ value: string | null }>,
    ),
    fetch(`/api/app-settings?key=${encodeURIComponent(PAB_PERIOD_END_KEY)}`, { cache: 'no-store' }).then(
      (res) => res.json() as Promise<{ value: string | null }>,
    ),
    fetch(`/api/app-settings?key=${encodeURIComponent(PAB_SCOPE_DEPARTMENT_KEYS_KEY)}`, { cache: 'no-store' }).then(
      (res) => res.json() as Promise<{ value: string | null }>,
    ),
  ]);
  return {
    manual: mj.value === 'true',
    start: parseLocalDateFromIso(sj.value),
    end: parseLocalDateFromIso(ej.value),
    scopeDepartmentKeys: parsePabScopeDepartmentKeys(sk.value),
  };
}
