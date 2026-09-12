import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * EmployeeProfile bails out with `if (loading) return <ProfileSkeleton />` while
 * the roster row is in flight. `loading` is seeded from the session cache
 * (`master === null`), so a COLD load renders short, then long. Any hook declared
 * below that bail-out is skipped on the first render and called on the second —
 * React's "Rendered more hooks than during the previous render", which blanks the
 * route because there is no error boundary anywhere in app/ or src/.
 *
 * This scans source rather than rendering because the repo has no DOM test setup.
 */
const SRC = readFileSync(
  join(process.cwd(), 'src/components/employee/EmployeeProfile.tsx'),
  'utf8',
);

const HOOK = /\b(useState|useEffect|useMemo|useCallback|useRef|useReducedMotion|useId|useLayoutEffect)\s*\(/;

test('no hook is called below the loading bail-out in EmployeeProfile', () => {
  const lines = SRC.split('\n');
  const bailIndex = lines.findIndex((l) => /if\s*\(loading\)\s*return\s*</.test(l));
  assert.notEqual(bailIndex, -1, 'the `if (loading) return <ProfileSkeleton />` bail-out is gone — update this guard deliberately, do not delete it');

  const offenders: string[] = [];
  for (let i = bailIndex + 1; i < lines.length; i += 1) {
    if (HOOK.test(lines[i])) offenders.push(`EmployeeProfile.tsx:${i + 1}  ${lines[i].trim()}`);
  }

  assert.deepEqual(
    offenders,
    [],
    'Hook(s) called after an early return. React calls a different number of hooks on the loading and loaded renders, which throws. Hoist them ABOVE the bail-out.',
  );
});
