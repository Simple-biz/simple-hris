/**
 * Which of a person's `employee_hourly_rates` rows is their CURRENT one.
 *
 * The table keeps multi-upload history — 1,321 people hold several rows, up to
 * 75 (2026-09-25) — and the `employee_hourly_rates_current` view shows ONE per
 * identity, ordered `is_current DESC NULLS LAST, uploaded_at DESC NULLS LAST,
 * id DESC` over the row's `rates_uploads` join
 * (references/sql/alter/add_mesa_fpu_dates.sql). Anything that means to update
 * "this person's rate row" must pick the row that view shows, or it rewrites a
 * history row nobody reads while the visible one keeps the old values.
 */
export type RateRowRank = {
  /** uuid — its lowercase text order is the same as Postgres' uuid byte order. */
  id: string;
  /** The upload's `is_current`; null when the row has no (or an unknown) upload. */
  isCurrent: boolean | null;
  /** The upload's `uploaded_at`; null when the row has no (or an unknown) upload. */
  uploadedAt: string | null;
};

function currentRank(v: boolean | null): number {
  return v === true ? 2 : v === false ? 1 : 0; // DESC NULLS LAST
}

function uploadedMs(v: string | null): number | null {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/** True when `a` sorts ahead of `b` in the view's order. */
export function outranksRateRow(a: RateRowRank, b: RateRowRank): boolean {
  const ca = currentRank(a.isCurrent);
  const cb = currentRank(b.isCurrent);
  if (ca !== cb) return ca > cb;
  const ta = uploadedMs(a.uploadedAt);
  const tb = uploadedMs(b.uploadedAt);
  if (ta !== tb) {
    if (ta === null) return false; // NULLS LAST
    if (tb === null) return true;
    return ta > tb;
  }
  return a.id.toLowerCase() > b.id.toLowerCase();
}
