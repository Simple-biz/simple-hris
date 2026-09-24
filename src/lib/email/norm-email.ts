/** Lowercase trimmed email, or null if empty. */
export function normEmail(s: string | undefined | null): string | null {
  const t = s?.trim().toLowerCase();
  return t ? t : null;
}

const MAILABLE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * `normEmail`, but null unless the result is shaped like a mailable address.
 * For DELIVERY fields only. A personal-email cell holding a name
 * ("breynald john lim") is non-empty, so `normEmail` would let it win over a
 * real address further down the precedence, and n8n would skip the send.
 */
export function mailableEmail(s: string | undefined | null): string | null {
  const t = normEmail(s);
  return t && MAILABLE_RE.test(t) ? t : null;
}
