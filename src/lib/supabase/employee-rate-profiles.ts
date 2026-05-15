import { normEmail } from "@/lib/email/norm-email";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "./server";
import { isSafeTableName, listPublicTableNames } from "./list-public-tables";
import { fetchActiveHslDetailsByEmail } from "./hsl-agents";

type RawRow = Record<string, unknown>;

export type EmployeeRateProfile = {
  id: string;
  displayName: string;
  /** Single primary email (work preferred over personal). */
  subtitle: string | null;
  /** Department line for modal header (pulled out of fields). */
  department: string | null;
  /** Organization / company name (pulled out of fields). */
  organization: string | null;
  /** Resolved work email, if any. Lifted out of fields during finalize. */
  workEmail: string | null;
  /** Resolved personal email, if any. Lifted out of fields during finalize. */
  personalEmail: string | null;
  fields: { key: string; value: unknown }[];
};

export type EmployeeRateProfileSummary = {
  id: string;
  displayName: string;
  subtitle: string | null;
  department: string | null;
  organization: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  employeeId: string | null;
  regularRate: string | null;
  otRate: string | null;
  suspended: boolean;
  profilePhotoUrl: string | null;
  /** Google Workspace photo URL — populated by NextAuth jwt callback on sign-in. */
  googlePhotoUrl: string | null;
  hasRatesRow: boolean;
  /** MESA Program member — ₱100 deducted from every paycheck when true. */
  mesaMember: boolean;
  /** Synced from `active_hsl_agents` ("Department/Role" column) when this employee
   *  is in the HSL roster. Surfaced as a chip on the Rates card. Null otherwise. */
  hslRole?: string | null;
};

export type GetEmployeeRateProfilesResult = {
  profiles: EmployeeRateProfile[];
  error: string | null;
  /** Tables that failed to load or were excluded from merge (for UI). */
  mergeNotes: string[];
};

export type GetEmployeeRateProfileSummariesResult = {
  profiles: EmployeeRateProfileSummary[];
  error: string | null;
  mergeNotes: string[];
};

function getField(row: RawRow, keys: string[]): unknown {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(row, k)) {
      const v = row[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    }
  }
  return undefined;
}

function toStr(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function normFieldKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
}

function normalizeName(s: string | null | undefined): string | null {
  const t = s?.trim().toLowerCase();
  return t || null;
}

type EmployeeIdentity = {
  emails: Set<string>;
  nameNorm: string | null;
};

function buildIdentity(mergedRates: RawRow, master: RawRow | null): EmployeeIdentity {
  const emails = new Set<string>();
  const add = (v: unknown) => {
    const n = normEmail(toStr(v));
    if (n) emails.add(n);
  };
  add(getField(mergedRates, ["Work Email", "work_email", "Work_Email"]));
  add(getField(mergedRates, ["Personal Email", "personal_email", "Personal_Email"]));
  if (master) {
    add(getField(master, ["Personal Email", "personal_email", "Personal_Email"]));
    add(getField(master, ["Work Email", "work_email", "Work_Email"]));
  }
  const nameNorm =
    normalizeName(
      toStr(getField(mergedRates, ["Name", "name", "Full Name", "full_name"])) ||
        (master ? toStr(getField(master, ["Name", "name"])) : ""),
    ) || null;
  return { emails, nameNorm };
}

/** Collect normalized emails from columns whose name looks like an email field. */
function collectEmailsFromRow(row: RawRow): Set<string> {
  const set = new Set<string>();
  for (const [k, v] of Object.entries(row)) {
    const lk = k.toLowerCase();
    if (lk.includes("email") || lk === "email") {
      const n = normEmail(toStr(v));
      if (n) set.add(n);
    }
  }
  return set;
}

function rowMatchesEmployee(row: RawRow, id: EmployeeIdentity): boolean {
  if (id.emails.size === 0 && !id.nameNorm) return false;
  const rowEmails = collectEmailsFromRow(row);
  for (const e of rowEmails) {
    if (id.emails.has(e)) return true;
  }
  for (const e of id.emails) {
    if (rowEmails.has(e)) return true;
  }
  if (id.nameNorm) {
    const rn = normalizeName(
      toStr(
        getField(row, ["Name", "name", "Member", "member", "Full Name", "full_name"]),
      ),
    );
    if (rn && rn === id.nameNorm) return true;
  }
  return false;
}

function mergeRowsUniqueFieldOrder(rows: RawRow[]): RawRow {
  const out: RawRow = {};
  const seen = new Set<string>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      const nk = normFieldKey(k);
      if (seen.has(nk)) continue;
      seen.add(nk);
      out[k] = v;
    }
  }
  return out;
}

/**
 * For `hubstaff_hours` profile merge: pass through Job Title, Job Type, and Organization.
 */
function filterHubstaffRowToAllowedFields(row: RawRow): RawRow {
  const out: RawRow = {};
  for (const [k, v] of Object.entries(row)) {
    const nk = normFieldKey(k);
    if (nk === "job_title" || nk === "jobtitle") {
      out["Job Title"] = v;
    } else if (nk === "job_type" || nk === "jobtype") {
      out["Job Type"] = v;
    } else if (nk === "organization" || nk === "organisation" || nk === "org") {
      out["Organization"] = v;
    }
  }
  return out;
}

