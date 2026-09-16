import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fpuClassCode,
  fpuClassLabel,
  fpuClassKey,
  fpuClassPhase,
  nextFpuBatch,
  pickCurrentFpuClass,
  sortFpuClasses,
  validateFpuClassInput,
  type FpuClass,
} from './fpu-class';

const cls = (over: Partial<FpuClass> = {}): FpuClass => ({
  id: 'c1',
  year: 2026,
  batch: 1,
  opens_on: '2026-09-01',
  closes_on: '2026-09-30',
  class_starts_on: '2026-10-08',
  class_ends_on: '2026-11-12',
  schedule_note: null,
  ...over,
});

test('label and key follow the (year, batch) identity Kane named', () => {
  assert.equal(fpuClassLabel({ year: 2026, batch: 3 }), 'FPU 2026 · Batch 3');
  assert.equal(fpuClassCode({ year: 2026, batch: 3 }), 'FPU 2026 · Batch 3');
  assert.equal(fpuClassKey({ year: 2026, batch: 3 }), '2026-3');
});

test('a name replaces the label but never the code; blank names do not count', () => {
  assert.equal(fpuClassLabel({ year: 2026, batch: 1, name: 'Summer Cohort' }), 'Summer Cohort');
  assert.equal(fpuClassCode({ year: 2026, batch: 1 }), 'FPU 2026 · Batch 1');
  assert.equal(fpuClassLabel({ year: 2026, batch: 1, name: '   ' }), 'FPU 2026 · Batch 1');
  assert.equal(fpuClassLabel({ year: 2026, batch: 1, name: null }), 'FPU 2026 · Batch 1');
});

test('the window is inclusive on both ends', () => {
  const c = cls();
  assert.equal(fpuClassPhase(c, '2026-08-31'), 'upcoming');
  assert.equal(fpuClassPhase(c, '2026-09-01'), 'open');
  assert.equal(fpuClassPhase(c, '2026-09-30'), 'open');
  assert.equal(fpuClassPhase(c, '2026-10-01'), 'closed');
});

test('next batch is one past the highest in THAT year, starting at 1', () => {
  const classes = [cls({ year: 2026, batch: 1 }), cls({ year: 2026, batch: 3 }), cls({ year: 2025, batch: 5 })];
  assert.equal(nextFpuBatch(classes, 2026), 4);
  assert.equal(nextFpuBatch(classes, 2027), 1);
  assert.equal(nextFpuBatch([], 2026), 1);
});

test('pickCurrentFpuClass prefers open, then nearest upcoming, then most recently closed', () => {
  const closed = cls({ id: 'closed', opens_on: '2026-01-01', closes_on: '2026-01-31' });
  const olderClosed = cls({ id: 'older', opens_on: '2025-09-01', closes_on: '2025-09-30' });
  const open = cls({ id: 'open', opens_on: '2026-09-01', closes_on: '2026-09-30' });
  const later = cls({ id: 'later', opens_on: '2026-12-01', closes_on: '2026-12-31' });
  const sooner = cls({ id: 'sooner', opens_on: '2026-11-01', closes_on: '2026-11-30' });

  assert.equal(pickCurrentFpuClass([closed, open, later, sooner], '2026-09-15')?.id, 'open');
  assert.equal(pickCurrentFpuClass([closed, later, sooner], '2026-10-15')?.id, 'sooner');
  assert.equal(pickCurrentFpuClass([olderClosed, closed], '2026-05-01')?.id, 'closed');
  assert.equal(pickCurrentFpuClass([], '2026-05-01'), null);
});

test('two overlapping open windows: the one closing first is the deadline that matters', () => {
  const a = cls({ id: 'a', opens_on: '2026-09-01', closes_on: '2026-09-30' });
  const b = cls({ id: 'b', opens_on: '2026-09-10', closes_on: '2026-09-20' });
  assert.equal(pickCurrentFpuClass([a, b], '2026-09-15')?.id, 'b');
});

test('sortFpuClasses is newest first by year then batch', () => {
  const sorted = sortFpuClasses([cls({ year: 2025, batch: 3 }), cls({ year: 2026, batch: 1 }), cls({ year: 2026, batch: 2 })]);
  assert.deepEqual(sorted.map(fpuClassKey), ['2026-2', '2026-1', '2025-3']);
});

const legal = {
  year: 2026,
  batch: 1,
  opens_on: '2026-09-01',
  closes_on: '2026-09-30',
  class_starts_on: '2026-10-08',
  class_ends_on: '2026-11-12',
  schedule_note: '  Thursdays 5 PM EST  ',
};

test('validateFpuClassInput accepts a legal payload and trims the note', () => {
  const r = validateFpuClassInput(legal);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.schedule_note, 'Thursdays 5 PM EST');
    assert.equal(r.value.class_ends_on, '2026-11-12');
  }
});

test('validateFpuClassInput: name is trimmed, blank becomes null, over 80 refused', () => {
  const r = validateFpuClassInput({ ...legal, name: '  Summer Cohort ' });
  assert.ok(r.ok && r.value.name === 'Summer Cohort');
  const blank = validateFpuClassInput({ ...legal, name: '   ' });
  assert.ok(blank.ok && blank.value.name === null);
  const none = validateFpuClassInput(legal);
  assert.ok(none.ok && none.value.name === null);
  const long = validateFpuClassInput({ ...legal, name: 'x'.repeat(81) });
  assert.equal(long.ok, false);
  if (!long.ok) assert.match(long.error, /80 characters/);
});

test('validateFpuClassInput: no end date is a state, not an error', () => {
  const r = validateFpuClassInput({ ...legal, class_ends_on: null });
  assert.ok(r.ok && r.value.class_ends_on === null);
  const r2 = validateFpuClassInput({ ...legal, class_ends_on: '' });
  assert.ok(r2.ok && r2.value.class_ends_on === null);
});

test('validateFpuClassInput refuses what the table refuses, in words', () => {
  const bad = (over: Record<string, unknown>, needle: RegExp) => {
    const r = validateFpuClassInput({ ...legal, ...over });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, needle);
  };
  bad({ year: 1999 }, /year/i);
  bad({ batch: 0 }, /batch/i);
  bad({ batch: 13 }, /batch/i);
  bad({ closes_on: '2026-08-31' }, /close before it opens/);
  bad({ class_ends_on: '2026-10-01' }, /end before it starts/);
  bad({ opens_on: '2026-02-30' }, /real calendar date/);
  bad({ opens_on: '2026-09-01T00:00:00Z' }, /real calendar date/);
  bad({ class_starts_on: '' }, /required/);
});
