import {
  PROCESSOR_OPTIONS,
  SELECTABLE_PROCESSOR_OPTIONS,
  type ProcessorId,
} from '@/lib/employee-payment-processors';
import type { ReceivingDestination } from '@/lib/employee/payout-completeness';

/**
 * The bank mix behind the People → Bank changes KPI band: how the roster splits
 * across **send-from rails** (which processor Accounting pays OUT on) and across
 * **receiving banks** (the payee's own account where the money lands).
 *
 * Both halves are folded from ONE `ReceivingDestination[]` — the resolution
 * `resolveReceivingDestination` already made with Payment Dispatch's precedence —
 * so the two cards can never disagree about who is routed where. See
 * docs/features/bank-preferred-routing.md §10.
 *
 * Deliberately NOT sourced from `bank_update_history.processor`: that column
 * stores `preferred_processor` (the employee's RECEIVE election), which is a
 * different thing from the send-from rail — and the feed is a capped, newest-first
 * slice, so counting it would be a sample dressed up as a KPI.
 */

export interface BankMixSlice {
  /** Grouping key — a ProcessorId for rails, a casefolded name for banks. */
  key: string;
  /** What to print (rail label, or the most common raw spelling of the name). */
  label: string;
  count: number;
}

/**
 * A receiving bank plus which send-from rails it receives FROM. One bank sits
 * under several rails at once — GoTyme is `wise 132 · wires 45` on the live roster
 * — which is the whole reason the two cards are shown side by side. Only bank
 * rails can appear here; a wallet payee has no receiving bank to attribute.
 */
export interface BankNameSlice extends BankMixSlice {
  /** Rails feeding this bank, biggest first. `Σ byRail.count === count`. */
  byRail: BankMixSlice[];
}

export interface BankMix {
  /** Everyone counted. `total === Σ sending.count + unrouted`. */
  total: number;
  /** Send-from rails, biggest first. `Σ sending.count === bankRail + wallet`. */
  sending: BankMixSlice[];
  /** Receiving banks, biggest first, each with its rail split.
   *  `Σ receiving.count === bankRail - missingBank`. */
  receiving: BankNameSlice[];
  /** Payees on a bank rail (wise/jeeves/wires) — the receiving denominator. */
  bankRail: number;
  /** Wallet payees (hurupay/higlobe/wepay): a wallet deposit HAS no receiving bank. */
  wallet: number;
  /** On a bank rail with no bank name in either slot. */
  missingBank: number;
  /** No rail resolves — PD would exclude them as `no_bank`. */
  unrouted: number;
  /** Distinct receiving-bank names after grouping. */
  distinctBanks: number;
}

const RAIL_LABEL = new Map<ProcessorId, string>(PROCESSOR_OPTIONS.map((p) => [p.id, p.label]));

/**
 * Every rail that deserves a row on the KPI card, biggest first:
 *
 *   - **any rail somebody is actually on**, retired or not — Wise and Jeeves are
 *     retired from the pickers but still carry live payees, and a rail with people
 *     on it must never be hidden from Accounting;
 *   - plus every **still-offered** rail at zero, because "Hurupay: 0" is a real
 *     answer and a missing row is indistinguishable from a forgotten one.
 *
 * A rail that is BOTH retired and empty (Wepay, as of 2026-08-19) is dropped: it
 * is neither a live routing option nor a fact about anyone. The rule reads off
 * `SELECTABLE_PROCESSOR_OPTIONS`, so retiring or reviving a processor moves the
 * card by itself, and the row returns the moment one payee lands on it.
 */
export function railDistribution(sending: readonly BankMixSlice[]): BankMixSlice[] {
  const seen = new Map(sending.map((s) => [s.key, s]));
  const offered = new Set<string>(SELECTABLE_PROCESSOR_OPTIONS.map((p) => p.id));
  const rows = PROCESSOR_OPTIONS.flatMap((p) => {
    const observed = seen.get(p.id);
    if (observed) return [observed];
    return offered.has(p.id) ? [{ key: p.id, label: p.label, count: 0 }] : [];
  });
  return rows.sort(bySizeThenName);
}

/**
 * Grouping key for a free-text `employee_ids.bank_name`. Case-insensitive with
 * whitespace collapsed and trailing punctuation dropped — and NOTHING else.
 *
 * No alias table on purpose: "BDO" and "Banco de Oro" are the same bank to a
 * human and this function will keep them apart. Merging them would mean
 * inventing an equivalence nobody recorded, and a KPI that quietly folds two
 * names together is worse than one that visibly splits them. The card states
 * that spellings are counted as typed.
 */
