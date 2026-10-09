import { createSupabaseServiceRoleClient } from "./server";
import { selectAllPaged } from "./select-all-paged";
import { escapeLikePattern } from "@/lib/db/like-escape";
import { mailableEmail, normEmail } from "@/lib/email/norm-email";
import {
  decidePaystubDeliveryAddress,
  nameKey,
  withheldReasonText,
  type AddressHolders,
} from "@/lib/payroll/paystub-delivery-address";

/**
 * Current and previous holders of each work email, for the paystub delivery
 * guard (`decidePaystubDeliveryAddress`, Open item 432).
 *
 * - CURRENT: `global_master_list` rows with `off_boarded_at IS NULL` carrying the
 *   address as primary or alternate work email (the same "active" test
 *   `expandWorkEmailAliases` uses).
 * - PREVIOUS: off-boarded `global_master_list` rows for the address, plus the
 *   `offboarded_sheet` ledger. The ledger is needed because a leaver's master
 *   row is often gone entirely (krisd@: Diez has no master row, only a ledger row).
 *
 * Service role only. A failed read returns `error` and NO map: the callers fail
 * closed (staging refuses, the send withholds), because a partial map would
 * read as "nobody left under this address" and let the previous holder through.
 */

const GML_COLS = '"id","Name","Work Email","Alternate Work Email","Alternate Work Email 2","Personal Email","off_boarded_at"';
const LEDGER_COLS = "id, name, work_email, personal_email";
const WORK_COLS = ["Work Email", "Alternate Work Email", "Alternate Work Email 2"] as const;

export type GmlHolderRow = Record<string, unknown> & { id: string; off_boarded_at: string | null };
export type LedgerHolderRow = { id: number | string; name: string | null; work_email: string | null; personal_email: string | null };

/** Above this many addresses, read both tables whole (paged) instead of per address. */
const TARGETED_MAX = 5;

export async function loadAddressHolders(
  workEmails: string[],
): Promise<{ holders: Map<string, AddressHolders> | null; error: string | null }> {
  const wanted = new Set(workEmails.map((e) => normEmail(e)).filter((e): e is string => !!e));
  if (wanted.size === 0) return { holders: new Map(), error: null };

  const sb = createSupabaseServiceRoleClient();
  if (!sb) return { holders: null, error: "Supabase service role unavailable" };

  let gml: GmlHolderRow[] = [];
  let ledger: LedgerHolderRow[] = [];
  try {
    if (wanted.size <= TARGETED_MAX) {
      const reads: Array<PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>> = [];
      for (const we of wanted) {
        const pattern = escapeLikePattern(we);
        for (const col of WORK_COLS) {
          // One query per column: PostgREST's `.or()` mis-parses quoted,
          // space-containing column names (see work-email-aliases.ts).
          reads.push(sb.from("global_master_list").select(GML_COLS).ilike(`"${col}"`, pattern));
        }
        reads.push(sb.from("offboarded_sheet").select(LEDGER_COLS).ilike("work_email", pattern));
      }
      const results = await Promise.all(reads);
      const failed = results.find((r) => r.error);
      if (failed?.error) return { holders: null, error: failed.error.message };
      const perAddress = WORK_COLS.length + 1;
      results.forEach((r, i) => {
        if (i % perAddress === WORK_COLS.length) ledger.push(...((r.data ?? []) as LedgerHolderRow[]));
        else gml.push(...((r.data ?? []) as GmlHolderRow[]));
      });
    } else {
      const [g, l] = await Promise.all([
        selectAllPaged<GmlHolderRow>((from, to) =>
          sb.from("global_master_list").select(GML_COLS).order("id", { ascending: true }).range(from, to),
        ),
        selectAllPaged<LedgerHolderRow>((from, to) =>
          sb.from("offboarded_sheet").select(LEDGER_COLS).order("id", { ascending: true }).range(from, to),
        ),
      ]);
      if (g.error) return { holders: null, error: g.error };
      if (l.error) return { holders: null, error: l.error };
      gml = g.rows;
      ledger = l.rows;
    }
  } catch (err) {
    return { holders: null, error: err instanceof Error ? err.message : String(err) };
  }

  return { holders: buildAddressHolders(wanted, gml, ledger), error: null };
}

