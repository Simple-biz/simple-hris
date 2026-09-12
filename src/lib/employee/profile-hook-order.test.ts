import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * EmployeeProfile bails out with a whole-page ProfileSkeleton early return while
 * the roster row is in flight. `loading` is seeded from the session cache
 * (`master === null`), so a COLD load renders short, then long. Any hook declared
 * below that early return is skipped on the first render and called on the second —
 * React's "Rendered more hooks than during the previous render", which blanks the
 * route because there is no error boundary anywhere in app/ or src/.
 *
 * This scans source rather than rendering because the repo has no DOM test setup.
 */
const SRC = readFileSync(
  join(process.cwd(), 'src/components/employee/EmployeeProfile.tsx'),
  'utf8',
);

/**
 * ANY hook call — generic arguments and custom hooks included.
 *
 * The first version of this guard listed eight hook names and required `(`
 * IMMEDIATELY after the name. That made every generic call invisible to it: 23 of
 * the file's 59 hook-call lines, 39%, among them `useState<TabId>('overview')`,
 * `useState<SectionId | null>(null)` and all four `useEmployeeCachedState<T>(`
 * calls. A hook added below the early return WITH a type argument would have
 * passed this guard green and blanked /employee on every cold load — the exact
 * crash the guard exists to prevent. Matching `use[A-Z]…` closes the custom-hook
 * gap at the same time; `useEmployeeCachedState` is a hook like any other.
 *
 * `[^()<>]*` keeps the optional type argument from swallowing a call: it matches
 * `useState<SectionId | null>(` but cannot run past a `(` or a nested `<`.
 */
const HOOK = /\buse[A-Z][A-Za-z0-9_]*\s*(<[^()<>]*>)?\s*\(/;

/** The early return this guard anchors on. */
const BAIL_OUT = /if\s*\(loading\)\s*return\s*</;

/**
 * Blanks `//` line comments and block comments, preserving the line count so
 * reported line numbers stay true. Quote-aware, so a `//` inside a string stays.
 *
 * Used for ANCHORING ONLY, never for hook detection. The guard previously
 * anchored on raw source, so a COMMENT quoting the early return anchored it ~670
 * lines too early and produced 28 phantom offenders (2026-09-12, Task 6). Hook
 * detection deliberately still runs on the RAW lines: a hook cannot execute
 * inside a comment, so scanning stripped source could only ever hide one, and
 * the asymmetry here is the whole point — a false alarm on this guard costs a
 * reworded comment, a missed hook blanks /employee for everyone. Every failure
 * mode of this stripper is loud: blank the real early return and the anchor is
 * reported gone, leave a comment standing and the duplicate-anchor assert fires.
 */
function stripComments(src: string): string {
  type State = 'code' | 'line' | 'block' | "'" | '"' | '`';
  let state: State = 'code';
  let out = '';

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];

    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; out += '  '; i += 1; continue; }
      if (c === '/' && next === '*') { state = 'block'; out += '  '; i += 1; continue; }
      if (c === "'" || c === '"' || c === '`') state = c;
      out += c;
      continue;
    }

    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; continue; }
      out += ' ';
      continue;
    }

    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; out += '  '; i += 1; continue; }
      out += c === '\n' ? c : ' ';
      continue;
    }

    // Inside a string or template literal — copied through untouched.
    out += c;
    if (c === '\\') { out += next ?? ''; i += 1; continue; }
    if (c === state) state = 'code';
  }

  return out;
}

test('no hook is called below the loading bail-out in EmployeeProfile', () => {
  const lines = SRC.split('\n');
  const codeLines = stripComments(SRC).split('\n');
  assert.equal(codeLines.length, lines.length, 'comment stripping changed the line count — reported line numbers would be wrong');

  const anchors: number[] = [];
  codeLines.forEach((l, i) => { if (BAIL_OUT.test(l)) anchors.push(i); });

  assert.notEqual(
    anchors.length,
    0,
    'the `if (loading) return <ProfileSkeleton />` bail-out is gone — update this guard deliberately, do not delete it',
  );
  assert.equal(
    anchors.length,
    1,
    `the bail-out pattern appears ${anchors.length} times in CODE (lines ${anchors.map((i) => i + 1).join(', ')}), so this guard cannot tell which one is the real early return. Comments are already stripped before anchoring, so a second match means real code — keep exactly one, or teach this guard which is which. Do NOT relax it.`,
  );

  const bailIndex = anchors[0];
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
