'use client';

/**
 * The read-only payout body: the bank card, the wallet identity fields, and the
 * folded Routing & rail details. MOVED out of `PersonDetailDialog`
 * (PeopleTab.tsx) on 2026-09-25 so People → Search Bar renders the SAME body
 * inline; the popup's output is unchanged. See people-bank-card.md §9 and
 * people-bank-search.md.
 *
 * It renders whatever record it is handed and fetches nothing. Both hosts show
 * it only AFTER the audited reveal (`POST /api/people/[email]/reveal-banking`)
 * has replaced the masked record, never before: a masked `••••1234` handed to
 * the card's copy button would put bullets on the clipboard of a money field
 * (people-bank-card.md §5, §9).
 *
 * The Routing disclosure is CONTROLLED by the host. The popup keeps that state
 * on the dialog, so it survives a tab switch or an edit round trip exactly as
 * it did before the move; the Search Bar page holds its own.
 */

import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { BankCard } from '@/components/banking/bank-card';
import { pickPreferredBank } from '@/lib/banking/preferred-bank';
import { payoutRailView, payoutRailFromStored } from '@/lib/banking/payout-rail-view';
import { cn } from '@/lib/utils';

export interface Banking {
  /** Send-from rail ("Bank Preferred") — wins Payment Dispatch routing. */
  bank_preferred: string | null;
  /** The rail Payment Dispatch actually routes this person on (server-resolved
   *  with PD's full precedence incl. the legacy rates-sheet fallback). */
  effective_processor: string | null;
  effective_processor_source: 'bank_preferred' | 'disbursement' | 'rates_sheet' | null;
  preferred_processor: string | null;
  preferred_bank_slot: string | null;
  bank_name: string | null;
  account_holder_name: string | null;
  account_number: string | null;
  routing_number: string | null;
  swift_code: string | null;
  full_address: string | null;
  alt_bank_name: string | null;
  alt_account_holder_name: string | null;
  alt_account_number: string | null;
  alt_routing_number: string | null;
  hurupay_email: string | null;
  wepay_email: string | null;
  higlobe_email: string | null;
  higlobe_account_name: string | null;
  wise_email: string | null;
  wise_tag: string | null;
  phone_number: string | null;
  bank_last_self_updated_at?: string | null;
  masked: boolean;
}

/** Skeleton geometry for the reveal, mirroring the eight fields the Banking block
 *  actually renders (three routing fields, then bank/holder/account/SWIFT/routing).
 *  Varied widths on purpose — a grid of identical bars reads as a placeholder
 *  graphic rather than as the record that is loading. */
const REVEAL_SKELETON_WIDTHS: readonly [string, string][] = [
  ['w-28', 'w-40'],
  ['w-24', 'w-20'],
  ['w-20', 'w-16'],
  ['w-10', 'w-32'],
  ['w-20', 'w-36'],
  ['w-16', 'w-28'],
  ['w-12', 'w-24'],
  ['w-14', 'w-20'],
];

/** The reveal's in-place loading content: the audit-log line over a skeleton of
 *  the field grid (people-bank-card.md §6). Each host wraps it in its own
 *  bordered, `aria-busy` region. */
export function PayoutRevealSkeletonContent() {
  return (
    <>
      <p className="mb-3 flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
        Revealing payout details — this is recorded in the audit log.
      </p>
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {REVEAL_SKELETON_WIDTHS.map(([labelW, valueW], i) => (
          <div key={i} className="space-y-1.5">
            <div className={cn('skeleton-shimmer h-2.5 rounded', labelW)} />
            <div className={cn('skeleton-shimmer h-3.5 rounded', valueW)} />
          </div>
        ))}
      </div>
    </>
  );
}

