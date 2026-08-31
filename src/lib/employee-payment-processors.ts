import type { LucideIcon } from 'lucide-react';
import { Banknote, Wallet } from 'lucide-react';

/**
 * Company-approved payout processors. Keep in sync with mock-queue.ts ProcessorId
 * and references/add_preferred_processor.sql.
 */
export const PROCESSOR_OPTIONS = [
  // `id` stays 'hurupay' FOREVER — it is the stored value in
  // employee_ids.bank_preferred / preferred_processor and the literal the WIRES
  // lock keys on. Only the human-facing `label` follows the 2026-08-24 rebrand.
  { id: 'hurupay', label: 'Kolan', blurb: 'Email only', Icon: Wallet, logoSrc: '/kolan.svg' },
  { id: 'wepay', label: 'Wepay', blurb: 'Email only', Icon: Wallet },
  { id: 'higlobe', label: 'Higlobe', blurb: 'Email + account holder', Icon: Wallet, logoSrc: '/higlobe.png' },
  { id: 'wise', label: 'Wise', blurb: 'Bank wire details', Icon: Wallet, logoSrc: '/wise.png' },
  { id: 'jeeves', label: 'Jeeves', blurb: 'Phone + wire details', Icon: Wallet, logoSrc: '/jeeves.png' },
  { id: 'wires', label: 'Wires', blurb: 'Manual bank wire', Icon: Banknote },
] as const;

export type ProcessorId = (typeof PROCESSOR_OPTIONS)[number]['id'];

/**
 * Processors retired from the selection UI. They stay in PROCESSOR_OPTIONS /
 * ProcessorId so existing records (and the dispatch pipeline) keep resolving
 * their labels and detail fields — they're just no longer offered for new
 * selections in the employee/contractor pickers.
 */
export const RETIRED_PROCESSOR_IDS: ProcessorId[] = ['wepay', 'wise', 'jeeves'];

/** PROCESSOR_OPTIONS minus retired ones — use this to render pickers. */
export const SELECTABLE_PROCESSOR_OPTIONS = PROCESSOR_OPTIONS.filter(
  (p) => !RETIRED_PROCESSOR_IDS.includes(p.id),
);

/**
 * Employee-facing pickers (Employee Dashboard payment method, Payroll
 * Readiness "Set bank details", People tab) offer Wise again as of 2026-07-25.
 * Wise stays retired for NEW contractor-invoice gateway selections, which keep
 * using SELECTABLE_PROCESSOR_OPTIONS.
 */
export const EMPLOYEE_SELECTABLE_PROCESSOR_OPTIONS = PROCESSOR_OPTIONS.filter(
  (p) => !RETIRED_PROCESSOR_IDS.includes(p.id) || p.id === 'wise',
);

export type ProcessorOption = {
  id: ProcessorId;
  label: string;
  blurb: string;
  Icon: LucideIcon;
  logoSrc?: string;
};

export function isProcessorId(v: string): v is ProcessorId {
  return PROCESSOR_OPTIONS.some((p) => p.id === v);
}

/**
 * Map a free-text "Bank Preferred" value (legacy rates-sheet cell, or a stored
 * pick) to a ProcessorId. The shared, pure mirror of Payment Dispatch's
 * `processorIdFromBankPreferred` (mock-queue.ts) and pay-schedule's private
 * copy, so server code (payout completeness, readiness) resolves the SAME
 * processor PD would route on. Account-suffix codes ("x1153", "x1161", …) are
 * manually-keyed wires.
 */
export function processorIdFromBankPreferredText(raw: string | null | undefined): ProcessorId | null {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  if (!v) return null;
  // 'kolan' is the post-rebrand spelling of the SAME rail — a sheet cell that
  // says "Kolan" must resolve to the hurupay processor, or the person routes to
  // nothing and Payment Dispatch drops them from the queue entirely.
  if (v === 'hurupay' || v === 'huru' || v === 'huropay' || v === 'kolan') return 'hurupay';
  if (v === 'wepay') return 'wepay';
  if (v === 'higlobe' || v === 'higloble' || v === 'higlobel') return 'higlobe';
  if (v === 'wise' || v === 'transferwise') return 'wise';
  if (v === 'jeeves') return 'jeeves';
  if (/^x?\d{3,5}$/.test(v) || v === 'wire' || v === 'wires' || v.startsWith('wire')) return 'wires';
  return null;
}

/**
 * "WIRES" is the residual send-from rail: anything that is NOT explicitly
 * `hurupay` or `higlobe` is treated as WIRES. That deliberately includes
 * `wires`, `x1153`, retired processors, legacy free-text, and null/unset — a
 * WIRES recipient is paid by bank wire and physically cannot receive via the
 * Kolan/HiGlobe wallets.
 *
 * `kolan` counts as the hurupay wallet and NOTHING else is widened: it is the
 * rebranded spelling of that exact rail, so reading it as WIRES would be a
 * misclassification that permanently locks a wallet payee out of their own rail
 * (isBankPreferredTransitionAllowed blocks wires → wallet). Every other legacy
 * spelling — including 'huru'/'huropay' — stays WIRES exactly as before.
 */
