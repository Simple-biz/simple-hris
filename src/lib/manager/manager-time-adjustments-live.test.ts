/**
 * Guard: Manager → Time Adjustments must refresh on a TIMER, never on a render.
 *
 * The flicker Kane reported was a fetch loop, not a slow endpoint:
 *
 *   1. `<ManagerTimeAdjustments onCountChange={(n) => setPendingApprovals(n)} />`
 *      handed the child a fresh arrow on every render of the shell.
 *   2. The child folded that prop into `fetchRows = useCallback(..., [onCountChange])`
 *      and mounted it with `useEffect(() => { fetchRows(); }, [fetchRows])`.
 *   3. Each answered fetch called `onCountChange(n)` → `setPendingApprovals(n)`, and
 *      `useManagerCachedState`'s setter returns a NEW `{key, value}` object on every
 *      call (`useManagerCachedState.ts` — the value and its key are one piece of
 *      state), so React can never bail out on an unchanged count. The shell
 *      re-rendered → new arrow → new `fetchRows` → the mount effect refired.
 *
 * That loop re-hit `GET /api/manager/time-adjustments` (Supabase reads + Storage
 * signing) for as long as the tab was open, and because `fetchRows` opened with
 * `setLoading(true)` the whole list was swapped for the spinner several times a
 * second — the visible flicker.
 *
 * Two invariants close it, and neither is expressible in the type system, so they
 * are pinned here as a source scan (same technique as `dept-label-render.test.ts`
 * and `tab-cache.test.ts`'s `no-skip-flag`):
 *
 *   A. Nothing that can change identity per render may reach the fetch closure.
 *      `onCountChange` is allowed ONLY in the signature and the ref that holds it.
 *   B. The spinner is derived (`!settled && nothing-to-paint`), never stored and
 *      re-asserted per fetch — `manager-dashboard-cache.md` § "Loading flags are
 *      part of the rule". Without this the 60s poll would flash the list forever.
 *
 * Plus C: the queue must actually be live. Other people empty this queue, and
 * `manager-dashboard-cache.md` is explicit that stale-and-stop "is how two managers
 * approve the same request twice".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const MANAGER_APP = path.join(
  process.cwd(),
  'src',
  'components',
  'manager',
  'ManagerApp.tsx',
);

const source = fs.readFileSync(MANAGER_APP, 'utf8');

/** The `ManagerTimeAdjustments` body — from its declaration to the next top-level one. */
function timeAdjustmentsComponent(): string {
  const start = source.indexOf('function ManagerTimeAdjustments(');
  assert.ok(start > 0, 'ManagerTimeAdjustments was renamed or removed — update this guard');
  const end = source.indexOf('\nfunction ', start + 1);
  assert.ok(end > start, 'could not find the end of ManagerTimeAdjustments');
  return source.slice(start, end);
}

test('the count callback never reaches the fetch closure directly', () => {
  const body = timeAdjustmentsComponent();
  // Every mention of the prop must be either the signature or the ref plumbing.
  // Anything else means it is back inside a closure or a dependency array, which
  // is what turned one mount fetch into a fetch-per-render loop.
  const allowed = [
    /^function ManagerTimeAdjustments\(\{ onCountChange \}/,
    /useRef\(onCountChange\)/,
    /countChangeRef\.current = onCountChange/,
  ];
  const offenders = body
    .split('\n')
    .filter((line) => line.includes('onCountChange'))
    .filter((line) => !allowed.some((re) => re.test(line.trim())))
    .map((line) => line.trim());
  assert.deepEqual(
    offenders,
    [],
    `onCountChange must be read through countChangeRef only; found: ${offenders.join(' | ')}`,
  );
});

test('fetchRows carries an empty dependency array', () => {
  const body = timeAdjustmentsComponent();
  const decl = body.indexOf('const fetchRows = React.useCallback(');
  assert.ok(decl > 0, 'fetchRows was renamed — update this guard');
  // The first `}, [...])` after the declaration is its dependency array.
  const deps = /\}, \[([^\]]*)\]\);/.exec(body.slice(decl));
  assert.ok(deps, 'could not read fetchRows dependency array');
  assert.equal(
    deps[1].trim(),
    '',
    `fetchRows must depend on nothing — a dep that changes per render refires the mount fetch (found: [${deps[1]}])`,
  );
});

test('the spinner is derived from settled, not stored per fetch', () => {
  const body = timeAdjustmentsComponent();
  assert.ok(
    /const loading = !settled &&/.test(body),
    'the spinner must be derived: `const loading = !settled && <nothing to paint>`',
  );
  assert.ok(
    !/setLoading\(/.test(body),
    'a stored loading flag re-asserted per fetch repaints the skeleton over rows already on screen',
  );
  assert.ok(
    !/setSettled\(false\)/.test(body),
    '`settled` means "answered at least once in this mount" and is never reset',
  );
});

test('the queue is kept live by a bounded poll, not by re-rendering', () => {
  const body = timeAdjustmentsComponent();
  const call = /useLiveRefresh\(\{[\s\S]*?\}\);/.exec(body);
  assert.ok(call, 'ManagerTimeAdjustments must use useLiveRefresh — other people empty this queue');
  const wiring = call[0];
  assert.ok(
    wiring.includes("'time_adjustment_requests'"),
    'the watched table must be time_adjustment_requests',
  );
  assert.ok(
    /pollMs:\s*60_000/.test(wiring),
    'a poll backstop is required — Realtime only fires if the table is in the supabase_realtime publication',
  );
  assert.ok(
    /onRefresh:\s*fetchRows/.test(wiring),
    'the refresh must reuse fetchRows so the seeded and refreshed paths cannot diverge',
  );
});

test('the queue read stays uncached', () => {
  const body = timeAdjustmentsComponent();
  assert.ok(
    /\/api\/manager\/time-adjustments'\, \{ cache: 'no-store' \}/.test(body),
    "the route keeps cache: 'no-store' — manager-dashboard-cache.md is a paint cache only",
  );
});

test('the shell passes a stable callback, never an inline arrow', () => {
  // The defect was on THIS line, not inside the child. Pinning both halves means a
  // future edit to either one cannot reopen the loop on its own.
  assert.ok(
    !/onCountChange=\{\(/.test(source),
    'an inline arrow/function prop re-creates the child fetch closure on every shell render',
  );
  assert.ok(
    /onCountChange=\{handleApprovalCountChange\}/.test(source),
    'ManagerTimeAdjustments must receive the memoized handleApprovalCountChange',
  );
  const memo = /const handleApprovalCountChange = React\.useCallback\([\s\S]*?\);/.exec(source);
  assert.ok(memo, 'handleApprovalCountChange must be memoized with React.useCallback');
  assert.ok(
    /\[setPendingApprovals\]/.test(memo[0]),
    'its only dependency is the cached-state setter, which is itself stable',
  );
});
