/**
 * Sun–Sat week math shared by HR Overview's hiring cards, mirroring the week
 * anchoring used by the New Hire Checklist (see HrNewHireChecklist.tsx) so a
 * "period_start" computed here always lines up with the same weeks HR pastes
 * hires into.
 */

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The Sunday that starts the week containing `d`. */
export function sundayIso(d: Date): string {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - x.getDay()); // getDay(): Sun=0 … Sat=6
  return toIso(x);
}

/** Saturday end of the Sun-anchored week (start + 6 days). */
export function weekEndIso(startIso: string): string {
  const [y, m, d] = startIso.split('-').map(Number);
  return toIso(new Date(y!, m! - 1, d! + 6));
}

/** Shift a week start by `n` weeks (±). */
export function addWeeks(startIso: string, n: number): string {
  const [y, m, d] = startIso.split('-').map(Number);
  return toIso(new Date(y!, m! - 1, d! + n * 7));
}

/** "Jun 28 – Jul 4, 2026" for a Sun-anchored week start. */
export function formatWeekLabel(startIso: string): string {
  if (!startIso) return '—';
  const [y, m, d] = startIso.split('-').map(Number);
  if (!y || !m || !d) return startIso;
  const s = new Date(y, m - 1, d);
  const e = new Date(y, m - 1, d + 6);
  const f = (dt: Date) => dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${f(s)} – ${f(e)}, ${e.getFullYear()}`;
}
