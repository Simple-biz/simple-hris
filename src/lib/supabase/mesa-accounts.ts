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
