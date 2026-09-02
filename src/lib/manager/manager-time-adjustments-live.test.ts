/**
 * Guard: Manager → Time adjustments must refresh on a TIMER, never on a render.
 *
 * The flicker Kane reported was a fetch loop, not a slow endpoint:
 *
 *   1. `<ManagerTimeAdjustments onCountChange={(n) => setPendingApprovals(n)} />`
 *      handed the child a fresh arrow on every render of the shell.
 *   2. The child folded that prop into `useCallback(..., [onCountChange])` and
 *      mounted it with `useEffect(() => { load(); }, [load])`.
 *   3. Each answered fetch called it, and `useManagerCachedState`'s setter returns
 *      a NEW `{key, value}` object on every call (value and key are deliberately
 *      one piece of state), so React can never bail out on an unchanged count. The
 *      shell re-rendered → new arrow → new closure → the mount effect refired.
 *
 * That loop re-hit `GET /api/manager/time-adjustments` (Supabase reads + Storage
 * signing) for as long as the tab was open, and because the fetch opened with
 * `setLoading(true)` the whole list was swapped for the spinner several times a
 * second — the visible flicker.
 *
 * Three invariants close it, none of them expressible in the type system, so they
 * are pinned here as a source scan (same technique as `dept-label-render.test.ts`
 * and `tab-cache.test.ts`'s `no-skip-flag`):
 *
 *   A. Nothing that can change identity per render may reach the fetch closure.
 *      Callbacks and setters are read through refs; the closure has empty deps.
 *   B. The spinner is derived from `settled` and never re-asserted per fetch —
 *      `manager-dashboard-cache.md` § "Loading flags are part of the rule".
 *      Without this the 60s poll would flash the list forever.
 *   C. The queue is actually live. Other people empty this queue, and that doc is
 *      explicit that stale-and-stop "is how two managers approve the same request
 *      twice."
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const MANAGER_APP = path.join(process.cwd(), 'src', 'components', 'manager', 'ManagerApp.tsx');
/** The workspace was extracted out of the shell on 2026-09-02. */
const TAB = path.join(
  process.cwd(),
  'src',
  'components',
  'manager',
  'ManagerTimeAdjustments.tsx',
);

const shellSource = fs.readFileSync(MANAGER_APP, 'utf8');
const tabSource = fs.readFileSync(TAB, 'utf8');

/**
 * The exported workspace component's body: its declaration to the end of the file,
 * where it is the last declaration.
 */
function workspaceBody(): string {
  const start = tabSource.indexOf('export default function ManagerTimeAdjustments(');
  assert.ok(start > 0, 'ManagerTimeAdjustments was renamed or moved — update this guard');
  return tabSource.slice(start);
}

test('the count callback never reaches the fetch closure directly', () => {
  const body = workspaceBody();
  // Every mention of the prop must be the signature or the ref plumbing. Anything
  // else means it is back inside a closure or a dependency array, which is what
  // turned one mount fetch into a fetch-per-render loop.
  const allowed = [
    /^export default function ManagerTimeAdjustments\(\{$/,
    /^onCountChange,$/,
    /^onCountChange: \(n: number\) => void;$/,
    /^const countChangeRef = useRef\(onCountChange\);$/,
    /^countChangeRef\.current = onCountChange;$/,
  ];
  const offenders = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('onCountChange'))
    .filter((l) => !allowed.some((re) => re.test(l)));
  assert.deepEqual(
    offenders,
    [],
    `onCountChange must be read through countChangeRef only; found: ${offenders.join(' | ')}`,
  );
});

test('the cached-state setter is refed too — it is the loop amplifier', () => {
  const body = workspaceBody();
  // `useManagerCachedState`'s setter is stable, but the payload it writes is what
  // re-renders the shell. Refing it keeps the fetch closure dependency-free even
  // if the hook's contract changes.
  assert.ok(
    /const setPayloadRef = useRef\(setPayload\);/.test(body),
    'the payload setter must be held in a ref',
  );
  assert.ok(
    /setPayloadRef\.current\(next\)/.test(body),
    'the fetch must write through the ref, not the captured setter',
  );
});

test('the fetch closure carries an empty dependency array', () => {
  const body = workspaceBody();
  const decl = body.indexOf('const load = useCallback(');
  assert.ok(decl > 0, 'the loader was renamed — update this guard');
  const deps = /\}, \[([^\]]*)\]\);/.exec(body.slice(decl));
  assert.ok(deps, 'could not read the loader dependency array');
  assert.equal(
    deps[1].trim(),
    '',
    `the loader must depend on nothing — a dep that changes per render refires the mount fetch (found: [${deps[1]}])`,
  );
});

