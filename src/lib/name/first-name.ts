/**
 * Resolve a person's display first name from their stored full name and/or email.
 *
 * Used by every dashboard greeting card so they all greet the viewer the same way:
 *  - Prefers the real name (HR / master list), stored either "First Last" or
 *    "Last, First M.". The given name is the first token AFTER a comma, else the
 *    first token. Nickname quotes / parens are stripped.
 *  - Falls back to the email local part's first word (split on . _ -), since the
 *    raw local part alone is unreliable (e.g. "j.delacruz@…" → "J").
 *  - Proper-cases ALL-CAPS names ("KANER" → "Kaner") while preserving names that
 *    already carry lowercase letters ("McDonald" stays "McDonald").
 *  - Returns `fallback` (default "there") when nothing usable is found.
 */
export function resolveFirstName(
  opts: { name?: string | null; email?: string | null; fallback?: string } = {},
): string {
  const { name, email, fallback = 'there' } = opts;
  const token = firstTokenOfName(name) || firstWordOfEmail(email);
  if (!token) return fallback;
  // Preserve names that already carry lowercase letters (keeps "McDonald");
  // otherwise lowercase an all-caps token before capitalizing the first letter.
  const cased = /[a-z]/.test(token) ? token : token.toLowerCase();
  return cased.charAt(0).toUpperCase() + cased.slice(1);
}

function firstTokenOfName(name?: string | null): string {
  const full = (name ?? '').trim();
  if (!full) return '';
  const afterComma = full.includes(',') ? full.split(',')[1] ?? '' : full;
  return afterComma.replace(/["'()]/g, '').trim().split(/\s+/)[0] ?? '';
}

function firstWordOfEmail(email?: string | null): string {
  if (!email || !email.includes('@')) return '';
  return email.split('@')[0]!.replace(/[._-]+/g, ' ').trim().split(/\s+/)[0] ?? '';
}
