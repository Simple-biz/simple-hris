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
import { sundayOf } from "@/lib/payroll/manila-week";

export type ParsedAdjustment = { amount: number; currency: PayCurrency };

/**
 * The pay-period Sunday a Hubstaff upload covers, read out of the
 * `…_YYYY-MM-DD_to_YYYY-MM-DD.csv` range every wizard batch filename carries
 * and snapped to its Sunday — the same anchor a note's `week_start` uses, so
 * the two can be compared directly.
 *
 * This is what lets the pull tell "this row belongs to the payroll I am running
 * now" from "this row was applied in an earlier week and is history". Null for a
 * hand-named upload with no range; callers then fall back to Done-only skipping.
 */
export function payWeekStartFromSourceFile(file: string | null | undefined): string | null {
  const m = /(\d{4}-\d{2}-\d{2})_to_\d{4}-\d{2}-\d{2}/.exec(file ?? "");
  return m ? sundayOf(m[1]!) : null;
}

/** Window event the Notes board's "Apply Changes" button dispatches
 *  (cancelable — the mounted wizard preventDefault()s to say it took it,
 *  then force-applies the board's amounts onto its Adj. overrides). */
export const APPLY_NOTE_ADJUSTMENTS_EVENT = "payroll-wizard:apply-note-adjustments";

/** Window event the board dispatches when a linked note's adjustment goes
 *  away — the row deleted, or its Adjustment cell cleared. detail:
 *  `{ workerEmail, adjustment, remaining? }` — the REMOVED text, plus the
 *  Adjustment texts of that worker's OTHER rows in the same pay week (the board
 *  works in raw text; only the wizard has the fx rates to total them).
 *
 *  The wizard acts only when its current override still equals the board's
 *  total BEFORE the removal, so a hand-typed wizard value is never touched by a
 *  stale board row. With `remaining` rows it drops back to their combined total
 *  (the removed amount is subtracted); with none left it clears the override. */
export const NOTE_ADJUSTMENT_REMOVED_EVENT = "payroll-wizard:note-adjustment-removed";

/** Shape of a {@link NOTE_ADJUSTMENT_REMOVED_EVENT} detail. */
export type NoteAdjustmentRemovedDetail = {
  workerEmail: string;
  /** The Adjustment text that just left the board. */
  adjustment: string;
  /** The worker's other Adjustment cells for the same pay week, still on the
   *  board. Absent/empty = that was their last one. */
  remaining?: string[];
};

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

// ── Several rows, one worker, one week: combine ──────────────────────────────

/**
 * The identity of "the same amount written twice" — currency + cents, NOT the
 * PHP conversion. Two cells are duplicates only when they say the same thing
 * ("500" twice); "500" and "$8.93" may convert to nearly the same peso figure
 * yet are plainly two different notes.
 */
export function adjustmentDupKey(parsed: ParsedAdjustment): string {
  return `${parsed.currency}:${Math.round(parsed.amount * 100)}`;
}

/** The minimum a caller must hand {@link combineAdjustments}: the cell text, what
 *  it parsed to, and that amount in PHP (the override's currency). Callers pass
 *  their own richer row objects — the generic gives them back unchanged. */
export type AdjustmentContribution = {
  /** The Adjustment cell exactly as written — quoted back in warnings. */
  text: string;
  /** Currency + signed amount read out of {@link parseAdjustmentAmount}. */
  parsed: ParsedAdjustment;
  /** The same amount converted to PHP at the caller's live fx rates. */
  php: number;
};

export type CombinedAdjustment<T> = {
  /** What the worker's Adj. override should be, in PHP, cents-rounded. */
  total: number;
  /** The rows that fed `total`, oldest → newest. */
  counted: T[];
  /** Rows dropped as suspected duplicates — same currency AND same amount as a
   *  row already counted. Deliberately NOT summed; the clerk is warned instead. */
  duplicates: T[];
  /** `total` after each counted row, oldest → newest (so the last entry IS
   *  `total`). Lets a caller recognise an override this same board produced at
   *  an earlier point in time — see {@link isBoardDerivedTotal}. */
  runningTotals: number[];
};

