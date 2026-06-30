/**
 * Escape PostgREST/SQL LIKE/ILIKE metacharacters (`%`, `_`, and the escape `\`)
 * so a user-supplied value is matched LITERALLY rather than as a pattern.
 *
 * PostgREST translates `.ilike(col, pattern)` to SQL `col ILIKE pattern` with the
 * default backslash escape char, so `\%` / `\_` match literal `%` / `_`. Without
 * this, a value like `%` would match every row — an enumeration / over-match hole
 * on public, unauthenticated lookups.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}
