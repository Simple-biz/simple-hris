/** Lowercase trimmed email, or null if empty. */
export function normEmail(s: string | undefined | null): string | null {
  const t = s?.trim().toLowerCase();
  return t ? t : null;
}
