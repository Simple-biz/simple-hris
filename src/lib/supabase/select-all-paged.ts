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

type PageResult<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/**
 * Drain a read that is paged WITHOUT an order, and refuse to trust it if the
 * pages sheared.
 *
 * `selectAllPaged` above says to add a stable `.order()`, and the durable rule
 * is a TOTAL one. This exists for the readers that cannot take one without
 * changing what people see: `hubstaff_hours` has no row-position column and a
 * UUID `id`, so ordering a week's file by `id` would reshuffle every table that
 * renders it in API order (Payroll Wizard Step 1 and Step 2). Measured
 * 2026-09-26: the unordered order differs from `id` order in all 31 uploads.
 *
 * What an order protects against is still closed here, by DETECTION:
 * - A page order that changes between the page queries (synchronized scans,
 *   concurrent writes) repeats some row on a later page and drops another. A
 *   dropped row always comes with a repeated one, so a repeated primary key is
 *   the tell. Rows being INSERTED mid-read do not repeat anything, so a
 *   re-ingest in progress never trips it.
 * - On a repeat the read is retried once, then re-run in `orderedPage` (the
 *   same query with a total order), which is correct by construction — only
 *   the row ORDER differs, and only on that pathological read. It never
 *   de-duplicates: a repeat is evidence the whole read is wrong, not that one
 *   row should be dropped.
 * - The ordered read is checked too, and a repeat there throws.
 *
 * The first two pages are requested together (a Hubstaff week is ~1,100 rows,
 * so two pages), which removes a round trip from every per-week read.
 */
export async function selectAllPagedUnorderedGuarded<T>(opts: {
  page: (from: number, to: number) => PageResult<T>;
  orderedPage: (from: number, to: number) => PageResult<T>;
  keyOf: (row: T) => unknown;
  label: string;
  pageSize?: number;
  onRepeat?: (info: { label: string; attempt: 'unordered' | 'retry'; fetched: number; distinct: number }) => void;
}): Promise<T[]> {
  const pageSize = opts.pageSize ?? 1000;

  const drain = async (build: (from: number, to: number) => PageResult<T>): Promise<T[]> => {
    const [first, second] = await Promise.all([
      build(0, pageSize - 1),
      build(pageSize, 2 * pageSize - 1),
    ]);
    if (first.error) throw new Error(first.error.message);
    const rows: T[] = [...(first.data ?? [])];
    if (!first.data || first.data.length < pageSize) return rows;
    if (second.error) throw new Error(second.error.message);
    rows.push(...(second.data ?? []));
    if (!second.data || second.data.length < pageSize) return rows;
    for (let from = 2 * pageSize; ; from += pageSize) {
      const { data, error } = await build(from, from + pageSize - 1);
      if (error) throw new Error(error.message);
      rows.push(...(data ?? []));
      if (!data || data.length < pageSize) return rows;
    }
  };

  const distinctCount = (rows: T[]): number => {
    const seen = new Set<unknown>();
    let keyless = 0;
    for (const r of rows) {
      const k = opts.keyOf(r);
      if (k === null || k === undefined || k === '') keyless += 1;
      else seen.add(k);
    }
    return seen.size + keyless;
  };

  for (const attempt of ['unordered', 'retry'] as const) {
    const rows = await drain(opts.page);
    const distinct = distinctCount(rows);
    if (distinct === rows.length) return rows;
    opts.onRepeat?.({ label: opts.label, attempt, fetched: rows.length, distinct });
  }

  const ordered = await drain(opts.orderedPage);
  const distinct = distinctCount(ordered);
  if (distinct !== ordered.length) {
    throw new Error(
      `${opts.label}: ordered read repeated rows (${ordered.length} fetched, ${distinct} distinct) — refusing to trust it`,
    );
  }
  return ordered;
}
