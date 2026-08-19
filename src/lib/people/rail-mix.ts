import {
  PROCESSOR_OPTIONS,
  SELECTABLE_PROCESSOR_OPTIONS,
  type ProcessorId,
} from '@/lib/employee-payment-processors';
import {
  payoutRequirementFor,
  isWalletRail,
  type PayoutRequirement,
} from '@/lib/employee/payout-completeness';

/**
 * The rail mix behind the People → Bank changes KPI band. One fold, two readings
 * of the same rows:
 *
 *   1. **Preferred bank · send-from** — how many people each rail carries.
 *   2. **Receiving details on file** — of those, how many carry what that rail
 *      needs in order to actually be paid on it.
 *
 * Both come from the roster's OWN resolution (`resolveEffectivePayoutProcessor`
 * for the rail, `isPayoutComplete` for the details) — the same pair that paints
 * the roster chip and the "Missing bank info" list. So the band can never
 * disagree with the rest of the People tab, and the second card is a different
 * fact rather than the first one restated.
 *
 * **No bank names here** (Kane, 2026-08-19: *no bank names, it has to be the same
 * from preferred bank*). `employee_ids.bank_name` is free text carrying ~100
 * spellings of maybe 30 banks, and the rail is the unit Accounting actually pays
 * on: a bank like GoTyme arrives *via* Wise or Wires rather than being a category
 * of its own.
 *
 * Deliberately NOT sourced from `bank_update_history.processor` either: that column
 * stores `preferred_processor` (the employee's RECEIVE election), a different thing
 * from the send-from rail, and the feed is a capped newest-first slice, so counting
 * it would be a sample dressed up as a KPI.
 *
 * See docs/features/bank-preferred-routing.md §10.
 */

/** One person, as the band needs them: which rail, and are they payable on it. */
export interface RailAssignment {
  /** The rail Payment Dispatch would route them on; null when nothing resolves. */
  rail: ProcessorId | null;
  /** `isPayoutComplete` — everything that rail needs is on file. */
  payable: boolean;
}

export interface RailSlice {
  key: ProcessorId;
  /** "Hurupay", "Wires", … */
  label: string;
  /** People routed on this rail. */
  count: number;
  /** Of those, how many are payable on it. `payable <= count` always. */
  payable: number;
  /** What the rail needs, for the receiving row's caption. */
  requires: PayoutRequirement;
  /** True for hurupay / higlobe / wepay: the money lands in a wallet. */
  wallet: boolean;
}

export interface RailMix {
  /** Everyone counted. `total === routed + unrouted`. */
  total: number;
  /** People a rail resolves for. `routed === Σ rails.count`. */
  routed: number;
  /** No rail resolves — Payment Dispatch excludes them as `no_bank`. */
  unrouted: number;
  /** Rails worth a row, biggest first. See {@link railRows}. */
  rails: RailSlice[];
  /** Payable across every rail. `payable === Σ rails.payable`. */
  payable: number;
  /** Routed people on a wallet rail. `wallet + bankRail === routed`. */
  wallet: number;
  /** Routed people on a bank rail (wise / jeeves / wires). */
  bankRail: number;
}

const RAIL_LABEL = new Map<ProcessorId, string>(PROCESSOR_OPTIONS.map((p) => [p.id, p.label]));

/** count desc, then label asc — deterministic, so the band never reshuffles. */
function bySizeThenName(a: RailSlice, b: RailSlice): number {
  return b.count - a.count || a.label.localeCompare(b.label);
}

/**
 * Which rails deserve a row, and the rule is not "the enum":
 *
 *   - **any rail somebody is actually on**, retired or not. Wise and Jeeves are
 *     retired from the pickers yet still carry live payees, and a rail with people
 *     on it must never be hidden from Accounting.
 *   - plus every **still-offered** rail at zero, because "Hurupay: 0" is a real
 *     answer and a missing row is indistinguishable from a forgotten one.
 *   - a rail that is **both retired and empty** is dropped. That is Wepay today,
 *     and it is dropped BY RULE, not by name: the row returns by itself the moment
 *     one payee lands on it, so no hand-kept exclusion list can go stale.
 */
function railRows(counts: Map<ProcessorId, { count: number; payable: number }>): RailSlice[] {
  const offered = new Set<string>(SELECTABLE_PROCESSOR_OPTIONS.map((p) => p.id));
  const rows = PROCESSOR_OPTIONS.flatMap((p) => {
    const seen = counts.get(p.id);
    if (!seen && !offered.has(p.id)) return [];
    return [
      {
        key: p.id,
        label: RAIL_LABEL.get(p.id) ?? p.id,
        count: seen?.count ?? 0,
        payable: seen?.payable ?? 0,
        requires: payoutRequirementFor(p.id),
        wallet: isWalletRail(p.id),
      },
    ];
  });
  return rows.sort(bySizeThenName);
}

export function buildRailMix(people: readonly RailAssignment[]): RailMix {
  const counts = new Map<ProcessorId, { count: number; payable: number }>();
  let unrouted = 0;
  let payable = 0;
  let wallet = 0;
  let bankRail = 0;

  for (const p of people) {
    if (!p.rail) {
      // Unrouted people are never counted as payable: PD excludes them outright,
      // so folding them in would inflate the receiving card with rows nobody can
      // actually pay.
      unrouted += 1;
      continue;
    }
    const e = counts.get(p.rail) ?? { count: 0, payable: 0 };
    e.count += 1;
    if (p.payable) {
      e.payable += 1;
      payable += 1;
    }
    counts.set(p.rail, e);
    if (isWalletRail(p.rail)) wallet += 1;
    else bankRail += 1;
  }

  return {
    total: people.length,
    routed: people.length - unrouted,
    unrouted,
    rails: railRows(counts),
    payable,
    wallet,
    bankRail,
  };
}

/** A department label to bucket a person under. Blank / null becomes this key, so
 *  nobody is dropped: a filter never hides a row. */
export const NO_DEPARTMENT = '__none__';

export interface DeptRailAssignment extends RailAssignment {
  department: string | null;
}

/**
 * The same fold, once per department, so the department filter re-scopes the KPI
 * band instead of leaving it on org-wide figures beside a filtered list. Keys are
 * the department labels exactly as the roster reports them, so a caller can look
 * up the selected filter value directly.
 */
export function buildRailMixByDepartment(
  people: readonly DeptRailAssignment[],
): Record<string, RailMix> {
  const grouped = new Map<string, RailAssignment[]>();
  for (const p of people) {
    const key = (p.department ?? '').trim() || NO_DEPARTMENT;
    const entry: RailAssignment = { rail: p.rail, payable: p.payable };
    const bucket = grouped.get(key);
    if (bucket) bucket.push(entry);
    else grouped.set(key, [entry]);
  }
  const out: Record<string, RailMix> = {};
  for (const [dept, list] of grouped) out[dept] = buildRailMix(list);
  return out;
}