export function isWiresPreferred(value: string | null | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v !== 'hurupay' && v !== 'kolan' && v !== 'higlobe';
}

/**
 * The two WALLET rails. Money on these lands in a wallet the recipient tops up
 * from, so the rail Accounting sends FROM and the channel the employee receives
 * ON are physically the same account. Every other rail (wise / jeeves / wires)
 * sends from one place into the person's own bank, so the two stay independent.
 */
export const WALLET_RAILS = ['hurupay', 'higlobe'] as const satisfies readonly ProcessorId[];

/**
 * Whether a stored Bank Preferred value is an EXPLICIT non-wallet rail — the
 * thing the WIRES lock actually protects.
 *
 * Deliberately NOT the same predicate as `isWiresPreferred`. That one answers
 * "which rail does this person get paid on?", where an unset value correctly
 * falls into the WIRES residual — a person with no rail is paid by wire. This
 * one answers "is this person LOCKED OUT of the wallet rails?", and never having
 * been assigned a rail is not a lockout. Before 2026-08-24 the two questions
 * shared one predicate, so a payee whose `bank_preferred` had simply never been
 * populated could never be put on Kolan/HiGlobe at all — including every new
 * hire. Kane's ruling: unset ⇒ assignable; explicitly on wires ⇒ still locked.
 *
 * `wires` / `x1153` / legacy free-text ⇒ locked. `null` / `''` / whitespace ⇒ not locked.
 */
export function isWalletRailLocked(current: string | null | undefined): boolean {
  const v = (current ?? '').trim();
  if (!v) return false; // never assigned a rail — not a lockout
  return isWiresPreferred(v);
}

// `isBankPreferredTransitionAllowed(current, next)` — the stored-transition WIRES
// lock — was REMOVED 2026-08-31 PM, superseded by the stateless, receiving-keyed
// `isBankPreferredAllowedForReceiving` below (Kane's 1:1 ruling). Do not
// reintroduce a transition-history guard: the verdict now derives from the LIVE
// receiving channel on every write, which has no clear-then-set laundering walk
// to defend against. See bank-preferred-routing.md §4.

/**
 * The Disbursement channel that must follow a Bank Preferred pick, or `null`
 * when the pick imposes nothing.
 *
 * Only the WALLET rails mirror. Setting Bank Preferred to Kolan means Accounting
 * pays out of Kolan into the employee's Kolan wallet — there is no coherent way
 * for the person to "receive on" anything else, so leaving Disbursement pointed
 * at Wise just asks the employee for detail fields nobody will use. Wise /
 * Jeeves / Wires impose nothing and keep the two fields independent, which is
 * what the original 2026-07-22 decoupling was protecting.
 *
 * This never touches the RECEIVING ACCOUNT (account_number / swift_code /
 * wallet-email columns) — that remains the employee's own data.
 */
export function mirroredDisbursementFor(
  bankPreferred: string | null | undefined,
): ProcessorId | null {
  const rail = processorIdFromBankPreferredText(bankPreferred);
  if (!rail) return null;
  return (WALLET_RAILS as readonly ProcessorId[]).includes(rail) ? rail : null;
}

/**
 * "Bank Preferred" dropdown (Employee Profile → Payment). This is a SEPARATE
 * field from the Disbursement picker (`preferred_processor`): it stores the
 * processor Payment Dispatch should route the salary through, in its own
 * `employee_ids.bank_preferred` column. Each option maps to a processor id.
 *
 * `x1153` is a specific wire account, not a distinct processor, so it maps to
 * `wires`. Because `wires` has no dedicated non-x1153 option here, a saved
 * `wires` value displays as "x1153" in this dropdown. See the design doc.
 */
/**
 * The WALLET rail this receiving channel is, or null when it is a bank rail /
 * unset / unrecognised text. Normalises through the text resolver so `kolan`
 * reads as the hurupay rail.
 */
export function walletFromReceiving(receiving: string | null | undefined): ProcessorId | null {
  const rail = processorIdFromBankPreferredText(receiving);
  if (!rail) return null;
  return (WALLET_RAILS as readonly ProcessorId[]).includes(rail) ? rail : null;
}

/**
 * **THE 1:1 RULE (Kane, 2026-08-31 PM).** The RECEIVING bank drives the
 * send-from rail:
 *
 * - Receiving = Kolan/HiGlobe ⇒ Bank Preferred must be **that same wallet**
 *   (or unset — tier 2 already routes them there). "Send from x1153/Wise into a
 *   Kolan wallet" describes nothing real; the wallet is topped up from itself.
 * - Receiving = a bank rail (or nothing) ⇒ Bank Preferred must **not** be a
 *   wallet — a wallet deposit needs its wallet, wire details can't substitute.
 *
 * This SUPERSEDES the stored-transition WIRES lock
 * (`isBankPreferredTransitionAllowed`) at the write sites: the verdict is
 * **stateless**, judged against the live receiving channel on every write, so
 * there is no clear-then-set laundering walk to guard against. It is tighter
 * than the old rule in one direction — wallet → wires used to be allowed, and
 * under this rule a wallet payee can never be pointed at x1153/Wise — and looser
 * in the other, by design: a payee whose receiving genuinely IS a wallet is no
 * longer barred from having their send-from say so.
 */
