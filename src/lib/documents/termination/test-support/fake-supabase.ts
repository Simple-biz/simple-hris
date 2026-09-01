/** [TERMINATION-DOCS] TEST SUPPORT — a recording PostgREST double.
 *
 * WHY THIS EXISTS. Every read and write Termination Docs performs lives in a
 * `import 'server-only'` module, and the pure cores extracted out of them
 * (`termination-arbitration.ts`, `termination-writeback-rules.ts`) prove only
 * that the ARITHMETIC is right. They say nothing about the query that feeds it:
 * which column was filtered, whether the pattern was LIKE-escaped, whether a
 * 1000-row page was followed by another, whether a read ERROR was treated as
 * "nothing found". Round-1 audit finding: "A pure core that is correct proves
 * nothing about the query that feeds it."
 *
 * So this file is a Supabase-shaped double that RECORDS every operation —
 * table, action, the filter chain in call order, the payload, the range — and
 * answers from fixtures the test declares. The tests then assert on the chain
 * itself. Nothing here talks to a database, and `.env.local` (PRODUCTION
 * service-role) is never read: `node --import tsx --test` loads no env file, and
 * the stub in `./stub-server-modules.ts` replaces the client factory outright.
 *
 * DELIBERATELY DUMB. It does not emulate PostgREST filtering. A fixture is
 * either a row array (sliced by the requested `.range()`, so paging behaves
 * exactly as the server's `db.max-rows` cap makes it behave) or a function that
 * receives the recorded operation and answers it. A table with no fixture
 * answers with an ERROR and is recorded in `unregistered`, so a query nobody
 * anticipated is loud instead of silently empty — the same rule
 * `postgrest-head-true-hides-missing-table` records for production code.
 */

/** One operation, as the double saw it. */
export interface FakeOp {
  table: string;
  action: 'select' | 'insert' | 'update' | 'delete';
  /** Projection string passed to `.select()`, if any. */
  columns: string | null;
  /** Every filter and modifier in CALL ORDER, rendered as `op(args)` —
   *  e.g. `ilike("Work Email",carlath@simple.biz)`. This is what the G1
   *  assertions read. */
  chain: string[];
  /** The insert/update envelope. */
  payload: Record<string, unknown> | null;
  /** `.range(from, to)`, or null when the query asked for no range. */
  from: number | null;
  to: number | null;
  /** `.single()` / `.maybeSingle()`. */
  terminal: 'single' | 'maybeSingle' | null;
  /** True once the builder was awaited — an un-awaited builder never ran. */
  executed: boolean;
}

export interface FakeResult {
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
}

/** The function half of a fixture, named so a fixture BUILT ON another fixture
 *  can call it. `FakeTableFixture` is a union and is therefore not callable; a
 *  test that layers one read's failure over a table's ordinary answers needs the
 *  callable half by name rather than a cast. */
export type FakeTableFn = (op: FakeOp) => FakeResult | Record<string, unknown>[];

/** A fixture: rows to page through, or a function that answers the operation. */
export type FakeTableFixture = Record<string, unknown>[] | FakeTableFn;

export interface FakeStorageFixture {
  upload?: (path: string, bytes: unknown) => { error: { message: string } | null };
  remove?: (paths: string[]) => { error: { message: string } | null };
  createSignedUrl?: (
    path: string,
    ttl: number,
  ) => { data: { signedUrl: string } | null; error: { message: string } | null };
}

export interface FakeStorageOp {
  bucket: string;
  action: 'upload' | 'remove' | 'createSignedUrl';
  path: string;
  paths: string[];
  byteLength: number | null;
  ttl: number | null;
}

export interface FakeSupabase {
  /** Hand this to the code under test (see `./stub-server-modules.ts`). */
  client: unknown;
  /** Every operation the code performed, in the order it was AWAITED. */
  ops: FakeOp[];
  storageOps: FakeStorageOp[];
  /** Tables the code queried that no fixture declared. */
  unregistered: string[];
  /** Every chain entry from every op, flattened — the G1 haystack. */
  allChainEntries: () => string[];
  opsFor: (table: string) => FakeOp[];
}