/**
 * Fold every board amount a worker carries for one pay week into the single
 * figure the wizard's Adj. column holds.
 *
 * Two rules, both the clerk's stated intent (changed 2026-07-29 — this used to
 * be "newest row wins", which silently dropped the other amount):
 *
 * 1. **Different amounts are ADDED** — signed, so `+₱500` and `-₱200` make
 *    `+₱300`. Two notes about one person in one week are two separate pay
 *    changes, and payroll owes them both.
 * 2. **An identical amount repeated is counted ONCE** — the same figure in the
 *    same currency twice is far more likely one item entered twice than two
 *    coincidentally equal ones, and paying a duplicate is the expensive
 *    mistake. It is never silent: the repeat lands in `duplicates`, the board
 *    flags both rows, and the wizard warns by name. If both really are owed,
 *    the clerk combines them into one cell (`+₱1,000`) and the pair becomes a
 *    single amount again.
 *
 * Order matters only for the audit trail (`counted` / `runningTotals` follow the
 * caller's order — the wizard passes oldest-written first); the total does not
 * depend on it.
 */
export function combineAdjustments<T extends AdjustmentContribution>(
  contributions: readonly T[],
): CombinedAdjustment<T> {
  const counted: T[] = [];
  const duplicates: T[] = [];
  const runningTotals: number[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const c of contributions) {
    const key = adjustmentDupKey(c.parsed);
    if (seen.has(key)) {
      duplicates.push(c);
      continue;
    }
    seen.add(key);
    counted.push(c);
    total = Math.round((total + c.php) * 100) / 100;
    runningTotals.push(total);
  }
  return { total, counted, duplicates, runningTotals };
}

/**
 * Whether an Adj. override the wizard is already holding is one THIS board
 * group produced, in any of the three shapes it could have taken:
 *
 *  - its **final total** (already applied — a no-op),
 *  - an earlier **running total** (the state before another row was written),
 *  - a **single row's amount** — which is what the bridge applied for any group
 *    before 2026-07-29, when the newest row simply won. Without this the three
 *    workers found short on week 2026-07-19 (₱4,750 saved where the board says
 *    ₱6,600) would never have self-healed; only a manual Apply Changes would fix
 *    them, which is exactly the "someone has to remember" failure the bridge
 *    keeps being bitten by.
 *
 * This is what lets the automatic, merge-only pull upgrade `+₱500` to `+₱1,100`
 * when a second row appears, while still refusing to touch a figure accounting
 * typed by hand — anything that isn't one of the above is treated as hand-typed
 * and left alone.
 */
export function isBoardDerivedTotal<T extends AdjustmentContribution>(
  existing: number,
  combined: Pick<CombinedAdjustment<T>, "total" | "runningTotals" | "counted" | "duplicates">,
): boolean {
  if (Math.abs(existing - combined.total) <= 0.01) return true;
  if (combined.runningTotals.some((t) => Math.abs(t - existing) <= 0.01)) return true;
  return [...combined.counted, ...combined.duplicates].some(
    (c) => Math.abs(c.php - existing) <= 0.01,
  );
}

/**
 * Parse + convert a list of raw Adjustment cells (unparseable ones dropped) and
 * combine them. The board side of the bridge works in raw text — it has no fx
 * rates of its own — so this is how a retraction tells the wizard what the
 * worker's remaining board total is.
 */
export function combineAdjustmentTexts(
  texts: readonly (string | null | undefined)[],
  fx: { usdToPhp: number; usdToCop: number },
): CombinedAdjustment<AdjustmentContribution> {
  const contributions: AdjustmentContribution[] = [];
  for (const raw of texts) {
    const text = (raw ?? "").trim();
    const parsed = parseAdjustmentAmount(text);
    if (!parsed) continue;
    const php = adjustmentToPhp(parsed, fx);
    if (php === null) continue;
    contributions.push({ text, parsed, php });
  }
  return combineAdjustments(contributions);
}