/** First non-empty Hubstaff `Member` (display name for Rates UI). */
function pickMemberFromHubstaffRows(rows: RawRow[]): string | null {
  for (const row of rows) {
    const v = getField(row, ["Member", "member", "MEMBER"]);
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

/**
 * Merge sources in order; first occurrence of a logical column name wins (no duplicate keys).
 */
function mergeSourcesDeduped(orderedSources: RawRow[]): { key: string; value: unknown }[] {
  const seen = new Set<string>();
  const fields: { key: string; value: unknown }[] = [];
  for (const row of orderedSources) {
    for (const [k, v] of Object.entries(row)) {
      const nk = normFieldKey(k);
      if (seen.has(nk)) continue;
      // Don't let a null / empty-string value "claim" the key from later sources.
      // Symptom this guards against: rates row has `Department: null`, master row
      // has `Department: "Accounting Team"`. Without this skip, the rates null
      // wins and the dept chip disappears from the Rates card. Apply the same
      // rule to every field — later sources should always be able to fill gaps.
      if (v == null) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      seen.add(nk);
      fields.push({ key: k, value: v });
    }
  }
  return fields;
}

const EXCLUDED_PROFILE_FIELD_KEYS = new Set([
  "teamindex",
  "team_index",
  "created_at",
  "createdat",
]);

function isEmailFieldKey(nk: string): boolean {
  if (nk === "email") return true;
  if (nk === "work_email" || nk === "personal_email" || nk === "user_email") return true;
  if (nk.endsWith("_email")) return true;
  return false;
}

function emailFieldPriority(nk: string): number {
  if (nk === "work_email") return 100;
  if (nk.includes("work") && nk.includes("email")) return 95;
  if (nk === "email") return 80;
  if (nk === "personal_email") return 60;
  if (nk.includes("personal") && nk.includes("email")) return 55;
  return 40;
}

/**
 * Drop noisy columns, lift department and organization for header, collapse all email columns to one "Email".
 */
function finalizeProfileFields(rawFields: { key: string; value: unknown }[]): {
  fields: { key: string; value: unknown }[];
  department: string | null;
  organization: string | null;
  primaryEmail: string | null;
  workEmail: string | null;
  personalEmail: string | null;
} {
  let fields = rawFields.filter((f) => !EXCLUDED_PROFILE_FIELD_KEYS.has(normFieldKey(f.key)));

  let department: string | null = null;
  const deptNorm = new Set(["department", "dept"]);
  fields = fields.filter((f) => {
    const nk = normFieldKey(f.key);
    if (deptNorm.has(nk)) {
      const s = toStr(f.value);
      if (s && department == null) department = s;
      return false;
    }
    return true;
  });

  let organization: string | null = null;
  const orgNorm = new Set(["organization", "organisation", "org", "company", "client"]);
  fields = fields.filter((f) => {
    const nk = normFieldKey(f.key);
    if (orgNorm.has(nk)) {
      const s = toStr(f.value);
      if (s && organization == null) organization = s;
      return false;
    }
    return true;
  });

  const emailRows: { nk: string; value: unknown }[] = [];
  const nonEmail: typeof fields = [];
  for (const f of fields) {
    const nk = normFieldKey(f.key);
    if (isEmailFieldKey(nk)) {
      emailRows.push({ nk, value: f.value });
    } else {
      nonEmail.push(f);
    }
  }
  emailRows.sort((a, b) => emailFieldPriority(b.nk) - emailFieldPriority(a.nk));

  let workEmail: string | null = null;
  let personalEmail: string | null = null;
  for (const e of emailRows) {
    const raw = toStr(e.value);
    if (!normEmail(raw)) continue;
    const nk = e.nk;
    const isPersonal = nk === "personal_email" || (nk.includes("personal") && nk.includes("email"));
    const isWork = nk === "work_email" || (nk.includes("work") && nk.includes("email"));
    if (isPersonal && !personalEmail) personalEmail = raw;
    else if (isWork && !workEmail) workEmail = raw;
    else if (!workEmail && !isPersonal) workEmail = raw;
  }
  const primaryEmail = workEmail ?? personalEmail;

  fields = nonEmail;
  /* Emails are only in subtitle / dedicated fields — not repeated as a body field. */

  return { fields, department, organization, primaryEmail, workEmail, personalEmail };
}

function masterIdentityKey(master: RawRow): string | null {
  const w = normEmail(toStr(getField(master, ["Work Email", "work_email", "Work_Email"])));
  const p = normEmail(toStr(getField(master, ["Personal Email", "personal_email", "Personal_Email"])));
  const n = normalizeName(toStr(getField(master, ["Name", "name"])));
  if (w) return `master:${w}`;
  if (p) return `master:${p}`;
  if (n) return `master:${n}`;
  return null;
}

function rateGroupKey(row: RawRow, rowIndex: number, master: RawRow | null = null): string {
  const masterKey = master ? masterIdentityKey(master) : null;
  if (masterKey) return masterKey;
  const p = normEmail(toStr(getField(row, ["Personal Email", "personal_email", "Personal_Email"])));
  const w = normEmail(toStr(getField(row, ["Work Email", "work_email", "Work_Email"])));
  if (p) return `e:${p}`;
  if (w) return `e:${w}`;
  return `row:${rowIndex}`;
}

function rowHasUsableRate(row: RawRow, keys: string[]): boolean {
  return keys.some((key) => {
    const v = getField(row, [key]);
    return v !== undefined && v !== null && String(v).trim() !== "";
  });
}

function rateRowPriority(row: RawRow, currentUploadId: string | null): number {
  let score = 0;
  const uploadId = toStr(getField(row, ["upload_id"]));
  if (currentUploadId && uploadId === currentUploadId) score += 1000;
  if (rowHasUsableRate(row, ["Regular Rate", "regular_rate", "Regular_Rate"])) score += 100;
  if (rowHasUsableRate(row, ["OT Rate", "ot_rate", "OT_Rate", "Ot Rate"])) score += 50;
  if (normEmail(toStr(getField(row, ["Personal Email", "personal_email", "Personal_Email"])))) {
    score += 10;
  }
  if (normEmail(toStr(getField(row, ["Work Email", "work_email", "Work_Email"])))) {
    score += 5;
  }
  return score;
}

/**
 * Multi-value indexes: two master rows can legitimately share a work_email (dual-role
 * employee listed in two departments). They are only the "same person" when their
 * personal_email also matches. When two masters share work_email but have different
 * personal_email, they are different humans (work_email was recycled after offboarding).
 * The single-value map we used before silently collapsed these cases.
 */
function buildMasterIndexes(rows: RawRow[]): {
  byEmail: Map<string, RawRow[]>;
  byName: Map<string, RawRow[]>;
} {
  const byEmail = new Map<string, RawRow[]>();
  const byName = new Map<string, RawRow[]>();
  const push = <T>(map: Map<string, T[]>, key: string, val: T) => {
    const list = map.get(key);
    if (list) list.push(val);
    else map.set(key, [val]);
  };
  for (const row of rows) {
    const pe = normEmail(toStr(getField(row, ["Personal Email", "personal_email", "Personal_Email"])));
    const we = normEmail(toStr(getField(row, ["Work Email", "work_email", "Work_Email"])));
    if (pe) push(byEmail, pe, row);
    if (we) push(byEmail, we, row);
    const nn = normalizeName(toStr(getField(row, ["Name", "name"])));
    if (nn) push(byName, nn, row);
  }
  return { byEmail, byName };
}

/**
 * Picks the master row that a rate row belongs to.
 *
 *   1. Strong match: a candidate whose personal_email equals the rate's personal_email.
 *   2. Otherwise: the first candidate (work_email match). We do NOT reject a candidate
 *      just because its personal_email differs from the rate's — the rate CSV can
 *      legitimately carry a different/updated personal_email for the same human.
 *      Disambiguation only matters when two masters actually share a work_email,
 *      and that case is handled by the strong-match pass above picking the right one.
 *   3. Name fallback.
 */
function findMasterForMergedRates(
  mergedRates: RawRow,
  byEmail: Map<string, RawRow[]>,
  byName: Map<string, RawRow[]>,
): RawRow | null {
  const ratePersonal = normEmail(
    toStr(getField(mergedRates, ["Personal Email", "personal_email", "Personal_Email"])),
  );
  const rateWork = normEmail(
    toStr(getField(mergedRates, ["Work Email", "work_email", "Work_Email"])),
  );

  const candidates: RawRow[] = [];
  const seen = new Set<RawRow>();
  const pushCandidates = (email: string | null) => {
    if (!email) return;
    const list = byEmail.get(email);
    if (!list) return;
    for (const m of list) {
      if (!seen.has(m)) {
        seen.add(m);
        candidates.push(m);
      }
    }
  };
  pushCandidates(rateWork);
  pushCandidates(ratePersonal);

  if (ratePersonal) {
    for (const m of candidates) {
      const mPersonal = normEmail(
        toStr(getField(m, ["Personal Email", "personal_email", "Personal_Email"])),
      );
      if (mPersonal === ratePersonal) return m;
    }
  }

  if (candidates.length > 0) return candidates[0];

  const nn = normalizeName(
    toStr(getField(mergedRates, ["Name", "name", "Full Name", "full_name"])),
  );
  if (nn) {
    const list = byName.get(nn);
    if (list && list.length > 0) return list[0];
  }
  return null;
}

function resolveDisplayName(mergedRates: RawRow, master: RawRow | null): string {
  const fromMaster = master ? toStr(getField(master, ["Name", "name"])) : "";
  if (fromMaster) return fromMaster;
  const fromRates = toStr(
    getField(mergedRates, ["Name", "name", "Full Name", "full_name"]),
  );
  if (fromRates) return fromRates;
  const em =
    toStr(getField(mergedRates, ["Work Email", "work_email"])) ||
    toStr(getField(mergedRates, ["Personal Email", "personal_email"]));
  return em || "Unknown";
}

function buildEmployeeIdMapFromRows(rows: RawRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const employeeId = toStr(getField(row, ["employee_id"]));
    if (!employeeId) continue;
    const work = normEmail(toStr(getField(row, ["work_email"])));
    const personal = normEmail(toStr(getField(row, ["personal_email"])));
    if (work) map.set(work, employeeId);
    if (personal && !map.has(personal)) map.set(personal, employeeId);
  }
  return map;
}

async function fetchEmployeeIdRowsForProfiles(): Promise<{
  rows: RawRow[];
  error: string | null;
}> {
  const supabase =
    createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return {
      rows: [],
      error:
        "Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to your .env file.",
    };
  }

  const { data, error } = await supabase
    .from("employee_ids")
    .select("employee_id, work_email, personal_email");

  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as RawRow[], error: null };
}

