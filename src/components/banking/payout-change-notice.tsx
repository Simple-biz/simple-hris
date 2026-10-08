'use client';

import { AlertTriangle, CreditCard, ShieldCheck, UserX, History } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { formatDateOnly } from '@/lib/date-only';
import {
  HOLDER_CONFIRM_TEXT,
  PAYOUT_CHANGE_NOTICE,
  type PayoutTrackRecord,
} from '@/lib/banking/payout-change-safety';

/**
 * The two employee-facing pieces of payout change safety (Kane, 2026-10-07),
 * shared by the public `/update-bank-info` page and Profile → Compensation →
 * Payout so the two surfaces can never word the warning differently. The copy is
 * NOT here: it is `PAYOUT_CHANGE_NOTICE` / `HOLDER_CONFIRM_TEXT`, versioned beside
 * the server gate that refuses a save without the acknowledgement.
 *
 * - `PayoutTrackLine` — how the account on file has done: "paid successfully N
 *   times, no problems on record". Read view and the top of the edit form.
 * - `PayoutChangeNotice` — the caution, the two conditional confirmations
 *   (card-shaped number, holder not the employee) and the acknowledgement.
 */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string | null) => (iso ? formatDateOnly(iso) : null);

/**
 * One line on the account's record. Renders NOTHING when there is no record to
 * speak of (`null`: the server did not send one; `none`: nothing on file names an
 * account). `unavailable` says so in words — never "0 payments", because a read
 * that failed is not a fact about the account.
 */
export function PayoutTrackLine({ track, className }: { track: PayoutTrackRecord | null; className?: string }) {
  if (!track) return null;
  if (track.status === 'unavailable') {
    return (
      <p className={cn('flex items-center gap-1.5 text-[12px] text-zinc-500 dark:text-zinc-400', className)}>
        <History className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Payment history for this account isn&rsquo;t available right now.
      </p>
    );
  }
  if (track.destination === 'none') return null;
  const noun = track.destination === 'wallet' ? 'wallet' : 'account';

  if (track.paidCount === 0) {
    return (
      <p className={cn('flex items-center gap-1.5 text-[12px] text-zinc-500 dark:text-zinc-400', className)}>
        <History className="h-3.5 w-3.5 shrink-0" aria-hidden />
        No payments to this {noun} on record yet.
      </p>
    );
  }

  const clean = track.problemCount === 0;
  const lastPaid = day(track.lastPaidOn);
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] leading-snug',
        clean
          ? 'border-emerald-200 bg-emerald-50/70 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-100'
          : 'border-amber-200 bg-amber-50/70 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100',
        className,
      )}
    >
      <ShieldCheck
        className={cn('mt-px h-4 w-4 shrink-0', clean ? 'text-emerald-600 dark:text-emerald-300' : 'text-amber-600 dark:text-amber-300')}
        aria-hidden
      />
      <p>
        <span className="font-semibold">
          Paid successfully {plural(track.paidCount, 'time', 'times')} to this {noun}
        </span>
        {clean ? (
          <> &mdash; no problems on record.</>
        ) : (
          <>
            {' '}&middot; {plural(track.problemCount, 'payment', 'payments')} had a problem
            {track.lastProblemOn ? ` (last on ${day(track.lastProblemOn)})` : ''}.
          </>
        )}
        {lastPaid && <span className="opacity-75"> Last paid {lastPaid}.</span>}
      </p>
    </div>
  );
}

