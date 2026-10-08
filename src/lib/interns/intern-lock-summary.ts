/**
 * What the interns receive for ONE week, per intern — the figure the Review &
 * lock in step and its confirm dialog show. Pure and client-safe.
 *
 * Why it exists (Open item 396, the 2026-10-07 call): Step 4 said "To the
 * interns ₱4,164.00" with nothing beside it, and Alivia read that as every week
 * so far. It is one week's total for every intern. So the figure now says
 * "this week", how many interns it covers, and each intern's line under it:
 * hours paid, hours the caps removed, and their amount.
 *
 * Display only. It sums figures the ONE pricer already produced
 * (`priceInternWeek` → `splitInternGross`, via the server preview or the stored
 * row) and never prices anything itself. A refused row is left out, because
 * Lock in writes priced rows only (`internPayRowsFromPreview`).
 */

export interface InternLockSummaryRow {
  /** Stable React key — the intern's email. */
  key: string;
  name: string;
  /** Why the row could not be priced; null when priced. */
  refusal: string | null;
  hoursPaid: number;
  /** Logged hours the daily and weekly caps removed (shown, never paid). */
  cappedOff: number;
  /** The intern's share of gross (the remainder after the orphanage share). */
  internPhp: number;
}

export interface InternLockSummaryLine {
  key: string;
  name: string;
  hoursPaid: number;
  hoursCapped: number;
  amountPhp: number;
}

export interface InternLockSummary {
  internCount: number;
  /** Σ of the lines' amounts — the headline is always the sum of what is under it. */
  totalPhp: number;
  hoursPaid: number;
  hoursCapped: number;
  /** Interns with at least one capped hour this week. */
  internsCapped: number;
  lines: InternLockSummaryLine[];
}

// Same half-up 2dp as the pricer (intern-week-pay.ts).
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function internLockSummary(rows: readonly InternLockSummaryRow[]): InternLockSummary {
  const lines: InternLockSummaryLine[] = rows
    .filter((r) => r.refusal == null)
    .map((r) => ({
      key: r.key,
      name: r.name,
      hoursPaid: round2(r.hoursPaid),
      hoursCapped: round2(Math.max(0, r.cappedOff)),
      amountPhp: round2(r.internPhp),
    }));
  const sum = (f: (l: InternLockSummaryLine) => number) => round2(lines.reduce((s, l) => s + f(l), 0));
  return {
    internCount: lines.length,
    totalPhp: sum((l) => l.amountPhp),
    hoursPaid: sum((l) => l.hoursPaid),
    hoursCapped: sum((l) => l.hoursCapped),
    internsCapped: lines.filter((l) => l.hoursCapped > 0).length,
    lines,
  };
}
