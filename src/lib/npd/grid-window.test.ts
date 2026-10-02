import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { GRID_OVERSCAN, rowRenderPlan, visibleRowWindow, type RowSegment } from './grid-window';

/** Every row 0…n-1 covered exactly once, in order. */
function covers(plan: RowSegment[], n: number) {
  let next = 0;
  for (const s of plan) {
    const from = s.kind === 'rows' ? s.from : s.at;
    const size = s.kind === 'rows' ? s.to - s.from : s.rows;
    assert.equal(from, next, 'no hole and no overlap');
    assert.ok(size > 0);
    next = from + size;
  }
  assert.equal(next, n);
}

describe('the rows the grid draws', () => {
  test('the visible rows plus overscan, clamped to the sheet', () => {
    // 104 px header, 33 px rows, a 600 px viewport scrolled to the top.
    const w = visibleRowWindow({ scrollTop: 0, viewportHeight: 600, headerHeight: 104, rowHeight: 33, rowCount: 620 });
    assert.equal(w.start, 0);
    assert.equal(w.end, Math.ceil((600 - 104) / 33) + GRID_OVERSCAN);
    const mid = visibleRowWindow({ scrollTop: 104 + 300 * 33, viewportHeight: 600, headerHeight: 104, rowHeight: 33, rowCount: 620 });
    assert.equal(mid.start, 300 - GRID_OVERSCAN);
    assert.ok(mid.end > 300 + 600 / 33 && mid.end <= 620);
    const bottom = visibleRowWindow({ scrollTop: 1e9, viewportHeight: 600, headerHeight: 104, rowHeight: 33, rowCount: 620 });
    assert.equal(bottom.end, 620);
    assert.ok(bottom.start <= bottom.end);
  });

  test('an empty sheet draws nothing; a bad row height cannot divide by zero', () => {
    assert.deepEqual(visibleRowWindow({ scrollTop: 0, viewportHeight: 600, headerHeight: 104, rowHeight: 33, rowCount: 0 }), { start: 0, end: 0 });
    const w = visibleRowWindow({ scrollTop: 50, viewportHeight: 600, headerHeight: 104, rowHeight: 0, rowCount: 10 });
    assert.ok(w.end <= 10 && w.start >= 0);
  });

  test('the plan covers every row exactly once, with spacers for the skipped ones', () => {
    const plan = rowRenderPlan(620, { start: 100, end: 140 }, []);
    covers(plan, 620);
    assert.deepEqual(plan, [
      { kind: 'gap', at: 0, rows: 100 },
      { kind: 'rows', from: 100, to: 140 },
      { kind: 'gap', at: 140, rows: 480 },
    ]);
  });

  test('pinned rows (active cell, editor, formula menu) are drawn wherever they are', () => {
    const plan = rowRenderPlan(620, { start: 0, end: 40 }, [619, 300, 300, 39, -1, 9999, 1.5]);
    covers(plan, 620);
    assert.deepEqual(plan, [
      { kind: 'rows', from: 0, to: 40 },
      { kind: 'gap', at: 40, rows: 260 },
      { kind: 'rows', from: 300, to: 301 },
      { kind: 'gap', at: 301, rows: 318 },
      { kind: 'rows', from: 619, to: 620 },
    ]);
  });

  test('a short sheet is drawn whole, with no spacer at all', () => {
    assert.deepEqual(rowRenderPlan(20, { start: 0, end: 40 }, [5]), [{ kind: 'rows', from: 0, to: 20 }]);
    assert.deepEqual(rowRenderPlan(0, { start: 0, end: 0 }, [0]), []);
  });
});
