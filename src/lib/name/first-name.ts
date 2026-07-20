/**
 * Resolve a person's display first name from their stored full name and/or email.
 *
 * Used by every dashboard greeting card so they all greet the viewer the same way:
 *  - Prefers the real name (HR / master list), stored either "First [Middle] Last"
 *    or the master-list `Surname[ Suffix], Given... "GoBy"` form. Returns the WHOLE
 *    first name (all given tokens before the surname), e.g. `Reroma, Jan Kane "Kane"`
 *    → "Jan Kane" and "Maria Cristina Santos" → "Maria Cristina". The quoted/paren
 *    go-by nickname is dropped entirely so it never duplicates a given token.
 *  - Falls back to the LAST name when a real name has no separable first name
 *    (a mononym, or "Surname," with nothing after the comma).
 *  - Falls back to the email local part's first word (split on . _ -) when there is
 *    no usable name at all, since the raw local part alone is unreliable
 *    (e.g. "j.delacruz@…" → "J").
 *  - Proper-cases ALL-CAPS names ("KANER" → "Kaner") while preserving names that
 *    already carry lowercase letters ("McDonald" stays "McDonald"), per word.
 *  - Returns `fallback` (default "there") when nothing usable is found.
 */

// Generational suffixes (optional trailing dot) that travel with the surname,
// so they're peeled off before the surname when isolating the given names.
// Mirrors display-name.ts' SUFFIX_RE.
const SUFFIX_RE = /^(jr|sr|ii|iii|iv|v)\.?$/i;

export function resolveFirstName(
  opts: { name?: string | null; email?: string | null; fallback?: string } = {},
): string {
  const { name, email, fallback = 'there' } = opts;
  const fromName = firstNameOfName(name) || firstWordOfEmail(email);
  if (!fromName) return fallback;
  return properCaseName(fromName);
}

/**
 * The full first name: every given token before the surname. Falls back to the
 * last name when a real name carries no first name (mononym / "Surname,").
 * Returns '' when there's no usable name (an '@'-address, or blank), so the
 * caller can fall back to the email.
 */
function firstNameOfName(name?: string | null): string {
  const raw = (name ?? '').trim();
  if (!raw || raw.includes('@')) return '';

  const commaAt = raw.indexOf(',');
  const hasComma = commaAt >= 0;
  // The section that holds the given names:
  //   "Surname, Given..."     → everything AFTER the first comma
  //   "First [Middle] Last"   → the whole string (surname peeled off below)
  const section = hasComma ? raw.slice(commaAt + 1) : raw;

  // Drop quoted / parenthesized go-by nicknames entirely — they duplicate a
  // given token (e.g. `Reroma, Jan Kane "Kane"`), so keeping them would repeat it.
  const toks = stripNicknames(section);

  if (hasComma) {
    if (toks.length > 0) return toks.join(' ');
    // No given names after the comma — greet by the surname before it.
    return stripNicknames(raw.slice(0, commaAt)).join(' ');
  }

  // No comma: peel a trailing generational suffix, then the surname (last token).
  if (toks.length <= 1) return toks[0] ?? ''; // mononym — show it (last-name fallback)
  let end = toks.length;
  while (end > 1 && SUFFIX_RE.test(toks[end - 1]!)) end--;
  if (end <= 1) return toks[0]!; // only a surname (+ suffix) — last-name fallback
  return toks.slice(0, end - 1).join(' ');
}

/** Split a name section into tokens with quoted/parenthesized nicknames removed. */
function stripNicknames(section: string): string[] {
  return section
    .replace(/"[^"]*"/g, ' ')
    .replace(/'[^']*'/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Proper-case each word: SHOUTED → Title, but keep existing lowercase ("McDonald"). */
function properCaseName(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const cased = /[a-z]/.test(tok) ? tok : tok.toLowerCase();
      return cased.charAt(0).toUpperCase() + cased.slice(1);
    })
    .join(' ');
}

function firstWordOfEmail(email?: string | null): string {
  if (!email || !email.includes('@')) return '';
  return email.split('@')[0]!.replace(/[._-]+/g, ' ').trim().split(/\s+/)[0] ?? '';
}