function pickEmployeeId(
  workEmail: string | null,
  personalEmail: string | null,
  primaryEmail: string | null,
  employeeIdMap: Map<string, string>,
  masterRow?: RawRow | null,
): string | null {
  // First preference: the dedicated employee_ids table (bank-info / payment
  // routing). When it has a row for this person, that's the canonical answer.
  for (const email of [workEmail, personalEmail, primaryEmail]) {
    const normalized = normEmail(email);
    if (!normalized) continue;
    const found = employeeIdMap.get(normalized);
    if (found) return found;
  }
  // Fallback: the persisted `employee_id` column on global_master_list (added
  // 2026-05-14 — see references/add_employee_id_to_global_master_list.sql).
  // Most employees don't have an `employee_ids` row yet, so without this fallback
  // the Rates & Profiles ID column shows blank even though we've stamped the
  // master-list column. The column is filled by the backfill route + every
  // upload, so once migrated this resolves universally.
  if (masterRow) {
    const masterId = toStr(getField(masterRow, ["employee_id", "Employee ID", "Employee_ID"]));
    if (masterId) return masterId;
  }
  return null;
}

async function fetchRawFromTable(table: string): Promise<{
  rows: RawRow[];
  error: string | null;
}> {
  const supabase =
    createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return {
      rows: [],
      error:
        "Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to your .env file.",
    };
  }
  if (!isSafeTableName(table)) {
    return { rows: [], error: "Invalid table name" };
  }
  // Paginate — hubstaff_hours and similar tables easily exceed the 1000-row
  // PostgREST default and would otherwise be silently truncated.
  const PAGE = 1000;
  const rows: RawRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .range(from, from + PAGE - 1);
    if (error) return { rows: [], error: error.message };
    const page = (data ?? []) as RawRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }
  return { rows, error: null };
}

async function getCurrentRatesUploadIdForProfiles(): Promise<string | null> {
  const supabase =
    createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("rates_uploads")
    .select("id")
    .eq("is_current", true)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return ((data as { id?: string } | null)?.id ?? null);
}

async function fetchRatesRowsForProfiles(
  ratesTable: string,
  _currentUploadId: string | null,
): Promise<{ rows: RawRow[]; error: string | null }> {
  const supabase =
    createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return {
      rows: [],
      error:
        "Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to your .env file.",
    };
  }
  if (!isSafeTableName(ratesTable)) {
    return { rows: [], error: "Invalid table name" };
  }

  // Paginate past PostgREST's 1000-row default so we don't lose rate rows
  // when the table grows beyond that. Without pagination, profiles for
  // employees whose rate rows sit past row 1000 silently showed "—".
  const PAGE = 1000;
  const rows: RawRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(ratesTable)
      .select("*")
      .range(from, from + PAGE - 1);
    if (error) return { rows: [], error: error.message };
    const page = (data ?? []) as RawRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }
  return { rows, error: null };
}

