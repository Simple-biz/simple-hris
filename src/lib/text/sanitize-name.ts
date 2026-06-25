/**
 * Human-name sanitizer - the application-layer guardrail against "fancy"
 * Unicode look-alikes in names.
 *
 * People copy-paste names styled with Unicode Mathematical Alphanumeric Symbols
 * (e.g. a styled "Katherine Santiago" built from U+1D43E, U+1D44E, U+210E ...)
 * out of social media. Those code points are NOT the ASCII letters they look
 * like, so any downstream `.toLowerCase().includes(...)` search or name-token
 * payroll match silently fails and the person becomes invisible to the system.
 *
 * `NFKC` (compatibility composition) is the fix: it folds mathematical
 * italic/bold, full-width, ligatures, circled/superscript characters, etc.
 * back to their plain ASCII / canonical form, while LEAVING legitimate accents
 * intact ("Jose" with an accent stays accented). We then strip invisible
 * zero-width and bidirectional control characters, collapse internal
 * whitespace, and trim.
 *
 * Run this on any human-entered NAME before it is stored or compared. Emails
 * keep using `normEmail`; this is names only.
 */

// Zero-width spaces/joiners (U+200B-U+200F), bidi embeddings/overrides/isolates
// and other invisible format controls (U+202A-U+202E, U+2060-U+206F), plus the
// BOM / zero-width no-break space (U+FEFF). Built via RegExp() from an escaped
// ASCII string so no invisible code points live in this source file.
const INVISIBLES = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\uFEFF]",
  "g",
);

/** Fold a styled/invisible-laden name to plain canonical text. */
export function sanitizeName(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .normalize("NFKC")
    .replace(INVISIBLES, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Same as {@link sanitizeName} but returns `null` for an empty result, for
 * direct use in nullable DB columns (mirrors the `?.trim() || null` idiom). */
export function sanitizeNameOrNull(
  input: string | null | undefined,
): string | null {
  return sanitizeName(input) || null;
}

/** True when the string contains at least one non-ASCII code point - handy for
 * spotting names that still need folding (e.g. in admin tooling). */
export function hasNonAscii(input: string | null | undefined): boolean {
  // eslint-disable-next-line no-control-regex
  return !!input && /[^\x00-\x7F]/.test(input);
}

/**
 * Re-case a SHOUTED or all-lowercase human name into "Title Case"
 * ("JAN KANE REROMA" / "jan kane reroma" -> "Jan Kane Reroma"), so names read
 * naturally everywhere they're shown (HR Onboarding Submitted column, the
 * onboarding form, downstream records).
 *
 * Deliberately CONSERVATIVE — it only ever changes a name we're confident was
 * mis-cased, and never re-cases something a human typed deliberately:
 *
 *   - Runs {@link sanitizeName} first (NFKC fold + strip invisibles + collapse
 *     whitespace + trim), so this composes with the Unicode guardrail.
 *   - Email-like strings (containing "@") are returned VERBATIM. Some legacy
 *     `name` columns hold an address (e.g. "jan@simple.biz"); title-casing them
 *     would corrupt the address.
 *   - MIXED-case input is returned VERBATIM. If a string already has both upper
 *     and lower letters it was cased on purpose — "McDonald", "de la Cruz",
 *     "DeShawn", "O'Brien", "van der Berg" — and we must not flatten it.
 *   - Only a string that is ENTIRELY one case (all-caps or all-lowercase) is
 *     re-cased: lowercase it, then capitalize the first letter of every
 *     word-part. A word-part starts at the string start or after any non-letter
 *     (space, hyphen, apostrophe, period) so "anne-marie" -> "Anne-Marie",
 *     "o'brien" -> "O'Brien", "kyle s. engalan" -> "Kyle S. Engalan".
 *
 * Two small refinements on top of plain title-casing:
 *   - "Mc" prefix: "mcdonald" -> "McDonald" (no false positives — there is no
 *     common English "Mc"+lowercase surname). "Mac" is intentionally left alone
 *     ("Macey" must not become "MacEy").
 *   - Generational suffix: a trailing "ii"/"iii"/"iv" token is upper-cased
 *     ("Juan Dela Cruz Iii" -> "...III"). v/vi/ix/x are intentionally skipped so
 *     real names like "Vi" or "Ix" aren't clobbered.
 *
 * NOTE: this does NOT try to detect initials, so "KC LYN ROPAL" becomes
 * "Kc Lyn Ropal" — fixing the SHOUTING is the goal; perfect initial casing is
 * out of scope (and undecidable from all-caps input).
 */
export function toTitleCaseName(input: string | null | undefined): string {
  const s = sanitizeName(input);
  if (!s) return "";
  // An address parked in a name column — never re-case it.
  if (s.includes("@")) return s;

  const hasLower = /\p{Ll}/u.test(s);
  const hasUpper = /\p{Lu}/u.test(s);
  // Mixed case is intentional; no cased letters means nothing to do.
  if (hasLower === hasUpper) return s;

  let out = s
    .toLowerCase()
    // Capitalize the first letter of every word-part (start, or after any
    // non-letter — space, hyphen, apostrophe, period).
    .replace(/(^|[^\p{L}])(\p{L})/gu, (_, boundary, letter) => boundary + letter.toUpperCase());

  // "Mcdonald" -> "McDonald".
  out = out.replace(/\bMc(\p{Ll})/gu, (_, letter) => "Mc" + letter.toUpperCase());

  // Trailing generational suffix ii/iii/iv -> uppercase.
  out = out.replace(/(^|\s)(Ii|Iii|Iv)$/u, (_, lead, suffix) => lead + suffix.toUpperCase());

  return out;
}

/** Nullable-column variant of {@link toTitleCaseName} (empty -> null). */
export function toTitleCaseNameOrNull(
  input: string | null | undefined,
): string | null {
  return toTitleCaseName(input) || null;
}
