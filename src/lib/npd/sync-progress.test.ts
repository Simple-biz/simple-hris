import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { SYNC_PHASE_RANGE, creepSyncProgress, enterSyncPhase, isTerminalPhase, isWorkingPhase, type SyncPhase } from './sync-progress';

describe('the sync button’s progress bar', () => {
  test('only a confirmed save fills it: no working phase ever creeps to 100', () => {
    for (const phase of ['reading', 'applying', 'saving'] as SyncPhase[]) {
      let pct = enterSyncPhase(0, phase);
      for (let i = 0; i < 10_000; i += 1) pct = creepSyncProgress(pct, phase);
      assert.ok(pct <= SYNC_PHASE_RANGE[phase].ceiling && pct < 100, `${phase} stopped at ${pct}`);
    }
    assert.equal(enterSyncPhase(42, 'done'), 100);
  });

  test('it never moves backwards, entering a phase or ticking inside one', () => {
    assert.equal(enterSyncPhase(70, 'applying'), 70);
    assert.equal(enterSyncPhase(10, 'saving'), 78);
    let pct = 0;
    for (const phase of ['reading', 'confirm', 'applying', 'saving'] as SyncPhase[]) {
      const entered = enterSyncPhase(pct, phase);
      assert.ok(entered >= pct, `${phase} entered at ${entered} from ${pct}`);
      pct = entered;
      for (let i = 0; i < 50; i += 1) {
        const next = creepSyncProgress(pct, phase);
        assert.ok(next >= pct);
        pct = next;
      }
    }
  });

  test('waiting for Replace / Cancel holds still; a failure stops where it was', () => {
    assert.equal(creepSyncProgress(60, 'confirm'), 60);
    assert.equal(enterSyncPhase(63.2, 'failed'), 63.2);
    assert.equal(creepSyncProgress(63.2, 'failed'), 63.2);
    assert.equal(creepSyncProgress(100, 'done'), 100);
  });

  test('phase kinds', () => {
    assert.deepEqual((['reading', 'confirm', 'applying', 'saving', 'done', 'failed'] as SyncPhase[]).filter(isWorkingPhase), ['reading', 'applying', 'saving']);
    assert.deepEqual((['reading', 'confirm', 'applying', 'saving', 'done', 'failed'] as SyncPhase[]).filter(isTerminalPhase), ['done', 'failed']);
  });
});
