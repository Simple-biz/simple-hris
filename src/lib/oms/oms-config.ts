/**
 * Orphanage Management System (OMS) — connection + schema configuration, from env.
 *
 * OMS is a SEPARATE Supabase project where the orphanage team prepares and approves
 * each week's hours. The HRIS reads it; it never writes to it. Everything here is
 * server-only: none of these names carries `NEXT_PUBLIC_`, and the route that uses
 * them returns rows, never this object.
 *
 * Identifiers (table and column names) come from env so the OMS team can rename
 * without a deploy, but every one of them is regex-checked before it reaches a query
 * builder — a column name is never interpolated raw.
 *
 * Doc: docs/features/orphanage-oms-pull.md
 */

const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

export interface OmsConfig {
  url: string;
  key: string;
  table: string;
  cols: {
    /** DATE column holding the week's SUNDAY — the same anchor the pay period keys on. */
    weekStart: string;
    email: string;
    hours: string;
    /** Approval status column; only rows equal to `approvedValue` are ever read. */
    status: string;
    /** Optional text label for the pay week ("9/13- 9/19"); empty = derive from the range. */
    payWeek: string | null;
    /** Optional timestamp; feeds the "prepared … ago" indicator. Empty = no stamp. */
    updatedAt: string | null;
  };
  approvedValue: string;
}

export type OmsConfigResult =
  | { ok: true; config: OmsConfig }
  | { ok: false; reason: string; missing: string[] };

export const OMS_ENV = {
  url: 'OMS_SUPABASE_URL',
  key: 'OMS_SUPABASE_KEY',
  table: 'OMS_HOURS_TABLE',
  colWeekStart: 'OMS_HOURS_COL_WEEK_START',
  colEmail: 'OMS_HOURS_COL_EMAIL',
  colHours: 'OMS_HOURS_COL_HOURS',
  colStatus: 'OMS_HOURS_COL_STATUS',
  colPayWeek: 'OMS_HOURS_COL_PAY_WEEK',
  colUpdatedAt: 'OMS_HOURS_COL_UPDATED_AT',
  approvedValue: 'OMS_HOURS_APPROVED_VALUE',
} as const;

const DEFAULTS = {
  table: 'orphanage_hours',
  colWeekStart: 'week_start',
  colEmail: 'work_email',
  colHours: 'hours',
  colStatus: 'status',
  colPayWeek: 'pay_week',
  colUpdatedAt: 'updated_at',
  approvedValue: 'approved',
} as const;

export function isSafeOmsIdentifier(name: string): boolean {
  return SAFE_IDENT.test(name);
}

type Env = Record<string, string | undefined>;

function read(env: Env, name: string): string {
  return (env[name] ?? '').trim();
}

/**
 * Read and validate the OMS configuration. A missing URL or key is "not configured"
 * (the tab says so and offers nothing); a malformed identifier is refused by name so
 * the wrong value can be found in the env file, never echoed.
 */
export function readOmsConfig(env: Env = process.env): OmsConfigResult {
  const url = read(env, OMS_ENV.url);
  const key = read(env, OMS_ENV.key);
  const missing: string[] = [];
  if (!url) missing.push(OMS_ENV.url);
  if (!key) missing.push(OMS_ENV.key);
  if (missing.length > 0) {
    return { ok: false, reason: `OMS is not configured — set ${missing.join(' and ')}`, missing };
  }
  if (!/^https:\/\/[^\s/]+\.supabase\.co\/?$/i.test(url) && !/^https?:\/\/[^\s]+$/i.test(url)) {
    return { ok: false, reason: `${OMS_ENV.url} is not a URL`, missing: [OMS_ENV.url] };
  }

  const required: Array<[envName: string, value: string]> = [
    [OMS_ENV.table, read(env, OMS_ENV.table) || DEFAULTS.table],
    [OMS_ENV.colWeekStart, read(env, OMS_ENV.colWeekStart) || DEFAULTS.colWeekStart],
    [OMS_ENV.colEmail, read(env, OMS_ENV.colEmail) || DEFAULTS.colEmail],
    [OMS_ENV.colHours, read(env, OMS_ENV.colHours) || DEFAULTS.colHours],
    [OMS_ENV.colStatus, read(env, OMS_ENV.colStatus) || DEFAULTS.colStatus],
  ];
  for (const [envName, value] of required) {
    if (!isSafeOmsIdentifier(value)) {
      return { ok: false, reason: `${envName} is not a valid table/column name`, missing: [envName] };
    }
  }

  // Optional columns: an explicitly EMPTY value disables the column; unset = default.
  const optional = (envName: string, fallback: string): string | null => {
    const raw = env[envName];
    if (raw === undefined) return fallback;
    const v = raw.trim();
    return v ? v : null;
  };
  const payWeek = optional(OMS_ENV.colPayWeek, DEFAULTS.colPayWeek);
  const updatedAt = optional(OMS_ENV.colUpdatedAt, DEFAULTS.colUpdatedAt);
  for (const [envName, value] of [[OMS_ENV.colPayWeek, payWeek], [OMS_ENV.colUpdatedAt, updatedAt]] as const) {
    if (value !== null && !isSafeOmsIdentifier(value)) {
      return { ok: false, reason: `${envName} is not a valid column name`, missing: [envName] };
    }
  }

  return {
    ok: true,
    config: {
      url: url.replace(/\/+$/, ''),
      key,
      table: required[0][1],
      cols: {
        weekStart: required[1][1],
        email: required[2][1],
        hours: required[3][1],
        status: required[4][1],
        payWeek,
        updatedAt,
      },
      approvedValue: read(env, OMS_ENV.approvedValue) || DEFAULTS.approvedValue,
    },
  };
}
