/** [TERMINATION-DOCS] TEST SUPPORT — ILIKE semantics, faithfully.
 *
 * The reason this file emulates the wildcards instead of comparing strings: `_`
 * is an ILIKE SINGLE-CHARACTER WILDCARD and is legal in an email local-part, so
 * an unescaped `a_b@simple.biz` matches `axb@simple.biz` — a DIFFERENT PERSON
 * (contract §5 G1; `coe-facts.ts:191` has that bug and this feature must not
 * inherit it). A test that compared strings could not tell an escaped pattern
 * from an unescaped one, so the guard would be untestable and the audit's
 * "every email .ilike goes through escapeLikePattern" would rest on a grep.
 *
 * With this, a fixture holding BOTH `a_b@` and `axb@` answers one row while the
 * escape is in place and TWO the moment it is removed — the query itself is
 * what the assertion sees.
 */
import type { FakeOp, FakeTableFn } from './fake-supabase';
import { chainArgs, chainArgsAll } from './fake-supabase';

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * PostgREST/Postgres `ILIKE`: `%` is any run, `_` is exactly one character, and
 * a backslash escapes either (what `escapeLikePattern` emits). Case-insensitive.
 */
export function ilikeMatches(pattern: string, value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') {
      i += 1;
      out += escapeRegex(pattern[i] ?? '');
      continue;
    }
    if (ch === '%') {
      out += '[\\s\\S]*';
      continue;
    }
    if (ch === '_') {
      out += '[\\s\\S]';
      continue;
    }
    out += escapeRegex(ch);
  }
  return new RegExp(`^${out}$`, 'i').test(String(value));
}

/** `"Work Email"` → `Work Email`: the projection quotes the capitalised sheet
 *  columns, the row object does not. */
function unquote(column: string): string {
  return column.replace(/^"|"$/g, '');
}

/**
 * Apply EVERY `.ilike` on the operation, ANDed — which is what PostgREST does
 * with chained filters, and what the multi-word NAME passes rely on: "carla
 * thomas" is two `.ilike`s on `"Name"`, and honouring only the first would
 * answer a one-word search and call the AND proved.
 */
function applyEveryIlike(rows: Record<string, unknown>[], op: FakeOp): Record<string, unknown>[] {
  let out = rows;
  for (const like of chainArgsAll(op, 'ilike')) {
    const column = unquote(like[0]);
    const pattern = like.slice(1).join(',');
    out = out.filter((r) => ilikeMatches(pattern, r[column] as string | null));
  }
  return out;
}

/**
 * A `global_master_list` fixture that answers the THREE different reads this
 * feature makes of that one table, each identified by the filter it carries:
 *
 *   1. the identity read      — `.ilike('"Work Email"', pat)`  (termination-facts / -search)
 *   2. the status-map read    — no filter at all               (fetchGmlStatusMap)
 *   3. the alias screen       — `.ilike('"Personal Email"', pat)` (termination-facts)
 *
 * (The `.not('off_boarded_at','is',null)` branch below is the shape
 * `loadOffboardEvidenceByEmail` used to make of this table. The feature no
 * longer calls it — it has no error channel — but the branch is kept so a
 * fixture stays faithful to the table rather than to one caller.)
 *
 * Answering all three from ONE row set is the point: the map's ACTIVE verdict
 * and the identity read then describe the same table, which is what makes the G3
 * fixtures (a stamped duplicate beside an unstamped row) mean anything.
 */
export function masterListFixture(rows: Record<string, unknown>[]): FakeTableFn {
  return (op: FakeOp) => {
    if (chainArgs(op, 'ilike')) return applyEveryIlike(rows, op);
    if (op.chain.some((c) => c.startsWith('not(off_boarded_at,is,null)'))) {
      return rows.filter((r) => !!r['off_boarded_at']);
    }
    return rows;
  };
}

/** The same shape for any table whose reads are a single `.ilike` or nothing —
 *  `offboarded_sheet`, `offboarding_queue`, `termination_documents`. */
export function ilikeTableFixture(rows: Record<string, unknown>[]): FakeTableFn {
  return (op: FakeOp) => {
    if (!chainArgs(op, 'ilike')) return rows;
    return applyEveryIlike(rows, op);
  };
}
