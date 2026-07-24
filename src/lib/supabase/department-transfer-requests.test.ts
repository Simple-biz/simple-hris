/**
 * Coverage for planDepartmentApply — the pure decision behind "Apply now".
 * It answers WHICH master rows to move / delete so an employee ends up in the
 * target department, without insisting they still sit in the source department,
 * and without violating the (work email, department) unique index.
 *
 * Run:  npx tsx --test src/lib/supabase/department-transfer-requests.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDepartmentApply, type CandidateMasterRow } from './department-transfer-requests';

test('clean path: employee still in source dept -> move that row only', () => {
  const rows: CandidateMasterRow[] = [
    { id: 1, dept: 'HSL', workEmail: 'a@x.com' },
    { id: 2, dept: 'Sales', workEmail: 'a@x.com' }, // an unrelated dept they also hold
  ];
  // HSL -> Lead Gen: move the HSL row, leave the Sales row alone.
  assert.deepEqual(planDepartmentApply(rows, 'HSL', 'Lead Gen'), {
    resolution: 'moved',
    moveIds: [1],
    deleteIds: [],
  });
});

test('already in target -> satisfied, no move', () => {
  const rows: CandidateMasterRow[] = [{ id: 7, dept: 'HR', workEmail: 'a@x.com' }];
  assert.deepEqual(planDepartmentApply(rows, 'Lead Gen', 'HR'), {
    resolution: 'satisfied',
    moveIds: [],
    deleteIds: [],
  });
});

test('source label drifted, on roster elsewhere -> reconcile all matched rows', () => {
  // Ivan: transfer Lead Gen -> hsl:intake_specialist, but he currently shows HSL.
  const rows: CandidateMasterRow[] = [{ id: 42, dept: 'HSL', workEmail: 'a@x.com' }];
  assert.deepEqual(planDepartmentApply(rows, 'Lead Gen', 'hsl:intake_specialist'), {
    resolution: 'moved',
    moveIds: [42],
    deleteIds: [],
  });
});

test('not on roster (no candidates) -> notFound', () => {
  assert.deepEqual(planDepartmentApply([], 'Client VA', 'Lead Gen'), {
    resolution: 'notFound',
    moveIds: [],
    deleteIds: [],
  });
});

test('department matching is case- and whitespace-insensitive', () => {
  const rows: CandidateMasterRow[] = [{ id: 5, dept: '  lead gen ', workEmail: 'a@x.com' }];
  assert.deepEqual(planDepartmentApply(rows, 'Lead Gen', 'HSL'), {
    resolution: 'moved',
    moveIds: [5],
    deleteIds: [],
  });
  assert.deepEqual(planDepartmentApply(rows, 'Sales', 'LEAD GEN'), {
    resolution: 'satisfied',
    moveIds: [],
    deleteIds: [],
  });
});

test('multiple source rows all move together', () => {
  const rows: CandidateMasterRow[] = [
    { id: 1, dept: 'Sales', workEmail: 'a@x.com' },
    { id: 2, dept: 'Sales', workEmail: 'b@x.com' }, // different work email, no collision
  ];
  assert.deepEqual(planDepartmentApply(rows, 'Sales', 'Lead Gen'), {
    resolution: 'moved',
    moveIds: [1, 2],
    deleteIds: [],
  });
});

// ── (work email, target dept) collision — the Jose Cestina case ──

test('source AND target rows share a work email -> delete the source dupe, satisfied', () => {
  // Jose holds HSL (source) AND Lead Gen (target) with the SAME work email. Moving
  // the HSL row to Lead Gen would collide on global_master_list_work_email_dept_uniq.
  // The Lead Gen identity already exists, so: delete the redundant HSL row.
  const rows: CandidateMasterRow[] = [
    { id: 100, dept: 'HSL', workEmail: 'jose@x.com' },
    { id: 200, dept: 'Lead Gen', workEmail: 'jose@x.com' },
  ];
  assert.deepEqual(planDepartmentApply(rows, 'HSL', 'Lead Gen'), {
    resolution: 'satisfied',
    moveIds: [],
    deleteIds: [100],
  });
});

test('mixed: one source row collides, another (different work email) moves', () => {
  // A collides with the target identity; B has a distinct work email so it moves.
  const rows: CandidateMasterRow[] = [
    { id: 1, dept: 'HSL', workEmail: 'jose@x.com' }, // collides
    { id: 2, dept: 'HSL', workEmail: 'other@x.com' }, // clean move
    { id: 3, dept: 'Lead Gen', workEmail: 'jose@x.com' }, // the occupying target row
  ];
  assert.deepEqual(planDepartmentApply(rows, 'HSL', 'Lead Gen'), {
    resolution: 'moved',
    moveIds: [2],
    deleteIds: [1],
  });
});

test('blank work email in source cannot collide -> moves normally', () => {
  // The unique index only covers non-empty work emails; a blank-work-email source
  // row is free to move even if the target has a same-blank row.
  const rows: CandidateMasterRow[] = [
    { id: 1, dept: 'HSL', workEmail: '' },
    { id: 2, dept: 'Lead Gen', workEmail: '' },
  ];
  assert.deepEqual(planDepartmentApply(rows, 'HSL', 'Lead Gen'), {
    resolution: 'moved',
    moveIds: [1],
    deleteIds: [],
  });
});
