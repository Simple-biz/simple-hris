import { mesaEmailAliasesFor } from "@/lib/mesa/email-aliases";
import {
  EMPTY_MESA_SUSPENSION_INDEX,
  indexMesaSuspensions,
  type MesaSuspension,
  type MesaSuspensionIndex,
} from "@/lib/mesa/suspension";
import { normEmail } from "@/lib/email/norm-email";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "./server";

/**
 * MESA contribution suspensions (references/sql/create/2026-10-06_mesa_suspensions.sql,
 * docs/features/mesa-suspension.md).
 *
 * Two failure modes are kept apart on purpose, as in `mesa-accounts.ts`:
 *  - the TABLE IS MISSING (migration pending) → `available: false`, no suspensions.
 *    Nobody can have been suspended without the table, so "none" is the truth.
 *  - any OTHER read error → reported as an error, NEVER as "none". A suspension
 *    that cannot be read must not be spent as "this person is not suspended",
 *    because that is a ₱100 taken from someone Accounting stopped charging.
 */

const TABLE = "mesa_suspensions";
const ACCOUNTS = "mesa_accounts";
const PAGE = 1000;
const SELECT =
  "id, account_number, email, roster_email, suspended_from, resumed_on, reason, suspended_by, suspended_at, resumed_by, resumed_at";

interface SuspensionRow {
  id: string;
  account_number: string;
  email: string;
  roster_email: string | null;
  suspended_from: string;
  resumed_on: string | null;
  reason: string | null;
  suspended_by: string;
  suspended_at: string;
  resumed_by: string | null;
  resumed_at: string | null;
}

function db() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

/** True for "relation does not exist" — the migration hasn't run. */
function isMissingSchema(message: string | undefined | null): boolean {
  return /does not exist|schema cache|could not find the table/i.test(message ?? "");
}

function toSuspension(row: SuspensionRow, accountEmail?: string | null): MesaSuspension {
  const emails = new Set<string>();
  for (const raw of [accountEmail, row.email, row.roster_email]) {
    for (const e of mesaEmailAliasesFor(raw)) emails.add(e);
    const n = normEmail(raw);
    if (n) emails.add(n);
  }
  return {
    id: row.id,
    accountNumber: row.account_number,
    email: row.email,
    rosterEmail: row.roster_email,
    suspendedFrom: String(row.suspended_from).slice(0, 10),
    resumedOn: row.resumed_on ? String(row.resumed_on).slice(0, 10) : null,
    reason: row.reason,
    suspendedBy: row.suspended_by,
    suspendedAt: row.suspended_at,
    resumedBy: row.resumed_by,
    resumedAt: row.resumed_at,
    emails: [...emails],
  };
}

export type SuspensionList =
  | { ok: true; available: boolean; suspensions: MesaSuspension[] }
  | { ok: false; error: string };

/**
 * Every suspension window on a currently OPEN account — the set every money
 * path consults. Windows on a closed account are inert (the member opted out;
 * a re-join opens a new account number with no suspension) and are left out.
 * Paged: PostgREST truncates at 1000 rows even with `.range()`.
 */
export async function listMesaSuspensionsForOpenAccounts(): Promise<SuspensionList> {
  const supabase = db();
  if (!supabase) return { ok: false, error: "Supabase client not initialized" };

  const rows: SuspensionRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(TABLE)
      .select(SELECT)
      .order("suspended_from", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isMissingSchema(error.message)) return { ok: true, available: false, suspensions: [] };
      return { ok: false, error: error.message };
    }
    const batch = (data ?? []) as SuspensionRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  if (rows.length === 0) return { ok: true, available: true, suspensions: [] };

  // Open accounts, by number. Read in full (a few hundred rows, paged) rather
  // than `.in(...)` over the suspended numbers, which has a URL ceiling.
  const openEmailByNumber = new Map<string, string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(ACCOUNTS)
      .select("account_number, email")
      .is("closed_on", null)
      .order("account_number", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { ok: false, error: error.message };
    const batch = (data ?? []) as Array<{ account_number: string; email: string }>;
    for (const a of batch) openEmailByNumber.set(a.account_number, a.email);
    if (batch.length < PAGE) break;
  }

  const suspensions = rows
    .filter((r) => openEmailByNumber.has(r.account_number))
    .map((r) => toSuspension(r, openEmailByNumber.get(r.account_number)));
  return { ok: true, available: true, suspensions };
}

/**
 * The suspension index for a server-side money path (the ledger writer and both
 * pay engines). Missing table → the empty index. Any other failure THROWS: the
 * caller's run fails rather than charging or depositing for a member whose
 * suspension could not be read. Every caller is re-runnable (the writer is
 * idempotent per member-week; the engines recompute on the next request).
 */
export async function loadMesaSuspensionIndexOrThrow(): Promise<MesaSuspensionIndex> {
  const list = await listMesaSuspensionsForOpenAccounts();
  if (!list.ok) throw new Error(`Could not read MESA suspensions: ${list.error}`);
  if (!list.available || list.suspensions.length === 0) return EMPTY_MESA_SUSPENSION_INDEX;
  return indexMesaSuspensions(list.suspensions);
}

