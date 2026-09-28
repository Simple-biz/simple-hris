/**
 * What a successful Payroll Wizard additions save records (`wizard.additions_saved`).
 *
 * The additions blob (`payroll.wizard.additions.<sourceFile>`) is the value that
 * PAYS — orphanage amounts, Adj. overrides and their notes, KPI metrics, bonus
 * toggles, Tech grants/revokes, the PAB snapshot. Its save route wrote no audit
 * row, and the client's per-edit `logAudit` calls cover only five updaters: every
 * KPI metric modal, the Adj. note text, the Tech revoke/restore chips and the
 * Notes-board auto pre-fill changed pay with no trail (2026-09-28 inventory,
 * session log item 240).
 *
 * So the route diffs what was on file against what it just wrote, on the
 * server, after the compare-and-swap succeeded. Whatever path produced an edit,
 * if it landed it is in this diff. Pure and isomorphic.
 */

/** Most individual changes listed; `changes_total` always carries the full count. */
export const ADDITIONS_AUDIT_MAX_CHANGES = 200;

/** Most people named in `people`; `people_total` carries the full count. */
export const ADDITIONS_AUDIT_MAX_PEOPLE = 100;

/**
 * Top-level maps that are DERIVED (recomputed from attendance on every save)
 * and would bury the real edits under the cap: counted, not itemised.
 */
export const ADDITIONS_AUDIT_SUMMARISED_KEYS = ['pabStatusSnapshot'] as const;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type AdditionsChange =
  | { path: string; op: 'added'; after: Json }
  | { path: string; op: 'removed'; before: Json }
  | { path: string; op: 'changed'; before: Json; after: Json }
  | { path: string; op: 'members'; added: Json[]; removed: Json[] }
  | { path: string; op: 'summarised'; changed_entries: number };

export type AdditionsSaveAudit = {
  /** No blob existed before this save. */
  created: boolean;
  /** The pre-save read failed — nothing could be diffed. */
  before_unavailable?: true;
  /** A side did not parse as a JSON object — sizes only. */
  unparseable?: true;
  before_length?: number;
  after_length?: number;
  changes: AdditionsChange[];
  changes_total: number;
  truncated: boolean;
  /** Emails whose entries moved (the second path segment of a per-person map). */
  people: string[];
  people_total: number;
};

function isPlainObject(v: unknown): v is Record<string, Json> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isPrimitiveArray(v: unknown): v is (string | number | boolean | null)[] {
  return Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object');
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseObject(raw: string | null): Record<string, Json> | null {
  if (raw == null) return {};
  try {
    const p = JSON.parse(raw) as unknown;
    return isPlainObject(p) ? p : null;
  } catch {
    return null;
  }
}

function walk(path: string[], a: Json | undefined, b: Json | undefined, out: AdditionsChange[]): void {
  if (same(a, b)) return;
  const p = path.join('/');
  // A whole map appearing or disappearing is itemised leaf by leaf, so a new
  // person's amounts name that person and an empty map is not a change.
  if (a === undefined && isPlainObject(b)) return walk(path, {}, b, out);
  if (b === undefined && isPlainObject(a)) return walk(path, a, {}, out);
  if (a === undefined && isPrimitiveArray(b)) return walk(path, [], b, out);
  if (b === undefined && isPrimitiveArray(a)) return walk(path, a, [], out);
  if (a === undefined) {
    out.push({ path: p, op: 'added', after: b as Json });
    return;
  }
  if (b === undefined) {
    out.push({ path: p, op: 'removed', before: a });
    return;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) walk([...path, k], a[k], b[k], out);
    return;
  }
  if (isPrimitiveArray(a) && isPrimitiveArray(b)) {
    const as = new Set(a.map((x) => JSON.stringify(x)));
    const bs = new Set(b.map((x) => JSON.stringify(x)));
    const added = b.filter((x) => !as.has(JSON.stringify(x)));
    const removed = a.filter((x) => !bs.has(JSON.stringify(x)));
    if (added.length || removed.length) out.push({ path: p, op: 'members', added, removed });
    return;
  }
  out.push({ path: p, op: 'changed', before: a, after: b });
}

/**
 * Diff the stored blob against the one just written. `before` is the raw value
 * read before the save (`null` = no row); `beforeUnavailable` = that read failed.
 * Returns `null` when the save changed nothing on an existing blob — re-posting
 * the same state is not an event (the `/api/pab-exclusions` precedent).
 */
export function describeAdditionsSave(
  before: string | null,
  after: string,
  opts: { beforeUnavailable?: boolean } = {},
): AdditionsSaveAudit | null {
  const empty = { changes: [], changes_total: 0, truncated: false, people: [], people_total: 0 };
  if (opts.beforeUnavailable) {
    return { created: false, before_unavailable: true, after_length: after.length, ...empty };
  }
  const created = before === null;
  if (!created && before === after) return null;

  const a = parseObject(before);
  const b = parseObject(after);
  if (!a || !b) {
    return { created, unparseable: true, before_length: before?.length ?? 0, after_length: after.length, ...empty };
  }

  const all: AdditionsChange[] = [];
  const summarised = new Set<string>(ADDITIONS_AUDIT_SUMMARISED_KEYS);
  const people = new Set<string>();
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (summarised.has(k)) {
      const av = isPlainObject(a[k]) ? a[k] : {};
      const bv = isPlainObject(b[k]) ? b[k] : {};
      const entries = new Set([...Object.keys(av), ...Object.keys(bv)]);
      const n = [...entries].filter((e) => !same(av[e], bv[e])).length;
      if (n > 0) all.push({ path: k, op: 'summarised', changed_entries: n });
      continue;
    }
    const before0 = all.length;
    walk([k], a[k], b[k], all);
    for (const c of all.slice(before0)) {
      const seg = c.path.split('/')[1];
      if (seg && seg.includes('@')) people.add(seg.toLowerCase());
    }
    // Primitive-array maps (Tech grants/revokes) name people as members.
    for (const c of all.slice(before0)) {
      if (c.op !== 'members') continue;
      for (const m of [...c.added, ...c.removed]) {
        if (typeof m === 'string' && m.includes('@')) people.add(m.toLowerCase());
      }
    }
  }

  if (!created && all.length === 0) return null;
  const peopleSorted = [...people].sort();
  return {
    created,
    changes: all.slice(0, ADDITIONS_AUDIT_MAX_CHANGES),
    changes_total: all.length,
    truncated: all.length > ADDITIONS_AUDIT_MAX_CHANGES,
    people: peopleSorted.slice(0, ADDITIONS_AUDIT_MAX_PEOPLE),
    people_total: peopleSorted.length,
  };
}
