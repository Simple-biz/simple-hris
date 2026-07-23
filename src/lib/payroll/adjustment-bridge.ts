/**
 * The Payroll Notes board's "Adjustment" column and the wizard's Additions
 * "Adj." override hold the same fact — a signed pay delta for a worker — in
 * two shapes: free text on the board ("+₱500", "-$25", "COP 50,000"), a
 * number in the wizard. These helpers translate between them, shared by the
 * wizard (client) and the notes bridge (server) so both sides always agree
 * on what parses.
 *
 * Currency: the wizard's override is ALWAYS a PHP amount (the whole wizard
 * computes in PHP and converts to USD/COP only at dispatch — see
 * current-pay.ts), so board text may be written in any of the org's pay
 * currencies and the PULL side converts at the wizard's live fx rates.
 */

import type { PayCurrency } from "@/lib/payment-catalog/pay-structure";

export type ParsedAdjustment = { amount: number; currency: PayCurrency };

/** Window event the Notes board's "Apply Changes" button dispatches
 *  (cancelable — the mounted wizard preventDefault()s to say it took it,
 *  then force-applies the board's amounts onto its Adj. overrides). */
export const APPLY_NOTE_ADJUSTMENTS_EVENT = "payroll-wizard:apply-note-adjustments";

/** Window event the board dispatches when a linked note's adjustment goes
 *  away — the row deleted, or its Adjustment cell cleared. detail:
 *  { workerEmail, adjustment } (the REMOVED text). The wizard clears its Adj.
 *  override only when the current override still equals that amount, so a
 *  hand-typed wizard value is never deleted by a stale board row. */
export const NOTE_ADJUSTMENT_REMOVED_EVENT = "payroll-wizard:note-adjustment-removed";

/**
 * The wizard broadcasts which pay period it is CURRENTLY on — its
 * `calcSourceFile` (the Hubstaff upload driving Initial Calculation, which may
 * be a replayed past week, not the newest upload). The floating Readiness board
 * follows this so its snapshot always describes the same week the accountant is
 * looking at in the wizard.
 *
 * Fired whenever `calcSourceFile` changes AND in reply to a
 * {@link REQUEST_WIZARD_CYCLE_EVENT} ping (so a board that mounts/opens after
 * the wizard already settled its file still learns it). detail:
 * `{ sourceFile: string | null }`.
 */
export const WIZARD_CYCLE_EVENT = "payroll-wizard:cycle";

/** The board pings this when it opens; a mounted wizard answers by dispatching
 *  {@link WIZARD_CYCLE_EVENT} with its current `calcSourceFile`. No detail. */
export const REQUEST_WIZARD_CYCLE_EVENT = "payroll-wizard:request-cycle";

/** Shape of a {@link WIZARD_CYCLE_EVENT} detail. */
export type WizardCycleDetail = { sourceFile: string | null };

/** "₱500" / "PHP 500" / "P500" → PHP · "$50" / "USD 50" → USD · "COP 50,000" / "$COP50000" → COP. */
function currencyFromMarker(marker: string | undefined): PayCurrency | null {
  const m = (marker ?? "").toUpperCase();
  if (m === "" ) return null;
  if (m === "COP" || m === "$COP") return "COP";
  if (m === "$" || m === "USD" || m === "US$") return "USD";
  if (m === "₱" || m === "PHP" || m === "P") return "PHP";
  return null;
}

/**
 * Read a signed amount + currency out of a notes-board Adjustment cell.
 *
 * Deliberately STRICT: the whole cell must be one amount with at most one
 * currency marker (prefix or suffix) — "+500", "-₱250.50", "$50", "USD 50",
 * "COP 50,000". A bare number is PHP (the payroll's home currency); prose
 * like "+500 bonus" or "-2 hrs" returns null, because a half-understood note
 * silently changing someone's pay is far worse than no autofill at all.
 */
export function parseAdjustmentAmount(text: string | null | undefined): ParsedAdjustment | null {
  const t = (text ?? "").trim();
  if (t === "") return null;
  const m =
    /^([+-])?\s*(\$COP|US\$|COP|USD|PHP|₱|\$|P)?\s*([\d,]+(?:\.\d+)?)\s*(\$COP|US\$|COP|USD|PHP|₱|\$|P)?$/i.exec(
      t,
    );
  if (!m) return null;
  const prefix = currencyFromMarker(m[2]);
  const suffix = currencyFromMarker(m[4]);
  if (prefix && suffix && prefix !== suffix) return null; // "₱50 USD" — ambiguous
  const value = Number(m[3]!.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return {
    amount: m[1] === "-" ? -value : value,
    currency: prefix ?? suffix ?? "PHP",
  };
}

/**
 * A parsed board amount as PHP, converted at the given rates (USD is the
 * org's anchor: COP goes COP → USD → PHP). Returns null when a needed rate
 * is missing/zero — better no autofill than a garbage conversion.
 */
export function adjustmentToPhp(
  parsed: ParsedAdjustment,
  fx: { usdToPhp: number; usdToCop: number },
): number | null {
  const php =
    parsed.currency === "PHP"
      ? parsed.amount
      : parsed.currency === "USD"
        ? fx.usdToPhp > 0
          ? parsed.amount * fx.usdToPhp
          : NaN
        : fx.usdToPhp > 0 && fx.usdToCop > 0
          ? (parsed.amount / fx.usdToCop) * fx.usdToPhp
          : NaN;
  return Number.isFinite(php) ? Math.round(php * 100) / 100 : null;
}

/** Render a wizard override as board text: 500 → "+₱500", -250.5 → "-₱250.50".
 *  Always ₱ — the override is PHP-denominated by construction. */
export function formatAdjustmentText(amount: number): string {
  const abs = Math.abs(amount);
  const rendered = Number.isInteger(abs) ? String(abs) : abs.toFixed(2);
  return `${amount < 0 ? "-" : "+"}₱${rendered}`;
}
