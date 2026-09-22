import { mesaEmailAliasesFor } from "@/lib/mesa/email-aliases";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "./server";

/**
 * MESA account registry — one row per enrollment stint (see
 * references/sql/migrate/2026-07-16_mesa_accounts.sql). Opting out CLOSES the
 * open account; opting back in opens a NEW account with a NEW number, so a
 * member's balance always aggregates only the ledger events of their current
 * stint (the old account is settled/"zeroed").
 *
 * Every helper here is tolerant of the migration not having run yet (missing
 * table → treated as "no accounts"), so deploys don't depend on SQL order.
 */

export interface MesaAccount {
  id: string;
  account_number: string;
  email: string;
  name: string | null;
  opened_on: string; // YYYY-MM-DD
  closed_on: string | null;
}

const TABLE = "mesa_accounts";
const ACCOUNT_SELECT = "id, account_number, email, name, opened_on, closed_on";

function db() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

/** True for "relation/column does not exist" — the migration hasn't run. */
function isMissingSchema(message: string | undefined | null): boolean {
  return /does not exist|schema cache/i.test(message ?? "");
}

/**
 * All OPEN accounts, keyed by lowercased email. Returns null when the table
 * doesn't exist yet (callers then skip account scoping entirely).
 */
export async function listOpenMesaAccounts(): Promise<Map<string, MesaAccount> | null> {
  const supabase = db();
  if (!supabase) return null;
  const out = new Map<string, MesaAccount>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(TABLE)
      .select(ACCOUNT_SELECT)
      .is("closed_on", null)
      .range(from, from + PAGE - 1);
    if (error) return isMissingSchema(error.message) ? null : out;
    const batch = (data ?? []) as MesaAccount[];
    for (const a of batch) out.set(a.email.toLowerCase(), a);
    if (batch.length < PAGE) break;
  }
  return out;
}

/** The member's open account, or null (also null if the table is missing). */
export async function getOpenMesaAccount(email: string): Promise<MesaAccount | null> {
  const supabase = db();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select(ACCOUNT_SELECT)
    .ilike("email", email.trim())
    .is("closed_on", null)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data as MesaAccount | null) ?? null;
}

