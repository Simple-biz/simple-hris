/**
 * Drain a PostgREST select past the server-side `db.max-rows` cap.
 *
 * This project's Supabase enforces max-rows = 1000: an un-ranged `.select()`
 * — and even an explicit `.range(0, 99999)` — silently returns AT MOST 1000
 * rows with no error. The active roster passed 1,000 people in Jul 2026
 * (1,296 as of Jul 30) and several tables are far past it, so every
 * "read the whole table/view" call MUST page. The 2026-07-30 audit found 14
 * un-paged reads silently dropping the tail: missing payroll notifications,
 * truncated team rosters, wrong HSL week models, understated outstanding-pay
 * reports, and a work-email suggester that could re-mint taken addresses.
 *
 * Usage — the caller builds the query INSIDE the closure so each page gets a
 * fresh builder (PostgREST builders are single-use), and MUST apply the
 * `.range(from, to)` it is handed; add a stable `.order()` so pages don't
 * shear under concurrent writes:
 *
 *   const { rows, error } = await selectAllPaged<RowType>((from, to) =>
 *     supabase.from("active_employees").select('"Work Email", "Department"')
 *       .order("Work Email", { ascending: true })
 *       .range(from, to),
 *   );
 */
export async function selectAllPaged<T>(
  buildPage: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
  pageSize = 1000,
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildPage(from, from + pageSize - 1);
    if (error) return { rows, error: error.message };
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return { rows, error: null };
}
