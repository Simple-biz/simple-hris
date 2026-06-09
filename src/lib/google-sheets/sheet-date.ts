/**
 * Formats an ISO calendar date (YYYY-MM-DD) as MM/DD/YY to match the master
 * Google Sheet's existing Start Date column convention (e.g. "06/08/26"). The
 * app stores dates ISO internally; only the Sheet uses MM/DD/YY. Anything that
 * isn't a bare YYYY-MM-DD is returned untouched (already formatted, blank, or a
 * value we don't recognise — never guess).
 */
export function toSheetDate(value: string | null | undefined): string {
  if (!value) return '';
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  const [, y, mo, d] = m;
  return `${mo}/${d}/${y.slice(2)}`;
}
