/**
 * Surname-first, nickname-quoted display name — the app-side twin of the SQL
 * `public.name_last_first_quoted()` trigger that powers the HR Onboarding
 * "Submitted" tab's display column (migration #87).
 *
 *     "Jan Kane Reroma"   ->   Reroma, Jan Kane "Kane"
 *      ^first ^given ^last       ^surname  ^given names  ^go-by name
 *
 * i.e.  <Surname[ Suffix]>, <all given names> "<go-by name>"
 *
 * WHY a TS port exists: a pending hire's `name` is the canonical legal name
 * (kept "First [Middle] Last" so the Payroll Wizard name-token matcher and the
 * @simple.biz work-email derivation keep working). The "Submitted" tab's quoted
 * form lives only on `hr_onboarding_submissions.display_name`. To post the SAME
 * format to the master Google Sheet on promote — and to show it in the Pending
 * Hires table — we re-derive it here from the legal name, so onboarding-form AND
 * manually-added hires both get it without an extra DB round-trip.
 *
 * The output is SAFE to store in the master list "Name": `normalizeNameTokens`
 * (the payroll matcher) strips quotes/parens, treats commas as spaces, then
 * de-dupes + sorts tokens — so 'Reroma, Jan Kane "Kane"' and 'Jan Kane Reroma'
 * both normalize to 'jan kane reroma'. `resolveFirstName` likewise strips the
 * quotes and reads the token after the comma.
 *
 * Mirrors the SQL rule exactly (see the migration header for the full spec):
 *   1. Normalize + conservatively re-case via {@link toTitleCaseName} (NFKC fold,
 *      strip invisibles, collapse whitespace; SHOUTED/all-lowercase -> Title
 *      Case; mixed-case kept verbatim; an '@'-address returned verbatim).
 *   2. A single token (mononym) is returned unchanged.
 *   3. SUFFIX-AWARE: peel trailing generational suffixes (jr/sr/ii/iii/iv/v,
 *      optional '.') — they travel WITH the surname. Never peel past surname + 1
 *      given name.
 *   4. Surname = last remaining token; given names = everything before it.
 *      (Compound surnames like "Dela Cruz" can't be detected from one string —
 *      only the last word is taken as the surname, same caveat as the SQL.)
 *   5. Go-by (quoted) name = the LAST given token that is NOT a bare initial
 *      ("S" / "S."); if every given token is an initial, the last given is used.
 *   6. Emit:  Surname[ Suffix], Given1 Given2 ... "GoBy"
 */
import { toTitleCaseName } from '@/lib/text/sanitize-name';

// Generational suffixes (optional trailing dot). Matches the SQL's
// '^(jr|sr|ii|iii|iv|v)\.?$' and toTitleCaseName / NAME_EXTENSIONS conventions.
const SUFFIX_RE = /^(jr|sr|ii|iii|iv|v)\.?$/i;
// A bare initial: a single letter, optional trailing dot ("S" or "S.").
const INITIAL_RE = /^\p{L}\.?$/u;

/**
 * Format a legal name as `Surname[ Suffix], Given... "GoBy"`. Returns `null` for
 * a null/blank input (so callers can fall back), and returns the input verbatim
 * for a mononym or an '@'-address parked in a name field.
 */
export function nameLastFirstQuoted(input: string | null | undefined): string | null {
  const norm = toTitleCaseName(input);
  if (!norm) return null; // no real name -> let the caller fall back
  if (norm.includes('@')) return norm; // an address parked in a name column

  const toks = norm.split(/\s+/).filter(Boolean);
  if (toks.length <= 1) return norm; // mononym — nothing to reorder

  // Peel trailing generational suffixes, keeping at least surname + 1 given name.
  const core = [...toks];
  const suffixes: string[] = [];
  while (core.length > 2 && SUFFIX_RE.test(core[core.length - 1])) {
    suffixes.unshift(core.pop() as string);
  }
  if (core.length <= 1) return norm; // only a surname (+ suffix) survived

  const surname = core[core.length - 1];
  const given = core.slice(0, core.length - 1);
  const suffix = suffixes.length > 0 ? ` ${suffixes.join(' ')}` : '';

  // Go-by = last given token that isn't a bare initial; else the last given.
  let goby = given[given.length - 1];
  for (let i = given.length - 1; i >= 0; i--) {
    if (!INITIAL_RE.test(given[i])) {
      goby = given[i];
      break;
    }
  }

  return `${surname}${suffix}, ${given.join(' ')} "${goby}"`;
}

/**
 * Write-site convenience: the surname-first quoted form, falling back to the
 * trimmed original when there's nothing to reorder (null/blank). Use this where
 * a non-null string is required — e.g. the master list "Name" and the Google
 * Sheet append on promote.
 */
export function masterListDisplayName(name: string | null | undefined): string {
  return nameLastFirstQuoted(name) ?? (name ?? '').trim();
}
