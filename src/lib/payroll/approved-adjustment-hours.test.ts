/**
 * The one rule for what an approved time adjustment makes a day.
 *
 * Kane, 2026-09-15: Accounting no longer types the day total, so the number is
 * derived from the employee's own submission. These pin the failure classes that
 * opens: double-counting a legacy day total, losing a stored total, and silently
 * applying nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  adjustmentNeedsTrackedHours,
  approvedAdjustmentDayHours,
} from './approved-adjustment-hours';

const SEG = [{ time_in: '17:10', time_out: '17:15' }];

// ─── A stored total is a human's statement and always wins ──────────────────

test('a stored total wins over any derivation — an already-paid figure is never restated', () => {
  assert.equal(
    approvedAdjustmentDayHours({ approved_hours: 8, requested_hours: 1, requested_segments: SEG }, 6),
    8,
  );
});

test('a stored ZERO is a deliberate zero-out, not an absence', () => {
  assert.equal(
    approvedAdjustmentDayHours({ approved_hours: 0, requested_hours: 1, requested_segments: SEG }, 7),
    0,
  );
});

test('a negative stored total is refused, and the derivation takes over', () => {
  assert.equal(
    approvedAdjustmentDayHours({ approved_hours: -1, requested_hours: 1, requested_segments: SEG }, 6),
    7,
  );
});

// ─── The derivation: tracked + the missed time the employee evidenced ────────

test('with no stored total the day becomes tracked PLUS the missed time', () => {
  assert.equal(
    approvedAdjustmentDayHours({ approved_hours: null, requested_hours: 1.5, requested_segments: SEG }, 6),
    7.5,
  );
});

test("Carla's 5-minute row on a 7h day makes 7h 5m, with nobody typing anything", () => {
  const fiveMinutes = 0.08333333333333333;
  const total = approvedAdjustmentDayHours(
    { approved_hours: null, requested_hours: fiveMinutes, requested_segments: SEG },
    7,
  );
  assert.ok(total != null);
  assert.ok(Math.abs(total - 7.08333333333333) < 1e-9, String(total));
});

test('a day nobody tracked yields exactly the missed time — 0 tracked is a real value', () => {
  assert.equal(
    approvedAdjustmentDayHours({ approved_hours: null, requested_hours: 3, requested_segments: SEG }, 0),
    3,
  );
});

// ─── The double-count guard: a legacy row stored a DAY TOTAL in the same column ──

test('a row with NO segments is never added to tracked hours — that column is a day total there', () => {
  assert.equal(
    approvedAdjustmentDayHours({ approved_hours: null, requested_hours: 8, requested_segments: [] }, 6),
    null,
  );
  assert.equal(
    approvedAdjustmentDayHours({ approved_hours: null, requested_hours: 8 }, 6),
    null,
  );
});

test('an unusable row applies NOTHING rather than guessing', () => {
  assert.equal(
    approvedAdjustmentDayHours({ approved_hours: null, requested_hours: null, requested_segments: SEG }, 6),
    null,
  );
  assert.equal(
    approvedAdjustmentDayHours({ approved_hours: null, requested_hours: 0, requested_segments: SEG }, 6),
    null,
  );
});

test('a non-finite tracked figure is treated as zero, never as NaN reaching pay', () => {
  const total = approvedAdjustmentDayHours(
    { approved_hours: null, requested_hours: 2, requested_segments: SEG },
    Number.NaN,
  );
  assert.equal(total, 2);
});

// ─── Which rows force a tracked-hours lookup ────────────────────────────────

test('only a row without a stored total needs tracked hours looked up', () => {
  assert.equal(
    adjustmentNeedsTrackedHours({ approved_hours: null, requested_hours: 1, requested_segments: SEG }),
    true,
  );
  assert.equal(
    adjustmentNeedsTrackedHours({ approved_hours: 8, requested_hours: 1, requested_segments: SEG }),
    false,
  );
  assert.equal(
    adjustmentNeedsTrackedHours({ approved_hours: null, requested_hours: 8, requested_segments: [] }),
    false,
  );
});

// ─── Source-shape guards: every overlay surface uses this rule ───────────────

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');

test('every surface that overlays approved adjustments goes through this module', () => {
  const surfaces: Array<[string, string[]]> = [
    ['Payroll Wizard', ['src', 'components', 'PayrollWizard.tsx']],
    ['the dispatch PAB engine', ['src', 'lib', 'payroll', 'dispatch-bonuses.ts']],
    ['the live pay estimate', ['src', 'lib', 'payroll', 'current-pay.ts']],
    ['HSL monthly pay', ['src', 'lib', 'payroll', 'member-monthly-pay.ts']],
    ['the Accounting Overview', ['src', 'components', 'Overview.tsx']],
    ['the employee PAB calendar', ['src', 'components', 'employee', 'EmployeePabCalendar.tsx']],
  ];
  for (const [label, p] of surfaces) {
    assert.ok(
      read(...p).includes('payroll/approved-adjustment-hours'),
      `${label} does not import the shared approved-adjustment rule`,
    );
  }
});

test('no overlay surface still skips a row merely because approved_hours is null', () => {
  // That test was the old shape: `if (row.approved_hours == null) continue;`. Left in
  // place anywhere, an approval carrying no stored total silently applies NOTHING —
  // no pay delta and no PAB forgiveness — which is the worst outcome of this change.
  const files = [
    ['src', 'lib', 'payroll', 'current-pay.ts'],
    ['src', 'lib', 'payroll', 'member-monthly-pay.ts'],
    ['src', 'components', 'Overview.tsx'],
    ['src', 'components', 'employee', 'EmployeePabCalendar.tsx'],
    ['src', 'components', 'PayrollWizard.tsx'],
  ];
  for (const p of files) {
    const src = read(...p);
    assert.ok(
      !/approved_hours\s*==\s*null\)\s*continue/.test(src),
      `${p.join('/')} still drops rows with no stored total`,
    );
  }
});

test('the Accounting decision surfaces no longer collect a day total', () => {
  const issues = read('src', 'components', 'payroll', 'TimeAdjustmentIssueRows.tsx');
  assert.ok(!issues.includes('approvedHoursFromInputs('), 'the Issues dialog still parses an hours entry');
  assert.ok(!/Set the employee/.test(issues), 'the Issues dialog still asks for the final total');
  const panel = read('src', 'components', 'payroll', 'TimeAdjustmentReviewPanel.tsx');
  assert.ok(!/Set time/.test(panel), 'the wizard panel still asks for a Set time value');
});
