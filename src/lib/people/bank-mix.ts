import { PROCESSOR_OPTIONS, type ProcessorId } from '@/lib/employee-payment-processors';
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

export interface BankMix {
  /** Everyone counted. `total === Σ sending.count + unrouted`. */
  total: number;
  /** Send-from rails, biggest first. `Σ sending.count === bankRail + wallet`. */
  sending: BankMixSlice[];
  /** Receiving banks, biggest first. `Σ receiving.count === bankRail - missingBank`. */
  receiving: BankMixSlice[];
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
  }

  const sending: BankMixSlice[] = [...railCounts.entries()]
    .map(([id, count]) => ({ key: id, label: RAIL_LABEL.get(id) ?? id, count }))
    .sort(bySizeThenName);

  const receiving: BankMixSlice[] = [...bankSpellings.entries()]
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
      return { key, label, count };
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
