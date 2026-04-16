import { normEmail } from "@/lib/email/norm-email";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "./server";
import { isSafeTableName, listPublicTableNames } from "./list-public-tables";

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

export type GetEmployeeRateProfilesResult = {
  profiles: EmployeeRateProfile[];
  error: string | null;
  /** Tables that failed to load or were excluded from merge (for UI). */
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

function rateGroupKey(row: RawRow, rowIndex: number): string {
  const w = normEmail(toStr(getField(row, ["Work Email", "work_email", "Work_Email"])));
  const p = normEmail(toStr(getField(row, ["Personal Email", "personal_email", "Personal_Email"])));
  if (w) return `e:${w}`;
  if (p) return `e:${p}`;
  return `row:${rowIndex}`;
}

function buildMasterIndexes(rows: RawRow[]): {
  byEmail: Map<string, RawRow>;
  byName: Map<string, RawRow>;
} {
  const byEmail = new Map<string, RawRow>();
  const byName = new Map<string, RawRow>();
  for (const row of rows) {
    const pe = normEmail(toStr(getField(row, ["Personal Email", "personal_email", "Personal_Email"])));
    const we = normEmail(toStr(getField(row, ["Work Email", "work_email", "Work_Email"])));
    if (pe) byEmail.set(pe, row);
    if (we) byEmail.set(we, row);
    const nn = normalizeName(toStr(getField(row, ["Name", "name"])));
    if (nn) byName.set(nn, row);
  }
  return { byEmail, byName };
}

function findMasterForMergedRates(
  mergedRates: RawRow,
  byEmail: Map<string, RawRow>,
  byName: Map<string, RawRow>,
): RawRow | null {
  const emails = [
    normEmail(toStr(getField(mergedRates, ["Work Email", "work_email", "Work_Email"]))),
    normEmail(toStr(getField(mergedRates, ["Personal Email", "personal_email", "Personal_Email"]))),
  ].filter((x): x is string => Boolean(x));
  for (const e of emails) {
    const m = byEmail.get(e);
    if (m) return m;
  }
  const nn = normalizeName(
    toStr(getField(mergedRates, ["Name", "name", "Full Name", "full_name"])),
  );
  if (nn) {
    const m = byName.get(nn);
    if (m) return m;
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
  const { data, error } = await supabase.from(table).select("*");
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as RawRow[], error: null };
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

export async function getEmployeeRateProfiles(): Promise<GetEmployeeRateProfilesResult> {
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

  const fetched = await Promise.all(
    tablesToFetch.map(async (t) => {
      const res = await fetchRawFromTable(t);
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

  const masterRaw = byTable.get(masterTable) ?? [];
  const { byEmail, byName } = buildMasterIndexes(masterRaw);

  const extraMergeTables = [...mergeList]
    .filter((t) => t !== ratesTable && t !== masterTable)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const groupMap = new Map<string, RawRow[]>();
  ratesRaw.forEach((row, i) => {
    const k = rateGroupKey(row, i);
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
    const mergedRates = mergeRowsUniqueFieldOrder(groupRows);
    const master = findMasterForMergedRates(mergedRates, byEmail, byName);
    if (master) matchedMasters.add(master);
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

  // Second pass: include master-list employees who have no row in the rates
  // table. Their rate fields stay null; other columns (department, emails,
  // start date, etc.) come from master + extra tables.
  for (let i = 0; i < masterRaw.length; i++) {
    const masterRow = masterRaw[i];
    if (matchedMasters.has(masterRow)) continue;

    const mergedRates: RawRow = {};
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

  return { profiles, error: null, mergeNotes };
}

