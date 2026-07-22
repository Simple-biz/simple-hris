/**
 * Signed-amount text-input parsing for the Payroll Wizard's Adjustment ("Adj.")
 * fields — the only inputs where accounting enters a SIGNED delta (a positive
 * addition or a negative deduction).
 *
 * Why not `<input type="number">`? A number input reports `e.target.value` as
 * an EMPTY STRING for any value the browser can't yet parse as a number — and
 * a lone "-" (the first keystroke of every negative amount) is exactly such a
 * value. The old handler did `raw === '' ? 0 : Number(raw)`, so typing "-"
 * silently reset the field to 0 and a negative adjustment could never be
 * entered. These inputs are therefore `<input type="text" inputMode="decimal">`
 * and parse through here, which distinguishes three cases the caller needs to
 * treat differently:
 *
 *   - a committed value  (`{ value: n,    incomplete: false }`) — update the model
 *   - a committed clear   (`{ value: null, incomplete: false }`) — empty/invalid
 *   - a mid-edit fragment (`{ value: null, incomplete: true  }`) — keep the raw
 *     text on screen, DON'T touch the model ("-", ".", "-." …)
 *
 * Mirrors the board Adjustment parser's tolerances (thousands separators, an
 * optional leading currency marker) so the two surfaces agree, but this one is
 * PHP-only and bare-number — the wizard's Adj. override is PHP by construction.
 */

export type SignedAmountInputResult = {
  /** The committed PHP amount, or null when there's nothing to commit
   *  (empty field, or an invalid/incomplete entry). */
  value: number | null;
  /** True while the text is a legal but unfinished number ("-", "-.", ".") —
   *  the caller keeps the raw string in the field and leaves the model as-is. */
  incomplete: boolean;
};

/** Fragments that are a legal start of a number but not yet a number:
 *  an optional sign followed by nothing or a bare decimal point. */
const INCOMPLETE_RE = /^[+-]?\.?$/;

/** A full signed decimal: optional sign, digits (with optional thousands
 *  separators) and/or a fractional part, and a permitted TRAILING dot
 *  ("5." — cents about to be typed). Rejects "5-", "--5", "1e3", "5.5.5". */
const COMPLETE_RE = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d*)?$/;

/**
 * Parse one keystroke's worth of an Adjustment text input.
 *
 * @param raw the input's current string value (untrimmed is fine)
 */
export function parseSignedAmountInput(raw: string): SignedAmountInputResult {
  // Drop surrounding whitespace and a single leading currency SYMBOL (₱ or $)
  // so a pasted "₱-500" or "-₱500" still parses; the sign may sit on either
  // side. Only the ₱/$ glyphs — never the letter "P" — so a typo'd letter is
  // rejected rather than silently committing as a real amount ("P5" ≠ ₱5).
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { value: null, incomplete: false };

  const cleaned = trimmed.replace(/^([+-]?)\s*[₱$]\s*/, "$1");

  if (INCOMPLETE_RE.test(cleaned)) return { value: null, incomplete: true };
  if (!COMPLETE_RE.test(cleaned)) return { value: null, incomplete: false };

  const digits = cleaned.replace(/,/g, "");
  // "-." / "+." matched COMPLETE_RE (sign + trailing dot) but has no number.
  if (/^[+-]?\.?$/.test(digits)) return { value: null, incomplete: true };

  const n = Number(digits);
  if (!Number.isFinite(n)) return { value: null, incomplete: false };
  // Round to cents so parsing "-500.123" can never push sub-centavo dust into
  // the money model. Round on the MAGNITUDE and reapply the sign so a positive
  // addition and the equal-magnitude negative deduction are exact mirrors at a
  // half-cent boundary (plain Math.round(n*100) rounds half toward +∞, which
  // would make +2.005 → 2.01 but -2.005 → -2.00). `+ 0` collapses -0 to 0.
  const cents = Math.sign(n) * Math.round(Math.abs(n) * 100);
  return { value: cents / 100 + 0, incomplete: false };
}

/**
 * How an externally-set amount should appear in the text field — a plain
 * signed decimal with no currency symbol or grouping (so re-parsing it is a
 * no-op). null/undefined render as an empty field.
 */
export function normalizeSignedAmountDisplay(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "";
  return String(amount);
}
