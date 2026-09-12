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

/**
 * The ONE renderer for a date-only column (`YYYY-MM-DD`).
 *
 * `new Date('2026-09-01')` is UTC midnight, so it renders as Aug 31 for every
 * viewer west of UTC. Manila (UTC+8) never saw this — it is every US-side
 * viewer reading the same roster who saw the wrong day. This builds a LOCAL
 * date instead, so the Profile's Employment row and the ID card agree.
 *
 * Unparseable input is returned VERBATIM rather than replaced: the card has
 * always shown whatever the roster holds, and hiding a malformed date behind a
 * dash hides a data problem.
 */
export function formatDateOnly(value: string | null | undefined): string {
  const raw = value?.trim();
  if (!raw) return '—';
  const parsed = parseDateOnlyLocal(raw);
  if (!parsed) return raw;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