export function isBankPreferredAllowedForReceiving(
  receiving: string | null | undefined,
  next: string | null | undefined,
): boolean {
  const to = processorIdFromBankPreferredText(next);
  if (!to) return true; // clearing / unset is always writable; routing falls to tier 2
  const wallet = walletFromReceiving(receiving);
  if (wallet) return to === wallet;
  // NO receiving channel at all → anything goes: a wallet send-from assigned
  // here is completed into a 1:1 pair by the forward mirror
  // (mirroredDisbursementFor sets receiving to match). This is the new-hire
  // assignment path and Kane's 2026-08-24 "unassigned ⇒ assignable" ruling.
  if (!processorIdFromBankPreferredText(receiving)) return true;
  // Receiving is a BANK rail → never send from a wallet the person cannot
  // receive into.
  return !(WALLET_RAILS as readonly ProcessorId[]).includes(to);
}

/**
 * The reverse of `mirroredDisbursementFor`: the Bank Preferred value a RECEIVING
 * pick imposes, or null when it imposes nothing. Wallet receiving pins the
 * send-from to the same wallet (the 1:1 rule); bank rails impose nothing.
 */
export function mirroredBankPreferredFor(
  receiving: string | null | undefined,
): ProcessorId | null {
  return walletFromReceiving(receiving);
}

export const BANK_PREFERRED_OPTIONS: { label: string; id: ProcessorId }[] = [
  { label: 'HiGlobe', id: 'higlobe' },
  { label: 'Kolan', id: 'hurupay' },
  { label: 'Jeeves', id: 'jeeves' },
  { label: 'Wise', id: 'wise' },
  { label: 'x1153', id: 'wires' },
];

/**
 * The Bank Preferred options a picker may offer, keyed on the person's RECEIVING
 * channel (the 1:1 rule, Kane 2026-08-31 PM):
 *
 * - Receiving = Kolan/HiGlobe → exactly **that wallet**. The send-from is pinned;
 *   there is nothing else it can coherently be.
 * - Receiving = a bank rail (wise/jeeves/wires/wepay) → the bank options only
 *   (Jeeves / Wise / x1153). A wallet send-from needs a wallet to land in.
 * - No receiving channel at all → the full list; picking a wallet here mirrors
 *   the receiving channel to match server-side.
 *
 * Pass the LIVE receiving value the form is about to save, so the options track
 * the pick in real time and never offer what the API will refuse. `audience`
 * decides whether Wise is offered as a send-from: Accounting-only (People →
 * Banking); employees can hold a stored Wise but not newly pick it.
 */
export function selectableBankPreferredOptions(
  receiving: string | null | undefined,
  audience: 'employee' | 'accounting',
): { label: string; id: ProcessorId }[] {
  const wallet = walletFromReceiving(receiving);
  if (wallet) return BANK_PREFERRED_OPTIONS.filter((o) => o.id === wallet);
  const rail = processorIdFromBankPreferredText(receiving);
  const base = rail
    ? BANK_PREFERRED_OPTIONS.filter((o) => isWiresPreferred(o.id))
    : BANK_PREFERRED_OPTIONS;
  // Wise as a SEND-FROM rail is Accounting's call, made in People → Banking
  // (Kane, 2026-08-31 PM: "only accounting can set wise as their sending
  // banks"). Employees never get it as a new pick; a STORED wise still
  // displays, because the select's value is rendered independently of the
  // option list.
  return audience === 'employee' ? base.filter((o) => o.id !== 'wise') : base;
}

/** The server-resolved effective rail from a `walletRail` payload, or null. */
export function walletRailEffectiveFromPayload(payload: unknown): ProcessorId | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = (payload as { effectiveRail?: unknown }).effectiveRail;
  return typeof raw === 'string' && isProcessorId(raw) ? raw : null;
}

/** The dropdown label to show for a saved `preferred_processor` value. Returns
 *  '' when nothing is selected or the value isn't one of the offered options. */
export function bankPreferredLabelForProcessor(p: ProcessorId | ''): string {
  if (!p) return '';
  return BANK_PREFERRED_OPTIONS.find((o) => o.id === p)?.label ?? '';
}

/** The `preferred_processor` id for a chosen dropdown label. */
export function processorForBankPreferredLabel(label: string): ProcessorId | undefined {
  return BANK_PREFERRED_OPTIONS.find((o) => o.label === label)?.id;
}

export function processorDescription(p: ProcessorId): string {
  switch (p) {
    case 'hurupay':
      return 'Tell us which email Kolan should deposit to.';
    case 'wepay':
      return 'Tell us which email Wepay should deposit to.';
    case 'higlobe':
      return 'HiGlobe needs the email and the name on your account.';
    case 'wise':
      return 'Wise payouts are sent to your bank account — account, SWIFT code, and full address.';
    case 'jeeves':
      return 'Jeeves needs your phone plus full bank wire details.';
    case 'wires':
      return 'Manual bank wires need your account, SWIFT code, and full address.';
  }
}