/** One person's revealed payout record. `banking` null = no payout details on file. */
export function PayoutRecordBody({
  banking,
  reduceMotion,
  routingOpen,
  onToggleRouting,
}: {
  banking: Banking | null;
  reduceMotion: boolean;
  routingOpen: boolean;
  onToggleRouting: () => void;
}) {
  const showRouting = routingOpen;
  // Preferred bank slot first, falling back to the OTHER slot per field — the
  // same pickFirst rule Payment Dispatch's queue row uses (buildPayeeDetails in
  // mock-queue.ts), so a person whose details live only in the non-preferred
  // slot still shows the account PD pays to instead of a blank. name/holder/
  // account/swift come from the ONE shared cross-slot rule (also used by the
  // employee's own Profile) — see people-bank-card.md §2 on why a second copy
  // of this rule is exactly the drift that produces a wrong printed account.
  // `routing` and `address` are wire-instruction fields with no alternative-
  // slot equivalent question to answer here, so they stay local.
  const prefBank = pickPreferredBank(banking);
  const firstOf = (...vals: (string | null | undefined)[]) =>
    vals.find((v) => v != null && String(v).trim() !== '') ?? null;
  const prefRouting = prefBank.isAlternativeSlot
    ? firstOf(banking?.alt_routing_number, banking?.routing_number)
    : firstOf(banking?.routing_number, banking?.alt_routing_number);
  const prefAddress = banking?.full_address ?? null;
  // Show the details of the rail Payment Dispatch ACTUALLY routes this person
  // on (server-resolved: bank_preferred → Disbursement pick → legacy rates
  // cell) — not the raw Disbursement pick, which can disagree with how the
  // person is really paid. Unknown/empty falls back to a bank if one exists.
  const proc = (banking?.effective_processor ?? banking?.preferred_processor ?? '')
    .trim()
    .toLowerCase();
  // wires, jeeves AND wise all carry full bank/wire details (jeeves also shows
  // phone). Wise payees are paid into their bank account, not a Wise handle —
  // same field set as wires (mirrors the Readiness Set-bank editor).
  //
  // The four comparisons that used to be spelled out here now come from the ONE
  // shared gate, which the employee's own Payout section reads too — see
  // src/lib/banking/payout-rail-view.ts. They agreed while both were hand-written
  // (the same `resolveEffectivePayoutProcessor` feeds both), but only one of them
  // had a test, so the drift would have been invisible: a seventh processor would
  // turn that test red, someone would patch the helper, and THIS pane would go on
  // showing that payee an empty panel.
  //
  // `proc` is a RAW string and can legitimately hold 'ach', the contractor-invoice
  // rail, which is not a ProcessorId. `payoutRailFromStored` is what keeps that
  // distinct from "nothing stored": casting it, or narrowing it to null, would
  // drop 'ach' into the bank-name fallback and print a contractor a bank card.
  const railView = payoutRailView(payoutRailFromStored(proc), !!prefBank.name);
  const showBank = railView.showBankCard;

  return (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 text-[13px] dark:border-zinc-800 dark:bg-zinc-900/40">
        {!banking ? (
          <p className="mb-2 text-[11px] text-zinc-400">No payout details on file yet — these fields will populate once the employee completes their payout setup.</p>
        ) : banking.masked ? (
          <p className="mb-2 text-[11px] text-zinc-400">Sensitive fields are masked. Reveal is recorded in the audit log.</p>
        ) : null}
        {/* The bank/wires field set is printed as the card it describes, and
            the four values on its face are NOT repeated in the grid below —
            one home per value, or the two copies drift the first time either
            is touched. Routing and Address stay in the grid: they are wire
            instructions, not anything a card face carries. */}
        {(showBank || !banking) && (
          <BankCard
            spelling={prefBank.name}
            holder={prefBank.holder}
            account={prefBank.account}
            swift={prefBank.swift}
            isAlternativeSlot={prefBank.isAlternativeSlot}
            reduceMotion={!!reduceMotion}
          />
        )}
        {/* The wallet identity fields are NOT folded away: for a Kolan,
            HiGlobe, WePay or Jeeves payee there is no card, and the wallet
            address IS their payout record — collapsing it would leave the
            panel showing nothing but a button. */}
        {railView.showWalletFields && (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {proc === 'hurupay' && <Field label="Kolan email" value={banking?.hurupay_email ?? null} />}
            {proc === 'wepay' && <Field label="WePay email" value={banking?.wepay_email ?? null} />}
            {proc === 'higlobe' && (
              <>
                <Field label="HiGlobe email" value={banking?.higlobe_email ?? null} />
                <Field label="HiGlobe account" value={banking?.higlobe_account_name ?? null} />
              </>
            )}
            {proc === 'jeeves' && <Field label="Phone" value={banking?.phone_number ?? null} mono />}
          </dl>
        )}
        {/* Everything that describes the RAIL rather than the account folds
            away (Kane, 2026-09-11). The card answers "where does this money
            land"; this answers "how does it get there", which is a second
            question and is not asked on most visits. */}
        <Disclosure
          open={showRouting}
          onToggle={onToggleRouting}
          label="Routing & rail details"
          reduceMotion={!!reduceMotion}
        >
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 pt-2 sm:grid-cols-2">
          {/* The routing picture, mirrored from Payment Dispatch:
              "Pays via" = the rail PD actually routes on; "Sends from" =
              the Bank Preferred send-from pick that wins precedence;
              "Disbursement pick" = how the employee elected to receive. */}
          <Field
            label="Pays via (Payment Dispatch)"
            value={
              banking?.effective_processor
                ? banking.effective_processor.charAt(0).toUpperCase() +
                  banking.effective_processor.slice(1) +
                  (banking.effective_processor_source === 'rates_sheet'
                    ? ' — routed by the rates sheet'
                    : banking.effective_processor_source === 'bank_preferred'
                      ? ' — via Bank Preferred'
                      : '')
                : banking
                  ? 'Not routed'
                  : null
            }
          />
          <Field
            label="Bank Preferred (send-from)"
            value={banking ? (banking.bank_preferred || 'Not set') : null}
            cap
          />
          <Field
            label="Disbursement pick"
            value={banking ? (banking.preferred_processor || 'Not set') : null}
            cap
          />
          {/* Bank, account holder, account number and SWIFT live on the card
              above. What is left is the wire detail a card face has no room
              for, still shown as placeholders when there is no record at all
              so the reader sees where details are expected.

              One home per value (people-bank-card.md §8): for an alternative-
              slot person, `alt_routing_number` is BOTH this row's source and
              the card's SWIFT source (there is no separate alt-slot routing
              column), so the two can print the identical string. When they do,
              this row is dropped rather than repeating what the card already
              shows — equality-based, so a genuinely different routing number
              still prints here, and nothing disappears when there's no
              duplicate to begin with. */}
          {(showBank || !banking) && (
            <>
              {(!prefRouting || prefRouting !== prefBank.swift) && (
                <Field label="Routing" value={prefRouting} mono />
              )}
              <Field label="Address" value={prefAddress} wide />
            </>
          )}
        </dl>
        </Disclosure>
        </div>
  );
}