export type QueuedAddressCheck =
  | { kind: "keep" }
  | { kind: "replace"; to: string; payload: Record<string, unknown> }
  | { kind: "block"; reason: string };

/**
 * The last check before a queued paystub is mailed. A row staged before the
 * staging guard existed (or by a stale client) can still carry a previous
 * holder's address, and a re-send reads the QUEUED payload. `replace` hands back
 * the payload re-pointed at the current holder; `block` means mail nobody.
 * A failed holder read blocks: never guess in the previous holder's favour.
 */
export async function checkQueuedPaystubAddress(
  workEmail: string,
  payload: Record<string, unknown>,
  recipientName: string | null,
): Promise<QueuedAddressCheck> {
  const we = normEmail(workEmail) ?? workEmail;
  const { holders, error } = await loadAddressHolders([we]);
  if (!holders) {
    return { kind: "block", reason: `Not sent: could not check the address against previous holders of ${we} (${error ?? "unknown error"}).` };
  }
  const proposed = typeof payload.personal_email === "string" ? payload.personal_email : null;
  const name = (typeof payload.name === "string" && payload.name) || recipientName;
  const d = decidePaystubDeliveryAddress(proposed, holders.get(we), name);
  if (d.kind === "keep") return { kind: "keep" };
  if (d.kind === "replace") return { kind: "replace", to: d.to, payload: { ...payload, personal_email: d.to } };
  return { kind: "block", reason: withheldReasonText(we, d.reason) };
}

/** Pure fold of the two reads. Exported for tests. */
export function buildAddressHolders(
  wanted: Set<string>,
  gml: GmlHolderRow[],
  ledger: LedgerHolderRow[],
): Map<string, AddressHolders> {
  type Acc = {
    activeIds: Set<string>;
    current: Set<string>;
    currentNames: Map<string, string[]>;
    previous: Map<string, Map<string, string[]>>;
  };
  const acc = new Map<string, Acc>();
  const slot = (we: string) => {
    let s = acc.get(we);
    if (!s) acc.set(we, (s = { activeIds: new Set(), current: new Set(), currentNames: new Map(), previous: new Map() }));
    return s;
  };
  const addPrevious = (s: Acc, pe: string, name: unknown) => {
    let names = s.previous.get(pe);
    if (!names) s.previous.set(pe, (names = new Map()));
    const k = nameKey(typeof name === "string" ? name : null);
    if (k.length > 0) names.set(k.join(" "), k);
  };
  const seenGml = new Set<string>();
  for (const r of gml) {
    if (seenGml.has(String(r.id))) continue; // a row matched on two columns
    seenGml.add(String(r.id));
    const pe = mailableEmail(r["Personal Email"] as string | null);
    for (const col of WORK_COLS) {
      const we = normEmail(r[col] as string | null);
      if (!we || !wanted.has(we)) continue;
      const s = slot(we);
      if (r.off_boarded_at == null) {
        s.activeIds.add(String(r.id));
        if (pe) s.current.add(pe);
        const k = nameKey(r["Name"] as string | null);
        if (k.length > 0) s.currentNames.set(k.join(" "), k);
      } else if (pe) {
        addPrevious(s, pe, r["Name"]);
      }
    }
  }
  for (const r of ledger) {
    const we = normEmail(r.work_email);
    if (!we || !wanted.has(we)) continue;
    const pe = mailableEmail(r.personal_email);
    if (pe) addPrevious(slot(we), pe, r.name);
  }
  const out = new Map<string, AddressHolders>();
  for (const [we, s] of acc) {
    out.set(we, {
      activeRows: s.activeIds.size,
      current: [...s.current].sort(),
      currentNames: [...s.currentNames.values()],
      previous: [...s.previous]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([email, names]) => ({ email, names: [...names.values()] })),
    });
  }
  return out;
}
