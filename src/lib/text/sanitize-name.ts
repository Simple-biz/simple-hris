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