export type AccountSuspensions =
  | { ok: true; available: boolean; suspensions: MesaSuspension[] }
  | { ok: false; error: string };

/** Every window on one account, open and closed — what a new suspend is checked against. */
export async function listMesaSuspensionsForAccount(accountNumber: string): Promise<AccountSuspensions> {
  const supabase = db();
  if (!supabase) return { ok: false, error: "Supabase client not initialized" };
  const { data, error } = await supabase
    .from(TABLE)
    .select(SELECT)
    .eq("account_number", accountNumber)
    .order("suspended_from", { ascending: true })
    .limit(PAGE);
  if (error) {
    if (isMissingSchema(error.message)) return { ok: true, available: false, suspensions: [] };
    return { ok: false, error: error.message };
  }
  return { ok: true, available: true, suspensions: ((data ?? []) as SuspensionRow[]).map((r) => toSuspension(r)) };
}

export type SuspensionLookup =
  | { ok: true; available: boolean; suspension: MesaSuspension | null; accountClosedOn: string | null }
  | { ok: false; error: string };

/** One window by id, with whether its account has since been closed. */
export async function getMesaSuspension(id: string): Promise<SuspensionLookup> {
  const supabase = db();
  if (!supabase) return { ok: false, error: "Supabase client not initialized" };
  const { data, error } = await supabase.from(TABLE).select(SELECT).eq("id", id).maybeSingle();
  if (error) {
    if (isMissingSchema(error.message)) return { ok: true, available: false, suspension: null, accountClosedOn: null };
    // A malformed uuid is "no such row", not an outage.
    if (/invalid input syntax for type uuid/i.test(error.message)) {
      return { ok: true, available: true, suspension: null, accountClosedOn: null };
    }
    return { ok: false, error: error.message };
  }
  if (!data) return { ok: true, available: true, suspension: null, accountClosedOn: null };
  const row = data as SuspensionRow;
  const acct = await supabase
    .from(ACCOUNTS)
    .select("email, closed_on")
    .eq("account_number", row.account_number)
    .maybeSingle();
  if (acct.error) return { ok: false, error: acct.error.message };
  const account = acct.data as { email: string; closed_on: string | null } | null;
  return {
    ok: true,
    available: true,
    suspension: toSuspension(row, account?.email ?? null),
    accountClosedOn: account?.closed_on ?? null,
  };
}

export type SuspensionWrite =
  | { ok: true; suspension: MesaSuspension }
  /** The one-open-window index refused it — someone suspended this account first. */
  | { ok: false; conflict: true; error: string }
  | { ok: false; conflict: false; missing: boolean; error: string };

export async function insertMesaSuspension(input: {
  accountNumber: string;
  accountEmail: string;
  rosterEmail: string | null;
  suspendedFrom: string;
  reason: string | null;
  suspendedBy: string;
}): Promise<SuspensionWrite> {
  const supabase = db();
  if (!supabase) return { ok: false, conflict: false, missing: false, error: "Supabase client not initialized" };
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      account_number: input.accountNumber,
      email: input.accountEmail.trim().toLowerCase(),
      roster_email: normEmail(input.rosterEmail),
      suspended_from: input.suspendedFrom,
      reason: input.reason,
      suspended_by: input.suspendedBy,
    })
    .select(SELECT)
    .single();
  if (error) {
    if (error.code === "23505") {
      return { ok: false, conflict: true, error: "This account already has an open suspension. Refresh and Resume it first." };
    }
    return { ok: false, conflict: false, missing: isMissingSchema(error.message), error: error.message };
  }
  return { ok: true, suspension: toSuspension(data as SuspensionRow, input.accountEmail) };
}

/**
 * Ends an open window. Compare-and-set on `resumed_on IS NULL`: a second
 * Resume racing the first updates nothing and is reported as a conflict, never
 * as a silent overwrite of the first one's date.
 */
export async function resumeMesaSuspension(input: {
  id: string;
  resumeOn: string;
  resumedBy: string;
}): Promise<SuspensionWrite> {
  const supabase = db();
  if (!supabase) return { ok: false, conflict: false, missing: false, error: "Supabase client not initialized" };
  const { data, error } = await supabase
    .from(TABLE)
    .update({ resumed_on: input.resumeOn, resumed_by: input.resumedBy, resumed_at: new Date().toISOString() })
    .eq("id", input.id)
    .is("resumed_on", null)
    .select(SELECT);
  if (error) return { ok: false, conflict: false, missing: isMissingSchema(error.message), error: error.message };
  const row = ((data ?? []) as SuspensionRow[])[0];
  if (!row) return { ok: false, conflict: true, error: "This suspension was already resumed. Refresh to see its date." };
  return { ok: true, suspension: toSuspension(row) };
}
