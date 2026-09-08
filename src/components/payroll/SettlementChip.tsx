'use client';

/**
 * The SETTLEMENT sticker — "this person is paid in a currency that is not the
 * peso" — shared by every surface that shows their money: the Manager KPI
 * Calculator, the Payroll Wizard, and Payment Dispatch. One component so the
 * three cannot drift into three different-looking answers to the same question.
 *
 * Three states, and the third is the one that matters. When the marker is
 * present but the FX rate is not licensed (this cycle's rate is still 0, or
 * only the official placeholders are stored), the chip goes AMBER and says so
 * rather than going quiet — the reader is looking at peso figures for someone
 * paid in COP, and that is exactly the moment to tell them. Amber is this app's
 * warning colour and is used here for nothing else; a working COP chip is teal
 * (matching the wizard's COP rate card) and USD is sky (matching the Payment
 * Catalog's non-PHP badge).
 *
 * See `src/lib/payroll/settlement-currency.ts` and
 * `docs/features/cop-country-payees.md`.
 */
import { cn } from '@/lib/utils';
import { CURRENCY_SYMBOL, type PayCurrency } from '@/lib/payment-catalog/pay-structure';
import type { SettlementRate } from '@/lib/payroll/settlement-currency';

const PESO = String.fromCharCode(0x20b1);

/**
 * What the chip knows about the figures beside it.
 *
 * A {@link SettlementRate} is the usual case: the surface converts pesos itself
 * and the chip reports whether that was licensed. `shown` is for a surface that
 * already holds a real native figure from its own source — Payment Dispatch
 * persists `amount_cop` on every row — so there is no rate to vouch for and
 * nothing to warn about. It exists so those surfaces don't have to invent a
 * `live` rate they can't actually prove.
 */
export type SettlementChipRate = SettlementRate | { status: 'shown' };

export function SettlementChip({
  currency,
  rate,
  className,
}: {
  /** The person's settlement currency, or null when they settle in PHP / have
   *  no onboarding paperwork — either way there is nothing to flag. */
  currency: PayCurrency | null | undefined;
  rate: SettlementChipRate;
  className?: string;
}) {
  if (!currency || currency === 'PHP') return null;
  const label = CURRENCY_SYMBOL[currency] ?? currency;

  if (rate.status === 'shown') {
    return (
      <span
        className={cn(
          'shrink-0 rounded px-1 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wide',
          currency === 'COP'
            ? 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300'
            : 'bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300',
          className,
        )}
        title={`Paid in ${currency} — they ride the ordinary PHP rails, so the figure shown is the ${currency} amount that reaches their bank.`}
      >
        {label}
      </span>
    );
  }

  if (rate.status !== 'live') {
    return (
      <span
        className={cn(
          'shrink-0 rounded bg-amber-100 px-1 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wide text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
          className,
        )}
        title={
          rate.status === 'unset'
            ? `Paid in ${currency} — but this cycle's USD rates are still 0, so their figures are shown in pesos. Set the rates in the Payroll Wizard (Step 2).`
            : `Paid in ${currency} — but only the placeholder USD rates are stored, so their figures are shown in pesos rather than a fabricated ${currency} number.`
        }
      >
        {label} · rate?
      </span>
    );
  }

  return (
    <span
      className={cn(
        'shrink-0 rounded px-1 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wide',
        currency === 'COP'
          ? 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300'
          : 'bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300',
        className,
      )}
      title={`Paid in ${currency} — their figures are the ${currency} amount that reaches their bank, converted from the peso-denominated pay at ${PESO}${rate.fx.usdToPhp.toLocaleString(
        'en-PH',
        { maximumFractionDigits: 4 },
      )}/$1 and ${CURRENCY_SYMBOL.COP}${rate.fx.usdToCop.toLocaleString('es-CO', {
        maximumFractionDigits: 4,
      })}/$1.`}
    >
      {label}
    </span>
  );
}
