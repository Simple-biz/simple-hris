/**
 * One page of a list, with the page clamped into range.
 *
 * Used by Manager → My Team → Orientation (`OrientationAttendancePanel`), which pages
 * its week cards and the people inside an opened week at 10
 * (`docs/features/manager-orientation-attendance.md` § *Pagination*). The requested page
 * is CLAMPED rather than trusted: a refresh or the "Show everyone" toggle can shrink a
 * list under the page the manager is on, and an out-of-range page would render an empty
 * list while the counts above it say otherwise. Display only — nothing that counts,
 * totals or exports may read a page.
 */
export interface PageWindow<T> {
  /** The items on this page. */
  items: T[];
  /** The page actually shown, 1-based, clamped to [1, totalPages]. */
  page: number;
  /** At least 1, so an empty list is "page 1 of 1". */
  totalPages: number;
  /** 1-based index of the first item shown; 0 when the list is empty. */
  from: number;
  /** 1-based index of the last item shown; 0 when the list is empty. */
  to: number;
  total: number;
}

export function pageWindow<T>(list: readonly T[], requestedPage: number, pageSize: number): PageWindow<T> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError(`pageSize must be a positive integer, got ${pageSize}`);
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const asked = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1;
  const page = Math.min(Math.max(1, asked), totalPages);
  const start = (page - 1) * pageSize;
  const items = list.slice(start, start + pageSize);
  return {
    items,
    page,
    totalPages,
    from: items.length === 0 ? 0 : start + 1,
    to: start + items.length,
    total,
  };
}