/**
 * Master list rows for the currently-active roster. Reads from the `active_employees`
 * view (filters `global_master_list` down to rows whose `last_seen_upload_id` matches
 * the current `master_list_uploads` entry). `masterTable` arg is retained for symmetry
 * with callers that pass the configured table name, but we ignore it in favor of the view.
 */
async function fetchMasterRowsForProfiles(masterTable: string): Promise<{
  rows: RawRow[];
  error: string | null;
}> {
  const supabase =
    createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return {
      rows: [],
      error:
        "Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to your .env file.",
    };
  }
  if (!isSafeTableName(masterTable)) {
    return { rows: [], error: "Invalid table name" };
  }
  // Paginate — active_employees can grow past the 1000-row PostgREST default.
  const PAGE = 1000;
  const rows: RawRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("active_employees")
      .select("*")
      .range(from, from + PAGE - 1);
    if (error) return { rows: [], error: error.message };
    const page = (data ?? []) as RawRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }
  return { rows, error: null };
}

function parseExcludeTables(): Set<string> {
  const raw = process.env.SUPABASE_PROFILE_TABLES_EXCLUDE?.split(",") ?? [];
  return new Set(raw.map((s) => s.trim()).filter(Boolean));
}

/**
 * Tables to merge beyond the baseline (rates + master). When unset: all `public` tables
 * (if DATABASE_URL), else rates + master + hubstaff_hours.
 */
async function resolveMergeTableList(
  ratesTable: string,
  masterTable: string,
): Promise<string[]> {
  const explicit = process.env.SUPABASE_PROFILE_TABLES?.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter(isSafeTableName);

  if (explicit && explicit.length > 0) {
    return [...new Set(explicit)];
  }

  const exclude = parseExcludeTables();
  const fromPg = await listPublicTableNames();
  if (fromPg && fromPg.length > 0) {
    return fromPg.filter((t) => !exclude.has(t));
  }

  const hub =
    process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || "hubstaff_hours";
  return [...new Set([ratesTable, masterTable, hub])];
}

/**
 * In-memory TTL cache for the heavy merge result. Both `getEmployeeRateProfiles`
 * and `getEmployeeRateProfileSummaries` paginate through the rates / master /
 * employee_ids tables and then build merged profiles for every employee — for
 * a per-click profile lookup that's tens of thousands of unnecessary rows.
 *
 * Cache for 60s; invalidate explicitly when the underlying tables change
 * (rate edits, profile edits, suspend toggles, add/delete employee). First
 * call is slow, subsequent calls within the TTL are instant.
 */
const PROFILES_TTL_MS = 60_000;
let cachedFullProfiles: { ts: number; data: GetEmployeeRateProfilesResult } | null = null;
let cachedSummaries: { ts: number; data: GetEmployeeRateProfileSummariesResult } | null = null;

/** Drop both caches. Call from any route that mutates rates / master / ids. */
export function invalidateRateProfilesCache(): void {
  cachedFullProfiles = null;
  cachedSummaries = null;
}