/**
 * A folded section of the Banking panel.
 *
 * Both users of this are follow-up material: the rail details answer "how does the
 * money get there" and the change log answers "has this moved recently", while the
 * card above answers the question the tab is actually opened for. Folding them is
 * what lets the card be the whole screen on the common visit.
 *
 * The trigger states the section's own count where it has one, so a fold never hides
 * the fact that there is something inside — a collapsed "Bank change history" with
 * four entries behind it has to say four, or the panel quietly under-reports.
 */
export function Disclosure({
  open,
  onToggle,
  label,
  icon: Icon,
  count,
  reduceMotion,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  icon?: LucideIcon;
  /** Null while the count is still loading; a number renders as a chip. */
  count?: number | null;
  reduceMotion: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="group flex w-full items-center gap-1.5 rounded-md py-1 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 transition-colors hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
      >
        {Icon && <Icon className="h-3.5 w-3.5 text-emerald-500" />}
        <span>{label}</span>
        {typeof count === 'number' && count > 0 && (
          <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {count}
          </span>
        )}
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 transition-transform duration-200 motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="panel"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.26, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function Field({ label, value, mono, cap, wide }: { label: string; value: string | null; mono?: boolean; cap?: boolean; wide?: boolean }) {
  const empty = !value;
  return (
    <div className={cn(wide && 'sm:col-span-2')}>
      <dt className="text-[10.5px] uppercase tracking-wide text-zinc-400">{label}</dt>
      <dd
        className={cn(
          empty
            ? 'italic text-zinc-400 dark:text-zinc-500'
            : cn('text-zinc-800 dark:text-zinc-100', mono && 'font-mono', cap && 'capitalize'),
        )}
      >
        {empty ? 'Not yet filled' : value}
      </dd>
    </div>
  );
}
