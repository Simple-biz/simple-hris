/**
 * The hiring database — connection + schema configuration, from env.
 *
 * A SEPARATE Supabase project holds the hires the recruiters record; the New Hire
 * Checklist polls it (docs/features/new-hire-source-sync.md). The HRIS only ever
 * READS it. Everything here is server-only: none of these names carries
 * `NEXT_PUBLIC_`, and the routes that use them return rows, never this object.
 *
 * Identifiers (table and column names) come from env so the source can rename
 * without a deploy, but every one is regex-checked before it reaches a query
 * builder — a column name is never interpolated raw — and a bad one is refused BY
 * VARIABLE NAME, its value never echoed (the OMS precedent, oms-config.ts).
 *
 * `HRIS_HIRES_TABLE` has NO default, on purpose: the table name is the one thing
 * only the source's owner can give us (15 likely names were probed on 2026-10-08
 * and none exist), and a sync must never read a guessed table.
 */

const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

/** The ten checklist fields, in checklist order, mapped from source columns. */
export const HIRES_SOURCE_FIELDS = [
  'name',
  'personal_email',
  'location',
  'phone_number',
  'date_of_interview',
  'source',
  'referred_by',
  'hired_by',
  'department',
  'country',
] as const;

export type HiresSourceField = (typeof HIRES_SOURCE_FIELDS)[number];

export interface HiresSourceConfig {
  url: string;
  key: string;
  table: string;
  /** The source row's stable unique id — becomes our `source_key`. */
  idColumn: string;
  /** Checklist field → source column. */
  cols: Record<HiresSourceField, string>;
  /** Optional: the source's own created / updated stamps. null = not read. */
  createdAtColumn: string | null;
  updatedAtColumn: string | null;
}

export type HiresSourceConfigResult =
  | { ok: true; config: HiresSourceConfig }
  | { ok: false; reason: string; missing: string[] };

export const HIRES_SOURCE_ENV = {
  url: 'HRIS_HIRES_SUPABASE_URL',
  key: 'HRIS_HIRES_SUPABASE_KEY',
  table: 'HRIS_HIRES_TABLE',
  colId: 'HRIS_HIRES_COL_ID',
  colCreatedAt: 'HRIS_HIRES_COL_CREATED_AT',
  colUpdatedAt: 'HRIS_HIRES_COL_UPDATED_AT',
} as const;

/** Field → its env variable and the default column (the names Kane gave on 2026-10-08). */
export const HIRES_SOURCE_COLUMN_ENV: Record<HiresSourceField, { env: string; fallback: string }> = {
  name: { env: 'HRIS_HIRES_COL_NAME', fallback: 'name' },
  personal_email: { env: 'HRIS_HIRES_COL_PERSONAL_EMAIL', fallback: 'personalEmail' },
  location: { env: 'HRIS_HIRES_COL_LOCATION', fallback: 'location' },
  phone_number: { env: 'HRIS_HIRES_COL_PHONE_NUMBER', fallback: 'phoneNumber' },
  date_of_interview: { env: 'HRIS_HIRES_COL_DATE_OF_INTERVIEW', fallback: 'dateOfInterview' },
  source: { env: 'HRIS_HIRES_COL_HIRING_SOURCE', fallback: 'hiringSource' },
  referred_by: { env: 'HRIS_HIRES_COL_REFERRED_BY', fallback: 'referredBy' },
  hired_by: { env: 'HRIS_HIRES_COL_HIRED_BY', fallback: 'hiredBy' },
  department: { env: 'HRIS_HIRES_COL_DEPARTMENT', fallback: 'department' },
  country: { env: 'HRIS_HIRES_COL_COUNTRY', fallback: 'country' },
};

export function isSafeHiresIdentifier(name: string): boolean {
  return SAFE_IDENT.test(name);
}

type Env = Record<string, string | undefined>;

function read(env: Env, name: string): string {
  return (env[name] ?? '').trim();
}

/**
 * Read and validate the hiring-database configuration. A missing URL, key or
 * table is "not set up" (the strip says so and names the variables); a malformed
 * identifier is refused by name so the wrong value can be found in the env file.
 */
export function readHiresSourceConfig(env: Env = process.env): HiresSourceConfigResult {
  const url = read(env, HIRES_SOURCE_ENV.url);
  const key = read(env, HIRES_SOURCE_ENV.key);
  const table = read(env, HIRES_SOURCE_ENV.table);
  const missing: string[] = [];
  if (!url) missing.push(HIRES_SOURCE_ENV.url);
  if (!key) missing.push(HIRES_SOURCE_ENV.key);
  if (!table) missing.push(HIRES_SOURCE_ENV.table);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `The hires sync is not set up — set ${missing.join(' and ')}`,
      missing,
    };
  }
  if (!/^https?:\/\/[^\s]+$/i.test(url)) {
    return { ok: false, reason: `${HIRES_SOURCE_ENV.url} is not a URL`, missing: [HIRES_SOURCE_ENV.url] };
  }

  const checked: Array<[envName: string, value: string]> = [
    [HIRES_SOURCE_ENV.table, table],
    [HIRES_SOURCE_ENV.colId, read(env, HIRES_SOURCE_ENV.colId) || 'id'],
  ];
  const cols = {} as Record<HiresSourceField, string>;
  for (const f of HIRES_SOURCE_FIELDS) {
    const { env: envName, fallback } = HIRES_SOURCE_COLUMN_ENV[f];
    const value = read(env, envName) || fallback;
    cols[f] = value;
    checked.push([envName, value]);
  }
  for (const [envName, value] of checked) {
    if (!isSafeHiresIdentifier(value)) {
      return { ok: false, reason: `${envName} is not a valid table/column name`, missing: [envName] };
    }
  }

  // Optional stamps: unset or empty = not read.
  const optional = (envName: string): string | null => read(env, envName) || null;
  const createdAtColumn = optional(HIRES_SOURCE_ENV.colCreatedAt);
  const updatedAtColumn = optional(HIRES_SOURCE_ENV.colUpdatedAt);
  for (const [envName, value] of [
    [HIRES_SOURCE_ENV.colCreatedAt, createdAtColumn],
    [HIRES_SOURCE_ENV.colUpdatedAt, updatedAtColumn],
  ] as const) {
    if (value !== null && !isSafeHiresIdentifier(value)) {
      return { ok: false, reason: `${envName} is not a valid column name`, missing: [envName] };
    }
  }

  return {
    ok: true,
    config: {
      url: url.replace(/\/+$/, ''),
      key,
      table,
      idColumn: checked[1]![1],
      cols,
      createdAtColumn,
      updatedAtColumn,
    },
  };
}