/**
 * The arguments of the first `name(...)` entry in an operation's chain, split on
 * commas — e.g. `chainArgs(op, 'ilike')` ⇒ `['"Work Email"', 'carla@simple.biz']`.
 * Returns null when the operation never called it.
 */
export function chainArgs(op: FakeOp, name: string): string[] | null {
  const entry = op.chain.find((c) => c.startsWith(`${name}(`));
  if (!entry) return null;
  return entry.slice(name.length + 1, -1).split(',');
}

/**
 * EVERY `name(...)` entry in an operation's chain, in call order.
 *
 * A multi-token NAME search chains one `.ilike` per word on the SAME column —
 * PostgREST ANDs them — so a fixture that honoured only the first one would
 * answer "carla thomas" as if the rep had typed "carla", and a broken AND would
 * look like a passing test.
 */
export function chainArgsAll(op: FakeOp, name: string): string[][] {
  return op.chain
    .filter((c) => c.startsWith(`${name}(`))
    .map((c) => c.slice(name.length + 1, -1).split(','));
}

/** Render one filter argument for the chain log. Objects are JSON so
 *  `order("id",{"ascending":true})` reads back exactly as it was called. */
function arg(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function rowsFrom(fixture: FakeTableFixture, op: FakeOp): FakeResult {
  if (typeof fixture === 'function') {
    const answered = fixture(op);
    if (Array.isArray(answered)) return sliceToRange(answered, op);
    return answered;
  }
  return sliceToRange(fixture, op);
}

/** The server's own behaviour: a page is at most the requested window. A
 *  caller that asks for no range gets everything, which is how an un-paged read
 *  looks right up until the table crosses 1000 rows. */
function sliceToRange(rows: Record<string, unknown>[], op: FakeOp): FakeResult {
  if (op.from === null || op.to === null) return { data: rows, error: null };
  return { data: rows.slice(op.from, op.to + 1), error: null };
}

export function createFakeSupabase(spec: {
  tables?: Record<string, FakeTableFixture>;
  storage?: Record<string, FakeStorageFixture>;
}): FakeSupabase {
  const ops: FakeOp[] = [];
  const storageOps: FakeStorageOp[] = [];
  const unregistered: string[] = [];

  class Builder {
    readonly op: FakeOp;

    constructor(table: string) {
      this.op = {
        table,
        action: 'select',
        columns: null,
        chain: [],
        payload: null,
        from: null,
        to: null,
        terminal: null,
        executed: false,
      };
    }

    private note(name: string, args: unknown[]): this {
      this.op.chain.push(`${name}(${args.map(arg).join(',')})`);
      return this;
    }

    select(columns?: string, opts?: Record<string, unknown>): this {
      if (columns !== undefined) this.op.columns = columns;
      return this.note('select', opts === undefined ? [columns] : [columns, opts]);
    }
    insert(payload: Record<string, unknown>): this {
      this.op.action = 'insert';
      this.op.payload = payload;
      return this.note('insert', ['<payload>']);
    }
    update(payload: Record<string, unknown>): this {
      this.op.action = 'update';
      this.op.payload = payload;
      return this.note('update', ['<payload>']);
    }
    delete(): this {
      this.op.action = 'delete';
      return this.note('delete', []);
    }
    eq(col: string, value: unknown): this {
      return this.note('eq', [col, value]);
    }
    neq(col: string, value: unknown): this {
      return this.note('neq', [col, value]);
    }
    is(col: string, value: unknown): this {
      return this.note('is', [col, value]);
    }
    in(col: string, values: unknown[]): this {
      return this.note('in', [col, values]);
    }
    ilike(col: string, pattern: string): this {
      return this.note('ilike', [col, pattern]);
    }
    like(col: string, pattern: string): this {
      return this.note('like', [col, pattern]);
    }
    lt(col: string, value: unknown): this {
      return this.note('lt', [col, value]);
    }
    lte(col: string, value: unknown): this {
      return this.note('lte', [col, value]);
    }
    gt(col: string, value: unknown): this {
      return this.note('gt', [col, value]);
    }
    gte(col: string, value: unknown): this {
      return this.note('gte', [col, value]);
    }
    not(col: string, op: string, value: unknown): this {
      return this.note('not', [col, op, value]);
    }
    /** Recorded, never special-cased: PostgREST parses an `.or()` argument as
     *  `column.op.value`, so an email's dots mis-split the filter. The tests
     *  assert this never appears. */
    or(filter: string): this {
      return this.note('or', [filter]);
    }
    order(col: string, opts?: Record<string, unknown>): this {
      return this.note('order', opts === undefined ? [col] : [col, opts]);
    }
    limit(n: number): this {
      return this.note('limit', [n]);
    }
    range(from: number, to: number): this {
      this.op.from = from;
      this.op.to = to;
      return this.note('range', [from, to]);
    }
    single(): this {
      this.op.terminal = 'single';
      return this.note('single', []);
    }
    maybeSingle(): this {
      this.op.terminal = 'maybeSingle';
      return this.note('maybeSingle', []);
    }

    private run(): FakeResult {
      this.op.executed = true;
      ops.push(this.op);
      const fixture = (spec.tables ?? {})[this.op.table];
      if (fixture === undefined) {
        unregistered.push(this.op.table);
        return {
          data: null,
          error: { message: `FAKE: no fixture declared for table "${this.op.table}"` },
        };
      }
      const answered = rowsFrom(fixture, this.op);
      if (answered.error) return answered;
      const rows = Array.isArray(answered.data) ? (answered.data as unknown[]) : [];
      if (this.op.terminal === 'single') {
        if (rows.length === 1) return { data: rows[0], error: null };
        return { data: null, error: { message: `FAKE: single() saw ${rows.length} rows` } };
      }
      if (this.op.terminal === 'maybeSingle') {
        if (rows.length > 1) {
          return { data: null, error: { message: `FAKE: maybeSingle() saw ${rows.length} rows` } };
        }
        return { data: rows[0] ?? null, error: null };
      }
      return answered;
    }

    then<TResult1 = FakeResult, TResult2 = never>(
      onFulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return Promise.resolve()
        .then(() => this.run())
        .then(onFulfilled ?? undefined, onRejected ?? undefined);
    }
  }

  const storage = {
    from(bucket: string) {
      const fixture = (spec.storage ?? {})[bucket];
      return {
        upload(path: string, bytes: unknown): Promise<{ error: { message: string } | null }> {
          const view = bytes as { byteLength?: number } | null;
          storageOps.push({
            bucket,
            action: 'upload',
            path,
            paths: [path],
            byteLength: typeof view?.byteLength === 'number' ? view.byteLength : null,
            ttl: null,
          });
          return Promise.resolve(
            fixture?.upload
              ? fixture.upload(path, bytes)
              : { error: { message: `FAKE: no storage fixture for bucket "${bucket}"` } },
          );
        },
        remove(paths: string[]): Promise<{ error: { message: string } | null }> {
          storageOps.push({
            bucket,
            action: 'remove',
            path: paths[0] ?? '',
            paths,
            byteLength: null,
            ttl: null,
          });
          return Promise.resolve(fixture?.remove ? fixture.remove(paths) : { error: null });
        },
        createSignedUrl(
          path: string,
          ttl: number,
        ): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }> {
          storageOps.push({
            bucket,
            action: 'createSignedUrl',
            path,
            paths: [path],
            byteLength: null,
            ttl,
          });
          return Promise.resolve(
            fixture?.createSignedUrl
              ? fixture.createSignedUrl(path, ttl)
              : { data: null, error: { message: `FAKE: no signer for bucket "${bucket}"` } },
          );
        },
      };
    },
  };

  return {
    client: {
      from: (table: string) => new Builder(table),
      storage,
    },
    ops,
    storageOps,
    unregistered,
    allChainEntries: () => ops.flatMap((o) => o.chain),
    opsFor: (table: string) => ops.filter((o) => o.table === table),
  };
}
