/**
 * Display formatters for the People surface — moved verbatim out of
 * `PeopleTab.tsx` (2026-09-28) so the popup and the Search Bar's person page
 * print the same person the same way (`person-record-panels.tsx`). Nothing in
 * here changed in the move.
 */

export type Currency = 'PHP' | 'USD' | 'COP';

export function fmtMoney(amount: number | null | undefined, currency: Currency = 'PHP'): string {
  if (amount == null) return '—';
  const opts = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  if (currency === 'USD') return `$${amount.toLocaleString('en-US', opts)}`;
  if (currency === 'COP') return `COP ${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return `₱${amount.toLocaleString('en-PH', opts)}`;
}

export function fmtHours(h: number | null | undefined): string {
  if (h == null) return '—';
  return `${h.toLocaleString('en-US', { maximumFractionDigits: 1 })}h`;
}

/** Parse a "YYYY-MM-DD" string as a LOCAL calendar date (no UTC/TZ shift). */
export function parseIsoLocal(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** "2026-06-22" → "June 22, 2026". Falls back to the raw string if unparseable. */
export function formatDay(iso: string | null | undefined): string {
  const d = parseIsoLocal(iso);
  if (!d) return iso ?? '';
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/** Hire date → "Jun 22, 2026". null when absent; raw string if unparseable.
 *  Lenient (`new Date`) so any master-list format renders — start dates arrive in
 *  whatever shape was typed into the sheet, not guaranteed ISO. Matches fmtDate on
 *  the Global Master List. */
export function formatHireDate(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const d = new Date(raw.trim());
  if (Number.isNaN(d.getTime())) return raw.trim();
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Tenure = start date compared to the current date → "2y 3m" / "5mo" / "12d" /
 *  "New". null when there's no start date or it can't be parsed. Mirrors the
 *  Global Master List's tenure() exactly (lenient `new Date` parsing, same
 *  bucketing) so both surfaces agree for the same person. Client-only (runs inside
 *  the profile dialog after a click), so the `new Date()` never hits SSR hydration. */
export function tenureFrom(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const start = new Date(raw.trim());
  if (Number.isNaN(start.getTime())) return null;
  const now = new Date();
  let years = now.getFullYear() - start.getFullYear();
  let months = now.getMonth() - start.getMonth();
  if (months < 0) { years -= 1; months += 12; }
  if (years < 0) return null;
  if (years > 0 && months > 0) return `${years}y ${months}m`;
  if (years > 0) return `${years}y`;
  if (months > 0) return `${months}mo`;
  const days = Math.floor((now.getTime() - start.getTime()) / 86400000);
  return days <= 0 ? 'New' : `${days}d`;
}

/**
 * Friendly pay-period range:
 *   same month  → "April 5 - 10, 2026"
 *   cross month → "June 29 - July 5, 2026"
 *   cross year  → "Dec 30, 2025 - Jan 5, 2026"
 */
export function formatPeriodRange(startIso: string | null | undefined, endIso: string | null | undefined): string {
  const s = parseIsoLocal(startIso);
  const e = parseIsoLocal(endIso);
  if (!s || !e) return [startIso, endIso].filter(Boolean).join(' - ');
  const mLong = (d: Date) => d.toLocaleDateString('en-US', { month: 'long' });
  if (s.getFullYear() !== e.getFullYear()) return `${formatDay(startIso)} - ${formatDay(endIso)}`;
  if (s.getMonth() === e.getMonth()) return `${mLong(s)} ${s.getDate()} - ${e.getDate()}, ${s.getFullYear()}`;
  return `${mLong(s)} ${s.getDate()} - ${mLong(e)} ${e.getDate()}, ${s.getFullYear()}`;
}