test('no stored loading flag is re-asserted per fetch', () => {
  const body = workspaceBody();
  assert.ok(
    !/setLoading\(/.test(body),
    'a stored loading flag re-asserted per fetch repaints the skeleton over rows already on screen',
  );
  assert.ok(
    !/setSettled\(false\)/.test(body),
    '`settled` means "answered at least once in this mount" and is never reset',
  );
  assert.ok(
    /const \[settled, setSettled\] = useState\(false\)/.test(body),
    'the surface must track `settled` so the skeleton keys on having nothing to paint',
  );
});

test('the queue is kept live by a bounded poll, not by re-rendering', () => {
  const body = workspaceBody();
  const call = /useLiveRefresh\(\{[\s\S]*?\}\);/.exec(body);
  assert.ok(call, 'the workspace must use useLiveRefresh — other people empty this queue');
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
    /onRefresh:\s*load/.test(wiring),
    'the refresh must reuse the loader so the seeded and refreshed paths cannot diverge',
  );
});

test('the queue read stays uncached', () => {
  assert.ok(
    /'\/api\/manager\/time-adjustments', \{ cache: 'no-store' \}/.test(workspaceBody()),
    "the route keeps cache: 'no-store' — the manager cache is a paint cache only",
  );
});

test('signed evidence URLs are never put in the manager cache', () => {
  const body = workspaceBody();
  // They expire; a cached one paints a broken image where an uncached one paints
  // nothing (`manager-dashboard-cache.md` § Not cached, on purpose).
  assert.ok(
    /const \[signedUrls, setSignedUrls\] = useState</.test(body),
    'signedUrls must be plain component state, never a cached key',
  );
  assert.ok(
    !/useManagerCachedState[\s\S]{0,120}signedUrls/.test(body),
    'signedUrls must not be routed through the manager cache',
  );
});

test('the shell passes a stable callback, never an inline arrow', () => {
  // The original defect was on the shell's line, not inside the tab. Pinning both
  // halves means a future edit to either one cannot reopen the loop on its own.
  assert.ok(
    !/onCountChange=\{\(/.test(shellSource),
    'an inline arrow/function prop re-creates the tab fetch closure on every shell render',
  );
  assert.ok(
    /onCountChange=\{handleApprovalCountChange\}/.test(shellSource),
    'ManagerTimeAdjustments must receive the memoized handleApprovalCountChange',
  );
  const memo = /const handleApprovalCountChange = React\.useCallback\([\s\S]*?\);/.exec(
    shellSource,
  );
  assert.ok(memo, 'handleApprovalCountChange must be memoized with React.useCallback');
  assert.ok(
    /\[setPendingApprovals\]/.test(memo[0]),
    'its only dependency is the cached-state setter, which is itself stable',
  );
});

test('hours are never interpolated raw into the shell gallery', () => {
  // `{r.requested_hours}h` printed `4.566666666666666h` on the Overview hero.
  assert.ok(
    !/\{r\.requested_hours\}h/.test(shellSource),
    'raw hours must go through fmtAdjustmentHours before reaching a screen',
  );
  assert.ok(
    /fmtAdjustmentHours\(r\.requested_hours\)/.test(shellSource),
    'the Overview gallery must format its hours',
  );
});
