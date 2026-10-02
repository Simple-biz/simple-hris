import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SYNC_PHASE_MOTION,
  SYNC_PHASE_VALUE,
  isTerminalPhase,
  isWorkingPhase,
  phaseMotionSpan,
  scaleXOf,
  type SyncPhase,
} from './sync-progress';

const ALL: SyncPhase[] = ['reading', 'confirm', 'applying', 'saving', 'done', 'failed'];

describe('the sync button’s progress bar', () => {
  test('only a confirmed save fills it: no working phase glides to the end', () => {
    for (const phase of ALL.filter(isWorkingPhase)) {
      const m = SYNC_PHASE_MOTION[phase];
      assert.equal(m.kind, 'glide');
      if (m.kind === 'glide') assert.ok(m.to < 1, `${phase} stops at ${m.to}`);
    }
    const done = SYNC_PHASE_MOTION.done;
    assert.ok(done.kind === 'glide' && done.to === 1);
  });

  test('each phase reaches further than the one before, so the bar keeps moving forward', () => {
    const to = (p: SyncPhase) => {
      const m = SYNC_PHASE_MOTION[p];
      return m.kind === 'glide' ? m.to : -1;
    };
    assert.ok(to('reading') < to('applying') && to('applying') < to('saving') && to('saving') < to('done'));
  });

  test('it never moves backwards, and a hold stays put', () => {
    assert.deepEqual(phaseMotionSpan(0.7, 'applying', false), { from: 0.7, to: 0.78 });
    assert.deepEqual(phaseMotionSpan(0.9, 'applying', false), { from: 0.9, to: 0.9 });
    assert.deepEqual(phaseMotionSpan(0.42, 'confirm', false), { from: 0.42, to: 0.42 });
    assert.deepEqual(phaseMotionSpan(0.63, 'failed', false), { from: 0.63, to: 0.63 });
    assert.deepEqual(phaseMotionSpan(0.8, 'done', false), { from: 0.8, to: 1 });
  });

  test('a new run starts empty, whatever the last run left', () => {
    assert.deepEqual(phaseMotionSpan(1, 'reading', true), { from: 0, to: 0.6 });
  });

  test('assistive tech hears a steady value per phase, and none once it failed', () => {
    const values = (['reading', 'confirm', 'applying', 'saving', 'done'] as SyncPhase[]).map((p) => SYNC_PHASE_VALUE[p]!);
    assert.deepEqual([...values].sort((a, b) => a - b), values);
    assert.equal(SYNC_PHASE_VALUE.done, 100);
    assert.equal(SYNC_PHASE_VALUE.failed, null);
  });

  test('reading the bar’s computed transform', () => {
    assert.equal(scaleXOf('matrix(0.42, 0, 0, 1, 0, 0)'), 0.42);
    assert.equal(scaleXOf('matrix3d(0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)'), 0.5);
    assert.equal(scaleXOf('none'), 1);
    assert.equal(scaleXOf(''), 0);
  });

  test('phase kinds', () => {
    assert.deepEqual(ALL.filter(isWorkingPhase), ['reading', 'applying', 'saving']);
    assert.deepEqual(ALL.filter(isTerminalPhase), ['done', 'failed']);
  });
});