export async function getEmployeeRateProfiles(): Promise<GetEmployeeRateProfilesResult> {
  if (cachedFullProfiles && Date.now() - cachedFullProfiles.ts < PROFILES_TTL_MS) {
    return cachedFullProfiles.data;
  }
  const ratesTable =
    process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() ||
    "employee_hourly_rates";
  const masterTable =
    process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || "global_master_list";
  const hubstaffTable =
    process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || "hubstaff_hours";

  const mergeList = await resolveMergeTableList(ratesTable, masterTable);
  const tablesToFetch = [...new Set([ratesTable, masterTable, ...mergeList])];

  const mergeNotes: string[] = [];
  const byTable = new Map<string, RawRow[]>();
  const currentRatesUploadId = await getCurrentRatesUploadIdForProfiles();

  const fetched = await Promise.all(
    tablesToFetch.map(async (t) => {
      const res =
        t === ratesTable
          ? await fetchRatesRowsForProfiles(t, currentRatesUploadId)
          : t === masterTable
            ? await fetchMasterRowsForProfiles(t)
            : await fetchRawFromTable(t);
      return { t, res };
    }),
  );

  for (const { t, res } of fetched) {
    if (res.error) {
      mergeNotes.push(`Skipped ${t}: ${res.error}`);
      continue;
    }
    byTable.set(t, res.rows);
  }

  const ratesRaw = byTable.get(ratesTable);
  if (!ratesRaw) {
    return {
      profiles: [],
      error: `Could not load ${ratesTable}. Check RLS/service role or table name.`,
      mergeNotes,
    };
  }
  if (currentRatesUploadId) {
    mergeNotes.push(
      `Using current rates upload: ${currentRatesUploadId} (historical rows kept as fallback when current batch is incomplete).`,
    );
  } else {
    mergeNotes.push("No current rates_uploads row found; using all employee_hourly_rates rows.");
  }

  const masterRaw = byTable.get(masterTable) ?? [];
  const { byEmail, byName } = buildMasterIndexes(masterRaw);

  const extraMergeTables = [...mergeList]
    .filter((t) => t !== ratesTable && t !== masterTable)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const groupMap = new Map<string, RawRow[]>();
  ratesRaw.forEach((row, i) => {
    const master = findMasterForMergedRates(row, byEmail, byName);
    const k = rateGroupKey(row, i, master);
    if (!groupMap.has(k)) groupMap.set(k, []);
    groupMap.get(k)!.push(row);
  });

  const profiles: EmployeeRateProfile[] = [];
  const matchedMasters = new Set<RawRow>();
  const usedIds = new Set<string>();
  const uniqueId = (base: string): string => {
    if (!usedIds.has(base)) {
      usedIds.add(base);
      return base;
    }
    for (let n = 2; ; n++) {
      const candidate = `${base}#${n}`;
      if (!usedIds.has(candidate)) {
        usedIds.add(candidate);
        return candidate;
      }
    }
  };

  for (const [groupId, groupRows] of groupMap) {
    const orderedGroupRows = [...groupRows].sort(
      (a, b) => rateRowPriority(b, currentRatesUploadId) - rateRowPriority(a, currentRatesUploadId),
    );
    const mergedRates = mergeRowsUniqueFieldOrder(orderedGroupRows);
    const master = findMasterForMergedRates(mergedRates, byEmail, byName);
    // Same master-list-only rule as the summary path: drop rates rows that
    // don't match a master row, and skip placeholder master rows without a Name.
    if (!master) continue;
    if (!toStr(getField(master, ["Name", "name"]))) continue;
    matchedMasters.add(master);
    const identity = buildIdentity(mergedRates, master);

    const sources: RawRow[] = [mergedRates, master ?? {}];

    let memberFromHubstaff: string | null = null;
    for (const tableName of extraMergeTables) {
      const rows = byTable.get(tableName);
      if (!rows || rows.length === 0) continue;
      const matching = rows.filter((r) => rowMatchesEmployee(r, identity));
      if (matching.length === 0) continue;
      if (tableName === hubstaffTable) {
        memberFromHubstaff = pickMemberFromHubstaffRows(matching);
      }
      let merged = mergeRowsUniqueFieldOrder(matching);
      if (tableName === hubstaffTable) {
        merged = filterHubstaffRowToAllowedFields(merged);
      }
      if (Object.keys(merged).length === 0) continue;
      sources.push(merged);
    }

    const rawFields = mergeSourcesDeduped(sources);
    const { fields, department, organization, primaryEmail, workEmail, personalEmail } =
      finalizeProfileFields(rawFields);
    const displayName =
      memberFromHubstaff || resolveDisplayName(mergedRates, master);

    profiles.push({
      id: uniqueId(groupId),
      displayName,
      subtitle: primaryEmail,
      department,
      organization,
      workEmail,
      personalEmail,
      fields,
    });
  }

  // Build a rate-row lookup keyed by every email on each rate row. Used below to
  // fill in rates for master rows that didn't "win" the byEmail collision
  // (dual-role employees who share a work_email across two department rows, or
  // recycled work_emails where two active humans share a seat email).
  const rateRowsByEmail = new Map<string, RawRow[]>();
  const pushRateByEmail = (email: string | null, r: RawRow) => {
    if (!email) return;
    const list = rateRowsByEmail.get(email);
    if (list) list.push(r);
    else rateRowsByEmail.set(email, [r]);
  };
  for (const rateRow of ratesRaw) {
    const we = normEmail(toStr(getField(rateRow, ["Work Email", "work_email", "Work_Email"])));
    const pe = normEmail(toStr(getField(rateRow, ["Personal Email", "personal_email", "Personal_Email"])));
    pushRateByEmail(we, rateRow);
    pushRateByEmail(pe, rateRow);
  }

  // Precompute: for each rate row that STRONGLY matches (personal_email match)
  // any master row, the set of masters it strongly matches. Used in the second
  // pass so rates with a clear owner don't leak to other masters — but rates
  // without a clear owner still reach the single master who matches by work_email.
  const rateToStrongMasters = new Map<RawRow, Set<RawRow>>();
  for (const rateRow of ratesRaw) {
    const rPersonal = normEmail(
      toStr(getField(rateRow, ["Personal Email", "personal_email", "Personal_Email"])),
    );
    if (!rPersonal) continue;
    const mastersWithEmail = byEmail.get(rPersonal);
    if (!mastersWithEmail) continue;
    let strongSet: Set<RawRow> | null = null;
    for (const m of mastersWithEmail) {
      const mPersonal = normEmail(
        toStr(getField(m, ["Personal Email", "personal_email", "Personal_Email"])),
      );
      if (mPersonal === rPersonal) {
        if (!strongSet) strongSet = new Set<RawRow>();
        strongSet.add(m);
      }
    }
    if (strongSet) rateToStrongMasters.set(rateRow, strongSet);
  }

  // Second pass: include master-list employees whose master row was not the
  // "winner" in the first pass. Their rate fields now come from a direct
  // email lookup against rateRowsByEmail, so dual-role + recycled-email
  // employees still show their rate instead of falling through to "—".
  for (let i = 0; i < masterRaw.length; i++) {
    const masterRow = masterRaw[i];
    if (matchedMasters.has(masterRow)) continue;
    // Skip placeholder master rows (no Name set) — these are work-email-only
    // stubs that bloated the Rates & Profiles list with junk entries.
    if (!toStr(getField(masterRow, ["Name", "name"]))) continue;

    const mPersonal = normEmail(
      toStr(getField(masterRow, ["Personal Email", "personal_email", "Personal_Email"])),
    );
    const mWork = normEmail(
      toStr(getField(masterRow, ["Work Email", "work_email", "Work_Email"])),
    );
    const masterEmails = [mWork, mPersonal].filter((x): x is string => Boolean(x));

    const seenRateIds = new Set<unknown>();
    const matchingRateRows: RawRow[] = [];
    for (const email of masterEmails) {
      const rows = rateRowsByEmail.get(email);
      if (!rows) continue;
      for (const r of rows) {
        const rid = (r as { id?: unknown }).id;
        if (rid !== undefined && seenRateIds.has(rid)) continue;

        // Conflict check: if this rate STRONGLY matches a DIFFERENT master
        // (same personal_email as another master row), don't steal it. This
        // handles the Jane/Janine case where both masters share a work_email
        // but the rate row's personal_email identifies a specific human.
        // Rates with no strong owner fall through and match by work_email —
        // important for the common case where master has an outdated
        // personal_email but the rate still belongs to them.
        const strongMasters = rateToStrongMasters.get(r);
        if (strongMasters && !strongMasters.has(masterRow)) continue;

        if (rid !== undefined) seenRateIds.add(rid);
        matchingRateRows.push(r);
      }
    }

    const mergedRates: RawRow =
      matchingRateRows.length > 0
        ? mergeRowsUniqueFieldOrder(
            [...matchingRateRows].sort(
              (a, b) =>
                rateRowPriority(b, currentRatesUploadId) -
                rateRowPriority(a, currentRatesUploadId),
            ),
          )
        : {};

    const identity = buildIdentity(mergedRates, masterRow);
    const sources: RawRow[] = [mergedRates, masterRow];

    let memberFromHubstaff: string | null = null;
    for (const tableName of extraMergeTables) {
      const rows = byTable.get(tableName);
      if (!rows || rows.length === 0) continue;
      const matching = rows.filter((r) => rowMatchesEmployee(r, identity));
      if (matching.length === 0) continue;
      if (tableName === hubstaffTable) {
        memberFromHubstaff = pickMemberFromHubstaffRows(matching);
      }
      let merged = mergeRowsUniqueFieldOrder(matching);
      if (tableName === hubstaffTable) {
        merged = filterHubstaffRowToAllowedFields(merged);
      }
      if (Object.keys(merged).length === 0) continue;
      sources.push(merged);
    }

    const rawFields = mergeSourcesDeduped(sources);
    const { fields, department, organization, primaryEmail, workEmail, personalEmail } =
      finalizeProfileFields(rawFields);
    const displayName = memberFromHubstaff || resolveDisplayName(mergedRates, masterRow);

    const idEmail = [...identity.emails][0] || identity.nameNorm || `row-${i}`;
    profiles.push({
      id: uniqueId(`master:${idEmail}`),
      displayName,
      subtitle: primaryEmail,
      department,
      organization,
      workEmail,
      personalEmail,
      fields,
    });
  }

  profiles.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
  );

  const result = { profiles, error: null, mergeNotes };
  cachedFullProfiles = { ts: Date.now(), data: result };
  return result;
}