/** Next "YY-MM-#####" number for the month of `openedOn` (YYYY-MM-DD). */
async function nextAccountNumber(
  supabase: NonNullable<ReturnType<typeof db>>,
  openedOn: string,
): Promise<string> {
  const prefix = `${openedOn.slice(2, 4)}-${openedOn.slice(5, 7)}`; // 2026-07-10 → 26-07
  const { data } = await supabase
    .from(TABLE)
    .select("account_number")
    .like("account_number", `${prefix}-%`)
    .order("account_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  const last = (data as { account_number?: string } | null)?.account_number;
  const serial = last ? parseInt(last.slice(prefix.length + 1), 10) + 1 : 1;
  return `${prefix}-${String(serial).padStart(5, "0")}`;
}

/**
 * Open an account for the member effective `openedOn` (their opt-in date; its
 * year+month becomes the number's YY-MM). Reuses an already-open account so a
 * double opt-in / revoked opt-out stays idempotent. Retries the serial on a
 * unique collision. Returns null when the table is missing (migration pending)
 * — enrollment itself must still succeed.
 */
export async function openMesaAccount(
  email: string,
  name: string | null,
  openedOn: string,
): Promise<MesaAccount | null> {
  const supabase = db();
  if (!supabase) return null;
  const existing = await getOpenMesaAccount(email);
  if (existing) return existing;
  for (let attempt = 0; attempt < 3; attempt++) {
    const account_number = await nextAccountNumber(supabase, openedOn);
    const { data, error } = await supabase
      .from(TABLE)
      .insert({ account_number, email: email.trim().toLowerCase(), name, opened_on: openedOn })
      .select(ACCOUNT_SELECT)
      .single();
    if (!error) return data as MesaAccount;
    if (isMissingSchema(error.message)) return null;
    // 23505 = another writer took this serial or opened the member's account.
    if (error.code === "23505") {
      const raced = await getOpenMesaAccount(email);
      if (raced) return raced;
      continue;
    }
    throw new Error(`mesa_accounts insert: ${error.message}`);
  }
  throw new Error("mesa_accounts insert: could not allocate an account number");
}

/**
 * Close the member's open account(s) as of `closedOn`. Returns the closed
 * account numbers (empty when none / table missing).
 */
export async function closeMesaAccounts(email: string, closedOn: string): Promise<string[]> {
  const supabase = db();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from(TABLE)
    .update({ closed_on: closedOn })
    .ilike("email", email.trim())
    .is("closed_on", null)
    .select("account_number");
  if (error) return [];
  return ((data ?? []) as { account_number: string }[]).map((r) => r.account_number);
}

export type AliasOpenLookup =
  | { ok: true; found: { email: string; account: MesaAccount } | null }
  | { ok: false; error: string };

/**
 * An OPEN account held under one of the member's EARLIER addresses.
 *
 * `getOpenMesaAccount` resolves by the single email it is handed. A member
 * whose MESA identity drifted — the ledger and `mesa_accounts` know `dale@`,
 * the roster and rate rows know `dales@` — therefore looks unenrolled to it,
 * and opting them in MINTS A SECOND ACCOUNT dated today, hiding the balance
 * they already hold (docs/features/mesa.md:225). The read path has bridged
 * those addresses since the alias map existed; this is the enrollment path
 * catching up, in the REFUSAL direction only — nothing here writes, and no
 * enrollment is ever redirected into an account belonging to another address.
 *
 * `email` itself is excluded from the search: an open account under the SAME
 * address is `getOpenMesaAccount`'s business (`openAccountConflict`), and
 * reporting it here would turn an idempotent re-enrollment into a refusal.
 *
 * A missing table (migration pending) is "no alias account". Any OTHER read
 * failure is reported as a failure, never as "none" — this decides whether a
 * second account gets minted over someone's savings, and an unreadable
 * registry must not read as a clear one.
 */
export async function getOpenMesaAccountAcrossAliases(email: string): Promise<AliasOpenLookup> {
  const supabase = db();
  if (!supabase) return { ok: false, error: "Supabase client not initialized" };
  const self = email.trim().toLowerCase();
  const others = mesaEmailAliasesFor(self).filter((e) => e !== self);
  if (others.length === 0) return { ok: true, found: null };

  // One `ilike` query per alias rather than a single `in` — `mesa_accounts.email`
  // is matched case-insensitively everywhere else in this file, and an `in`
  // list cannot be. The list is the repo's own alias map, so it is at most a
  // handful of rows and only read on opt-in.
  for (const alias of others) {
    const { data, error } = await supabase
      .from(TABLE)
      .select(ACCOUNT_SELECT)
      .ilike("email", alias)
      .is("closed_on", null)
      .order("opened_on", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) {
      if (isMissingSchema(error.message)) return { ok: true, found: null };
      return { ok: false, error: error.message };
    }
    const account = (data as MesaAccount | null) ?? null;
    if (account) return { ok: true, found: { email: account.email, account } };
  }
  return { ok: true, found: null };
}

export type LatestClosedLookup =
  | { ok: true; account: MesaAccount | null }
  | { ok: false; error: string };

/**
 * The member's most recently CLOSED account (largest `closed_on`), so an
 * enrollment can refuse an effective date that reaches back into it (see
 * `closedStintConflict` in src/lib/mesa/enrollment-date.ts).
 *
 * A missing table (migration pending) is "no closed stints" — there is nothing
 * to reach into. Any OTHER read failure is reported as such rather than as
 * "none": the caller is deciding whether a back-dated opening would re-count a
 * released balance, and an unreadable history must not read as a clean one.
 */
export async function getLatestClosedMesaAccount(email: string): Promise<LatestClosedLookup> {
  const supabase = db();
  if (!supabase) return { ok: false, error: "Supabase client not initialized" };
  const { data, error } = await supabase
    .from(TABLE)
    .select(ACCOUNT_SELECT)
    .ilike("email", email.trim())
    .not("closed_on", "is", null)
    .order("closed_on", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingSchema(error.message)) return { ok: true, account: null };
    return { ok: false, error: error.message };
  }
  return { ok: true, account: (data as MesaAccount | null) ?? null };
}