export function PayoutChangeNotice({
  track,
  ownName,
  acknowledged,
  onAcknowledgedChange,
  cardShaped,
  cardConfirmed,
  onCardConfirmedChange,
  holderMismatch,
  holderConfirmed,
  onHolderConfirmedChange,
  disabled,
  idPrefix,
}: {
  /** The record of the account on file — what the employee is about to give up. */
  track: PayoutTrackRecord | null;
  /** The name the holder was compared with, printed in the mismatch box. */
  ownName: string | null;
  acknowledged: boolean;
  onAcknowledgedChange: (v: boolean) => void;
  /** A NEW account number in this draft has the shape of a card number. */
  cardShaped: boolean;
  cardConfirmed: boolean;
  onCardConfirmedChange: (v: boolean) => void;
  /** A holder name in this draft does not read as the employee's own. */
  holderMismatch: boolean;
  holderConfirmed: boolean;
  onHolderConfirmedChange: (v: boolean) => void;
  disabled?: boolean;
  /** Keeps checkbox ids unique when two forms could share a document. */
  idPrefix: string;
}) {
  const proven = track && track.status === 'ok' && track.destination !== 'none' && track.paidCount > 0 ? track : null;
  const noun = proven?.destination === 'wallet' ? 'wallet' : 'account';
  return (
    <div
      className="space-y-3 rounded-xl border border-amber-300 bg-amber-50/80 p-4 text-[12.5px] leading-relaxed text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100"
      role="region"
      aria-label="Before you change your bank details"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden />
        <div className="min-w-0 space-y-1.5">
          <p className="text-[13px] font-semibold">{PAYOUT_CHANGE_NOTICE.title}</p>
          {proven && (
            <p className="font-medium">
              Your current {noun} has been paid successfully {plural(proven.paidCount, 'time', 'times')}
              {proven.problemCount === 0 ? ' with no problems' : ''}. If you change it, your next payment goes
              to {noun === 'wallet' ? 'a wallet' : 'an account'} payroll has never paid before.
            </p>
          )}
          <p>{PAYOUT_CHANGE_NOTICE.intro}</p>
          <ul className="list-disc space-y-1 pl-4">
            {PAYOUT_CHANGE_NOTICE.rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="font-medium">{PAYOUT_CHANGE_NOTICE.responsibility}</p>
        </div>
      </div>

      {cardShaped && (
        <ConfirmBox
          id={`${idPrefix}-card`}
          icon={<CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-300" aria-hidden />}
          title="That account number looks like a card number"
          body="Card numbers (the 16 digits on the front of your ATM or debit card) usually cannot receive a bank transfer, and the payment will bounce. Check your bank app or passbook for your ACCOUNT number."
          label="I checked: this is my bank account number, not the number on my card."
          checked={cardConfirmed}
          onChange={onCardConfirmedChange}
          disabled={disabled}
        />
      )}
      {holderMismatch && (
        <ConfirmBox
          id={`${idPrefix}-holder`}
          icon={<UserX className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-300" aria-hidden />}
          title="The account holder doesn't match your name"
          body={`Payroll pays only accounts in your own name${ownName ? ` (on file: ${ownName})` : ''}. Do not use a spouse's, relative's or friend's account: get paid into your own account and send money on after you receive it.`}
          label={HOLDER_CONFIRM_TEXT}
          checked={holderConfirmed}
          onChange={onHolderConfirmedChange}
          disabled={disabled}
        />
      )}

      <label
        htmlFor={`${idPrefix}-ack`}
        className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-amber-300/80 bg-white/70 px-3 py-2.5 font-medium dark:border-amber-800/60 dark:bg-zinc-950/40"
      >
        <Checkbox
          id={`${idPrefix}-ack`}
          className="mt-0.5"
          checked={acknowledged}
          onCheckedChange={(v) => onAcknowledgedChange(v === true)}
          disabled={disabled}
        />
        <span>{PAYOUT_CHANGE_NOTICE.acknowledgement}</span>
      </label>
    </div>
  );
}

function ConfirmBox({
  id,
  icon,
  title,
  body,
  label,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  body: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-rose-300 bg-rose-50/80 px-3 py-2.5 text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-100">
      <div className="flex items-start gap-2">
        {icon}
        <div>
          <p className="font-semibold">{title}</p>
          <p className="mt-0.5 text-rose-800/90 dark:text-rose-200/80">{body}</p>
        </div>
      </div>
      <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5 pl-6 font-medium">
        <Checkbox
          id={id}
          className="mt-0.5"
          checked={checked}
          onCheckedChange={(v) => onChange(v === true)}
          disabled={disabled}
        />
        <span>{label}</span>
      </label>
    </div>
  );
}