/* ───────── focused single-employee fast path ─────────
 *
 * `getEmployeeRateProfiles()` paginates through every row of `employee_hourly_rates`,
 * `active_employees`, and the configured extra merge tables — then runs the full
 * merge across all employees just so the per-profile dialog can `.find()` one of
 * them by email. For a single dialog open that's literally tens of thousands of
 * rows of wasted I/O.
 *
 * `getEmployeeRateProfileByEmail` does focused parallel `.ilike` queries
 * filtered to the input email (and any alternate emails the rates/master rows
 * reveal), then runs the same merge helpers on that small dataset. Hubstaff
 * member-name resolution and exotic SUPABASE_PROFILE_TABLES merging are skipped
 * here — the dialog gets its display name from the master/rates row, which is
 * how the summary card already labels the row.
 */

/**
 * Run parallel `.ilike` queries across every (column × email) pair and dedupe
 * by row id (or row JSON when no id is present). Returns rows from one table.
 */
async function fetchRowsByEmails(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  table: string,
  emails: string[],
  emailColumns: string[],
): Promise<{ rows: RawRow[]; error: string | null }> {
  if (!supabase) return { rows: [], error: null };
  if (emails.length === 0 || emailColumns.length === 0) return { rows: [], error: null };

  const queries: Promise<{ data: RawRow[] | null; error: { message: string } | null }>[] = [];
  for (const column of emailColumns) {
    for (const email of emails) {
      queries.push(
        supabase
          .from(table)
          .select("*")
          .ilike(column, email)
          .limit(50) as unknown as Promise<{ data: RawRow[] | null; error: { message: string } | null }>,
      );
    }
  }

  const results = await Promise.all(queries);

  const seen = new Set<string>();
  const rows: RawRow[] = [];
  let firstError: string | null = null;
  for (const { data, error } of results) {
    if (error) {
      firstError = firstError ?? error.message;
      continue;
    }
    for (const row of data ?? []) {
      const id = (row as { id?: unknown }).id;
      const key = id !== undefined && id !== null ? `id:${String(id)}` : `json:${JSON.stringify(row)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  return { rows, error: firstError };
}

/** Pull every email referenced by a rate/master row (Work + Personal). */
function emailsFromRow(row: RawRow): string[] {
  const out: string[] = [];
  const we = normEmail(toStr(getField(row, ["Work Email", "work_email", "Work_Email"])));
  const pe = normEmail(toStr(getField(row, ["Personal Email", "personal_email", "Personal_Email"])));
  if (we) out.push(we);
  if (pe) out.push(pe);
  return out;
}

export async function getEmployeeRateProfileByEmail(
  emailInput: string,
): Promise<{ profile: EmployeeRateProfile | null; error: string | null; mergeNotes: string[] }> {
  const norm = normEmail(emailInput);
  if (!norm) return { profile: null, error: null, mergeNotes: [] };

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { profile: null, error: "Supabase client unavailable", mergeNotes: [] };
  }

  const ratesTable =
    process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() ||
    "employee_hourly_rates";

  // Step 1: parallel focused fetch — rates + master rows that match the input email.
  const [ratesInitial, masterInitial, currentRatesUploadId] = await Promise.all([
    fetchRowsByEmails(supabase, ratesTable, [norm], ["Work Email", "Personal Email"]),
    fetchRowsByEmails(supabase, "active_employees", [norm], ["Work Email", "Personal Email"]),
    getCurrentRatesUploadIdForProfiles(),
  ]);

  // Step 2: discover alternate emails from those rows.
  const allEmails = new Set<string>([norm]);
  for (const row of [...ratesInitial.rows, ...masterInitial.rows]) {
    for (const e of emailsFromRow(row)) allEmails.add(e);
  }
  const altEmails = [...allEmails].filter((e) => e !== norm);

  // Step 3: if alternates revealed, fetch any additional rate/master rows
  //         keyed on those alternates (e.g. user looked up by Personal but
  //         the rate row is keyed on Work).
  let rates = ratesInitial.rows;
  let masters = masterInitial.rows;
  if (altEmails.length > 0) {
    const [moreRates, moreMasters] = await Promise.all([
      fetchRowsByEmails(supabase, ratesTable, altEmails, ["Work Email", "Personal Email"]),
      fetchRowsByEmails(supabase, "active_employees", altEmails, ["Work Email", "Personal Email"]),
    ]);
    if (moreRates.rows.length > 0) {
      const seen = new Set<string>();
      const merged: RawRow[] = [];
      for (const r of [...rates, ...moreRates.rows]) {
        const id = (r as { id?: unknown }).id;
        const key = id !== undefined && id !== null ? `id:${String(id)}` : `json:${JSON.stringify(r)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(r);
      }
      rates = merged;
    }
    if (moreMasters.rows.length > 0) {
      const seen = new Set<string>();
      const merged: RawRow[] = [];
      for (const r of [...masters, ...moreMasters.rows]) {
        const id = (r as { id?: unknown }).id;
        const key = id !== undefined && id !== null ? `id:${String(id)}` : `json:${JSON.stringify(r)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(r);
      }
      masters = merged;
    }
  }

  if (rates.length === 0 && masters.length === 0) {
    return { profile: null, error: null, mergeNotes: [] };
  }

  // Step 4: run the existing merge helpers on this tiny set.
  const orderedRates = [...rates].sort(
    (a, b) => rateRowPriority(b, currentRatesUploadId) - rateRowPriority(a, currentRatesUploadId),
  );
  const mergedRates =
    orderedRates.length > 0 ? mergeRowsUniqueFieldOrder(orderedRates) : ({} as RawRow);

  const { byEmail, byName } = buildMasterIndexes(masters);
  const master =
    Object.keys(mergedRates).length > 0
      ? findMasterForMergedRates(mergedRates, byEmail, byName)
      : (masters[0] ?? null);

  const sources: RawRow[] = [mergedRates, master ?? {}];
  const rawFields = mergeSourcesDeduped(sources);
  const { fields, department, organization, primaryEmail, workEmail, personalEmail } =
    finalizeProfileFields(rawFields);
  const displayName = resolveDisplayName(mergedRates, master);

  const id = rateGroupKey(mergedRates, 0, master);

  return {
    profile: {
      id,
      displayName,
      subtitle: primaryEmail,
      department,
      organization,
      workEmail,
      personalEmail,
      fields,
    },
    error: null,
    mergeNotes: [],
  };
}

export async function getEmployeeRateProfileSummaries(): Promise<GetEmployeeRateProfileSummariesResult> {
  if (cachedSummaries && Date.now() - cachedSummaries.ts < PROFILES_TTL_MS) {
    return cachedSummaries.data;
  }
  const ratesTable =
    process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() ||
    "employee_hourly_rates";
  const masterTable =
    process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || "global_master_list";

  const mergeNotes: string[] = [];
  const currentRatesUploadId = await getCurrentRatesUploadIdForProfiles();

  const [ratesRes, masterRes, idsRes, hslRes] = await Promise.all([
    fetchRatesRowsForProfiles(ratesTable, currentRatesUploadId),
    fetchMasterRowsForProfiles(masterTable),
    fetchEmployeeIdRowsForProfiles(),
    // Pulled in parallel — if the active_hsl_agents view is missing (migration
    // not yet run), we just skip decoration instead of failing the whole load.
    fetchActiveHslDetailsByEmail(),
  ]);

  if (ratesRes.error) {
    return {
      profiles: [],
      error: `Could not load ${ratesTable}. Check RLS/service role or table name.`,
      mergeNotes: masterRes.error ? [`Skipped ${masterTable}: ${masterRes.error}`] : [],
    };
  }

  if (masterRes.error) mergeNotes.push(`Skipped ${masterTable}: ${masterRes.error}`);
  if (idsRes.error) mergeNotes.push(`Skipped employee_ids: ${idsRes.error}`);
  if (hslRes.error) mergeNotes.push(`Skipped active_hsl_agents: ${hslRes.error}`);

  if (currentRatesUploadId) {
    mergeNotes.push(
      `Using current rates upload: ${currentRatesUploadId} (historical rows kept as fallback when current batch is incomplete).`,
    );
  } else {
    mergeNotes.push("No current rates_uploads row found; using all employee_hourly_rates rows.");
  }

  const ratesRaw = ratesRes.rows;
  const masterRaw = masterRes.rows;
  const employeeIdMap = buildEmployeeIdMapFromRows(idsRes.rows);
  const { byEmail, byName } = buildMasterIndexes(masterRaw);

  const groupMap = new Map<string, RawRow[]>();
  ratesRaw.forEach((row, i) => {
    const master = findMasterForMergedRates(row, byEmail, byName);
    const k = rateGroupKey(row, i, master);
    if (!groupMap.has(k)) groupMap.set(k, []);
    groupMap.get(k)!.push(row);
  });

  const profiles: EmployeeRateProfileSummary[] = [];
  const matchedMasters = new Set<RawRow>();
  const usedIds = new Set<string>();
  const uniqueId = (base: string): string => {
    if (!usedIds.has(base)) {
      usedIds.add(base);
      return base;
    }
    for (let n = 2; ; n++) {
      const candidate = `${base}#${n}`;
      if (!usedIds.has(candidate)) {
        usedIds.add(candidate);
        return candidate;
      }
    }
  };

  for (const [groupId, groupRows] of groupMap) {
    const orderedGroupRows = [...groupRows].sort(
      (a, b) => rateRowPriority(b, currentRatesUploadId) - rateRowPriority(a, currentRatesUploadId),
    );
    const mergedRates = mergeRowsUniqueFieldOrder(orderedGroupRows);
    const master = findMasterForMergedRates(mergedRates, byEmail, byName);
    // Master list is the single source of truth for Rates & Profiles.
    // Drop rates rows that don't correspond to any active master row, and skip
    // placeholder master rows (no Name set — typically work-email-only stubs).
    if (!master) continue;
    if (!toStr(getField(master, ["Name", "name"]))) continue;
    matchedMasters.add(master);

    const rawFields = mergeSourcesDeduped([mergedRates, master]);
    const { department, organization, primaryEmail, workEmail, personalEmail } =
      finalizeProfileFields(rawFields);

    profiles.push({
      id: uniqueId(groupId),
      displayName: resolveDisplayName(mergedRates, master),
      subtitle: primaryEmail,
      department,
      organization,
      workEmail,
      personalEmail,
      employeeId: pickEmployeeId(workEmail, personalEmail, primaryEmail, employeeIdMap, master),
      regularRate:
        toStr(getField(mergedRates, ["Regular Rate", "regular_rate", "Regular_Rate"])) || null,
      otRate:
        toStr(getField(mergedRates, ["OT Rate", "ot_rate", "OT_Rate", "Ot Rate"])) || null,
      suspended: getField(mergedRates, ["suspended", "Suspended"]) === true,
      mesaMember: getField(mergedRates, ["mesa_member", "Mesa Member", "MESA Member"]) === true,
      profilePhotoUrl:
        toStr(getField(master ?? {}, ["Profile Photo URL", "profile_photo_url", "Profile_Photo_URL"])) || null,
      googlePhotoUrl:
        toStr(getField(master ?? {}, ["google_photo_url", "Google Photo URL", "google_picture"])) || null,
      hasRatesRow: Object.keys(mergedRates).length > 0,
    });
  }

  const rateRowsByEmail = new Map<string, RawRow[]>();
  const pushRateByEmail = (email: string | null, r: RawRow) => {
    if (!email) return;
    const list = rateRowsByEmail.get(email);
    if (list) list.push(r);
    else rateRowsByEmail.set(email, [r]);
  };
  for (const rateRow of ratesRaw) {
    const we = normEmail(toStr(getField(rateRow, ["Work Email", "work_email", "Work_Email"])));
    const pe = normEmail(toStr(getField(rateRow, ["Personal Email", "personal_email", "Personal_Email"])));
    pushRateByEmail(we, rateRow);
    pushRateByEmail(pe, rateRow);
  }

  const rateToStrongMasters = new Map<RawRow, Set<RawRow>>();
  for (const rateRow of ratesRaw) {
    const rPersonal = normEmail(
      toStr(getField(rateRow, ["Personal Email", "personal_email", "Personal_Email"])),
    );
    if (!rPersonal) continue;
    const mastersWithEmail = byEmail.get(rPersonal);
    if (!mastersWithEmail) continue;
    let strongSet: Set<RawRow> | null = null;
    for (const m of mastersWithEmail) {
      const mPersonal = normEmail(
        toStr(getField(m, ["Personal Email", "personal_email", "Personal_Email"])),
      );
      if (mPersonal === rPersonal) {
        if (!strongSet) strongSet = new Set<RawRow>();
        strongSet.add(m);
      }
    }
    if (strongSet) rateToStrongMasters.set(rateRow, strongSet);
  }

  for (let i = 0; i < masterRaw.length; i++) {
    const masterRow = masterRaw[i];
    if (matchedMasters.has(masterRow)) continue;
    // Skip placeholder master rows (no Name set) — these are work-email-only
    // stubs that bloated the Rates & Profiles list with junk entries.
    if (!toStr(getField(masterRow, ["Name", "name"]))) continue;

    const mPersonal = normEmail(
      toStr(getField(masterRow, ["Personal Email", "personal_email", "Personal_Email"])),
    );
    const mWork = normEmail(
      toStr(getField(masterRow, ["Work Email", "work_email", "Work_Email"])),
    );
    const masterEmails = [mWork, mPersonal].filter((x): x is string => Boolean(x));

    const seenRateIds = new Set<unknown>();
    const matchingRateRows: RawRow[] = [];
    for (const email of masterEmails) {
      const rows = rateRowsByEmail.get(email);
      if (!rows) continue;
      for (const r of rows) {
        const rid = (r as { id?: unknown }).id;
        if (rid !== undefined && seenRateIds.has(rid)) continue;
        const strongMasters = rateToStrongMasters.get(r);
        if (strongMasters && !strongMasters.has(masterRow)) continue;
        if (rid !== undefined) seenRateIds.add(rid);
        matchingRateRows.push(r);
      }
    }

    const mergedRates: RawRow =
      matchingRateRows.length > 0
        ? mergeRowsUniqueFieldOrder(
            [...matchingRateRows].sort(
              (a, b) =>
                rateRowPriority(b, currentRatesUploadId) -
                rateRowPriority(a, currentRatesUploadId),
            ),
          )
        : {};

    const rawFields = mergeSourcesDeduped([mergedRates, masterRow]);
    const { department, organization, primaryEmail, workEmail, personalEmail } =
      finalizeProfileFields(rawFields);
    const identity = buildIdentity(mergedRates, masterRow);
    const idEmail = [...identity.emails][0] || identity.nameNorm || `row-${i}`;

    profiles.push({
      id: uniqueId(`master:${idEmail}`),
      displayName: resolveDisplayName(mergedRates, masterRow),
      subtitle: primaryEmail,
      department,
      organization,
      workEmail,
      personalEmail,
      employeeId: pickEmployeeId(workEmail, personalEmail, primaryEmail, employeeIdMap, masterRow),
      regularRate:
        toStr(getField(mergedRates, ["Regular Rate", "regular_rate", "Regular_Rate"])) || null,
      otRate:
        toStr(getField(mergedRates, ["OT Rate", "ot_rate", "OT_Rate", "Ot Rate"])) || null,
      suspended: getField(mergedRates, ["suspended", "Suspended"]) === true,
      mesaMember: getField(mergedRates, ["mesa_member", "Mesa Member", "MESA Member"]) === true,
      profilePhotoUrl:
        toStr(getField(masterRow, ["Profile Photo URL", "profile_photo_url", "Profile_Photo_URL"])) || null,
      googlePhotoUrl:
        toStr(getField(masterRow, ["google_photo_url", "Google Photo URL", "google_picture"])) || null,
      hasRatesRow: Object.keys(mergedRates).length > 0,
    });
  }

  // ── Decorate every summary with their role-within-HSL when the email matches
  // an active_hsl_agents row. Misses leave hslRole undefined; the Rates card
  // hides the chip then. Runs over the full profiles array (both branches that
  // built it above) so we don't have to touch each push site individually.
  if (hslRes.byEmail.size > 0) {
    for (const p of profiles) {
      const w = normEmail(p.workEmail ?? null);
      const pe = normEmail(p.personalEmail ?? null);
      const hit = (w && hslRes.byEmail.get(w)) || (pe && hslRes.byEmail.get(pe)) || null;
      if (hit && hit.role) p.hslRole = hit.role;
    }
  }

  profiles.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
  );

  const result = { profiles, error: null, mergeNotes };
  cachedSummaries = { ts: Date.now(), data: result };
  return result;
}
