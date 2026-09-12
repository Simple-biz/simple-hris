import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard: no roster/pay/resignation date-only value in EmployeeProfile renders
 * through a bare `new Date(...)`.
 *
 * Task 3 (employee-profile-tab-merge, 2026-09-12) replaced EmployeeProfile's own
 * `formatStartDate`, which built `new Date(raw)` directly and read a day early
 * for every viewer west of UTC, with a direct alias of `formatDateOnly`
 * (`@/lib/date-only`) — the same renderer the ID card uses. Tasks 7-12 of that
 * same plan edit these exact lines heavily (folding nine tabs into five), and
 * nothing else stops one of them reintroducing an inline `new Date(...)` beside
 * the shared renderer on a Start Date, pay-stub date, or resignation effective
 * date. This scans source rather than rendering because the repo has no DOM
 * test setup (see profile-hook-order.test.ts, dept-label-render.test.ts — the
 * same house pattern this guard follows).
 *
 * Deliberately narrow: a handful of `new Date()` calls in this file are NOT a
 * roster/pay/resignation date-only value — a wall-clock "saved at" stamp, a
 * real timestamp column, and a DatePicker's "today" floor. Those are allowed
 * below by exact snippet, each with its own reason, exactly as
 * dept-label-render.test.ts's ALLOWED_SNIPPETS does. If the next reason isn't
 * this good, it isn't an exception — fix the call site instead.
 */
const FILE = join(process.cwd(), 'src/components/employee/EmployeeProfile.tsx');
const SRC = readFileSync(FILE, 'utf8');

const NEW_DATE = /\bnew Date\(/;

/** A comment line never executes — mentioning `new Date(...)` in prose is not a call site. */
const COMMENT_LINE = /^(\*|\/\/|\/\*)/;

const ALLOWED_SNIPPETS: ReadonlyArray<{ snippet: string; why: string }> = [
  {
    snippet: 'setSkillSetSavedAt(new Date().toLocaleTimeString());',
    why: "A wall-clock 'saved at' stamp for the skills save toast, not a stored date-only value.",
  },
  {
    snippet: 'setPayoutSavedAt(new Date().toLocaleTimeString());',
    why: "Same — a wall-clock 'saved at' stamp for the Payment tab's save toast.",
  },
  {
    snippet:
      "{new Date(c.awarded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}",
    why: 'c.awarded_at is a real timestamp (bonus award moment), not a DATE-only column — normal Date parsing is correct here.',
  },
  {
    snippet: "min={new Date().toISOString().slice(0, 10)}",
    why: "Today's floor for the resignation DatePicker — \"now\", not a stored roster/pay/resignation value.",
  },
];

test('EmployeeProfile renders no date-only value through a bare new Date(...)', () => {
  const lines = SRC.split('\n');
  const offenders: string[] = [];

  lines.forEach((line, i) => {
    if (!NEW_DATE.test(line)) return;
    const trimmed = line.trim();
    if (COMMENT_LINE.test(trimmed)) return;
    if (ALLOWED_SNIPPETS.some((a) => trimmed === a.snippet)) return;
    offenders.push(`EmployeeProfile.tsx:${i + 1}  ${trimmed}`);
  });

  assert.deepEqual(
    offenders,
    [],
    'A bare new Date(...) reappeared beside formatDateOnly. A roster/pay/resignation ' +
      'date-only value must render through formatStartDate (an alias of formatDateOnly, ' +
      '@/lib/date-only) so it never reads a day early for viewers west of UTC. If this is ' +
      'genuinely not a date-only value (a wall clock, a real timestamp, a "today" floor), ' +
      'add it to ALLOWED_SNIPPETS above, by name, with a reason — never loosen the pattern ' +
      'this test scans for.\n' +
      offenders.join('\n'),
  );
});
