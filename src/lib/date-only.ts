/**
 * Parse a date string into a Date whose LOCAL calendar date matches what is
 * written, regardless of the viewer's timezone.
 *
 * JS parses a bare `YYYY-MM-DD` as UTC MIDNIGHT, so rendering
 * `new Date("2026-07-25")` with toLocaleDateString on any machine west of UTC
 * shows "Jul 24" — an off-by-one on every DATE column shown in the UI
 * (mesa_ledger.deposit_date, mesa_member_since, …). Those are calendar dates
 * with no time component, so they must round-trip exactly as written.
 *
 * Anything that isn't a bare date (full timestamps like `created_at`) falls
 * through to normal Date parsing — rendering those in the viewer's local
 * timezone is the desired behavior.
 */
export function parseDateOnlyLocal(input: string | null | undefined): Date | null {
  const s = input?.trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
