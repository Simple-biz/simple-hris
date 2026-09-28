/**
 * Build `in.(...)` filter lists that fit in one request URL and match every
 * value exactly.
 *
 * Every PostgREST filter travels in the URL, and the Cloudflare front of this
 * project's Supabase refuses a long one. Measured 2026-09-28 with a SELECT of the
 * same shape: a ~14.4 KB query string is answered, ~16.3–25 KB dies in the client
 * (`UND_ERR_HEADERS_OVERFLOW`, "fetch failed"), ~28 KB+ is `400 Bad Request` and
 * ~77 KB is `414`. The body is not limited that way — an upsert of the same rows
 * goes through — so a write can land and the filter-built step after it fail.
 *
 * That is how the Lead Gen KPI Calculator stopped saving: its replace-set sent
 * the whole keep-set (478 ids, ~43 KB) as a `not.in` list on the delete, got
 * `Bad Request`, and every autosave and Lock refused. So:
 *
 *  - never build an `in` / `not.in` list from an unbounded set of values;
 *  - compute the set to act on in-process and send it through these lists.
 *
 * Values are ALWAYS quoted, with `\` and `"` backslash-escaped. postgrest-js's
 * own `.in()` quotes only on `,()` and never escapes an embedded quote, and
 * that is not hypothetical: a Lead Gen row keyed on a NAME
 * (`arriola, mark anthony  "mark"`) matched nothing through `.in()` and exactly
 * itself through `quoteInValue` (live, read-only, 2026-09-28). A delete built
 * with `.in()` would have skipped it without an error. Escaping is also what
 * keeps a value from closing the quote and adding list items of its own.
 *
 * The budget is half the observed ceiling, which leaves room for the base URL
 * and the other filters. Cost is the value's quoted, escaped, URL-encoded form
 * plus its separator.
 */
export const IN_LIST_URL_BUDGET = 8_000;

/** One value as PostgREST reads it inside an `in.(...)` list. */
export function quoteInValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * `(v1,v2,…)` lists for `.filter(column, 'in', list)`, split so each stays
 * within `budget` URL-encoded bytes. No values → no lists, so a caller's loop
 * runs zero times. Order is kept; nothing is dropped or repeated.
 */
export function inFilterLists(values: readonly string[], budget = IN_LIST_URL_BUDGET): string[] {
  const lists: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const value of values) {
    const quoted = quoteInValue(value);
    const cost = encodeURIComponent(`${quoted},`).length;
    // One value that can never fit is an error, not a list of one: sending it
    // alone would fail at the gateway exactly like the long list did.
    if (cost > budget) {
      throw new Error(`inFilterLists: a ${cost}-byte value exceeds the ${budget}-byte URL budget`);
    }
    if (current.length > 0 && size + cost > budget) {
      lists.push(`(${current.join(',')})`);
      current = [];
      size = 0;
    }
    current.push(quoted);
    size += cost;
  }
  if (current.length > 0) lists.push(`(${current.join(',')})`);
  return lists;
}