export function normalizeBankNameKey(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/, '')
    .trim()
    .toLowerCase();
}

/** count desc, then label asc — deterministic, so the band never reshuffles. */
function bySizeThenName(a: BankMixSlice, b: BankMixSlice): number {
  return b.count - a.count || a.label.localeCompare(b.label);
}

export function buildBankMix(destinations: readonly ReceivingDestination[]): BankMix {
  const railCounts = new Map<ProcessorId, number>();
  /** key → every raw spelling seen under it, so the label is the popular one. */
  const bankSpellings = new Map<string, Map<string, number>>();
  /** key → which rails pay into that bank, so a bank row can show its split. */
  const bankRails = new Map<string, Map<ProcessorId, number>>();
  let wallet = 0;
  let missingBank = 0;
  let unrouted = 0;

  for (const d of destinations) {
    if (d.kind === 'unrouted') {
      unrouted += 1;
      continue;
    }
    railCounts.set(d.processor, (railCounts.get(d.processor) ?? 0) + 1);

    if (d.kind === 'wallet') {
      wallet += 1;
      continue;
    }
    if (d.kind === 'missing') {
      missingBank += 1;
      continue;
    }

    const key = normalizeBankNameKey(d.bankName);
    if (!key) {
      // A name that normalizes away entirely (e.g. "."). Not a bank name, so it
      // joins the honest bucket rather than becoming an empty-labelled slice.
      missingBank += 1;
      continue;
    }
    const spellings = bankSpellings.get(key) ?? new Map<string, number>();
    const raw = d.bankName.trim().replace(/\s+/g, ' ');
    spellings.set(raw, (spellings.get(raw) ?? 0) + 1);
    bankSpellings.set(key, spellings);

    const rails = bankRails.get(key) ?? new Map<ProcessorId, number>();
    rails.set(d.processor, (rails.get(d.processor) ?? 0) + 1);
    bankRails.set(key, rails);
  }

  const sending: BankMixSlice[] = [...railCounts.entries()]
    .map(([id, count]) => ({ key: id, label: RAIL_LABEL.get(id) ?? id, count }))
    .sort(bySizeThenName);

  const receiving: BankNameSlice[] = [...bankSpellings.entries()]
    .map(([key, spellings]) => {
      let label = key;
      let best = -1;
      for (const [raw, n] of spellings) {
        // Ties keep the first spelling encountered — insertion order is stable.
        if (n > best) {
          best = n;
          label = raw;
        }
      }
      let count = 0;
      for (const n of spellings.values()) count += n;
      const byRail: BankMixSlice[] = [...(bankRails.get(key) ?? new Map<ProcessorId, number>())]
        .map(([id, n]) => ({ key: id, label: RAIL_LABEL.get(id) ?? id, count: n }))
        .sort(bySizeThenName);
      return { key, label, count, byRail };
    })
    .sort(bySizeThenName);

  let named = 0;
  for (const r of receiving) named += r.count;

  return {
    total: wallet + missingBank + unrouted + named,
    sending,
    receiving,
    bankRail: named + missingBank,
    wallet,
    missingBank,
    unrouted,
    distinctBanks: receiving.length,
  };
}

/** A department label to bucket a person's destination under. Blank / null
 *  becomes the shared NO_DEPARTMENT key so nobody is dropped. */
export const NO_DEPARTMENT = '__none__';

export interface DeptDestination {
  department: string | null;
  destination: ReceivingDestination;
}

/**
 * The same fold, once per department, so a department filter can re-scope the
 * KPI band instead of leaving it stuck on org-wide figures beside a filtered
 * list. People with no department land under {@link NO_DEPARTMENT} rather than
 * being dropped: a filter never hides a row.
 *
 * Keys are the department labels exactly as the roster reports them, so the
 * caller can look up the selected filter value directly.
 */
export function buildBankMixByDepartment(entries: readonly DeptDestination[]): Record<string, BankMix> {
  const grouped = new Map<string, ReceivingDestination[]>();
  for (const e of entries) {
    const key = (e.department ?? '').trim() || NO_DEPARTMENT;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(e.destination);
    else grouped.set(key, [e.destination]);
  }
  const out: Record<string, BankMix> = {};
  for (const [dept, dests] of grouped) out[dept] = buildBankMix(dests);
  return out;
}
