import test from 'node:test';
import assert from 'node:assert/strict';
import { COLLAB_STALE_MS, pickLiveMeta } from './presence-meta';

const NOW = Date.parse('2026-10-08T18:00:00.000Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

interface M {
  section: string;
  active?: boolean;
  focused_at?: string | null;
  online_at?: string;
}

test('THE BUG: a stale entry left in front of the fresh one, and [0] keeps naming it', () => {
  // Lenny 2026-10-08: his wizard entry stayed in the viewer's state when his
  // dispatch entry arrived (realtime-js 2.101.1, now patched; a dropped leave
  // diff leaves the same shape behind). The fresh entry sits BESIDE the stale one.
  const metas: M[] = [
    { section: 'payroll-wizard', active: true, focused_at: ago(2400), online_at: ago(2400) },
    { section: 'payment-dispatch', active: true, focused_at: ago(2400), online_at: ago(10) },
  ];
  assert.equal(metas[0].section, 'payroll-wizard'); // what the rail used to show
  assert.equal(pickLiveMeta(metas, NOW)?.section, 'payment-dispatch');
});

test('two tabs: the one the person focused last wins, wherever it sits in the array', () => {
  const metas: M[] = [
    { section: 'payroll-wizard', active: false, focused_at: ago(300), online_at: ago(200) },
    { section: 'payment-dispatch', active: true, focused_at: ago(60), online_at: ago(5) },
  ];
  assert.equal(pickLiveMeta(metas, NOW)?.section, 'payment-dispatch');
  assert.equal(pickLiveMeta([...metas].reverse(), NOW)?.section, 'payment-dispatch');
});

test('two visible windows side by side: the last-focused one wins, not the last to re-announce', () => {
  const metas: M[] = [
    { section: 'overview', active: true, focused_at: ago(120), online_at: ago(1) },
    { section: 'payment-dispatch', active: true, focused_at: ago(30), online_at: ago(25) },
  ];
  assert.equal(pickLiveMeta(metas, NOW)?.section, 'payment-dispatch');
});

test('a leftover that still claims to be visible loses once it stops re-announcing', () => {
  const stale = (COLLAB_STALE_MS / 1000) + 1;
  const metas: M[] = [
    // Focused more recently, but silent past the stale window: a closed tab
    // whose leave this viewer never received.
    { section: 'payroll-wizard', active: true, focused_at: ago(stale), online_at: ago(stale) },
    { section: 'payment-dispatch', active: true, focused_at: ago(stale + 60), online_at: ago(3) },
  ];
  assert.equal(pickLiveMeta(metas, NOW)?.section, 'payment-dispatch');
});

test('nobody live: the tab the person last looked at is still named', () => {
  const metas: M[] = [
    { section: 'overview', active: false, focused_at: ago(900), online_at: ago(800) },
    { section: 'mesa', active: false, focused_at: ago(400), online_at: ago(400) },
  ];
  assert.equal(pickLiveMeta(metas, NOW)?.section, 'mesa');
});

test('an older bundle (no active / focused_at) still ranks by its newest announcement', () => {
  const metas: M[] = [
    { section: 'payroll-wizard', online_at: ago(2400) },
    { section: 'payment-dispatch', online_at: ago(600) },
  ];
  assert.equal(pickLiveMeta(metas, NOW)?.section, 'payment-dispatch');
});

test('one entry is always the answer, however old; none is null', () => {
  assert.equal(pickLiveMeta([{ section: 'npd', online_at: ago(99999) }], NOW)?.section, 'npd');
  assert.equal(pickLiveMeta([], NOW), null);
  assert.equal(pickLiveMeta(undefined, NOW), null);
});

test('an unparseable timestamp ranks as oldest, never as newest', () => {
  const metas: M[] = [
    { section: 'payroll-wizard', active: true, focused_at: 'garbage', online_at: 'garbage' },
    { section: 'payment-dispatch', active: true, focused_at: ago(10), online_at: ago(10) },
  ];
  assert.equal(pickLiveMeta(metas, NOW)?.section, 'payment-dispatch');
});
