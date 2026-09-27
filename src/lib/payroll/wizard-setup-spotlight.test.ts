import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { WizardSetupStep } from './wizard-setup-steps';
import {
  buildSpotlightSlides,
  DONE_RECAP_KEY,
  nextSlideKey,
  resolveActiveKey,
  worstSetupStatus,
} from './wizard-setup-spotlight';

/** The seven rows in rail order, exactly as deriveWizardSetupSteps emits them. */
function rail(overrides: Partial<Record<WizardSetupStep['key'], WizardSetupStep['status']>> = {}): WizardSetupStep[] {
  const base: Array<Pick<WizardSetupStep, 'key' | 'stepNo' | 'label'>> = [
    { key: 'csv', stepNo: '1', label: 'Hubstaff CSV' },
    { key: 'fx', stepNo: '2', label: 'USD rate confirmed' },
    { key: 'orphanage', stepNo: '3', label: 'Orphanage hours' },
    { key: 'kpi', stepNo: '5', label: 'KPI bonuses' },
    { key: 'notes', stepNo: '5', label: 'Notes adjustments' },
    { key: 'contractors', stepNo: '6', label: 'Contractor invoices' },
    { key: 'dispatch', stepNo: '8', label: 'Sent to dispatch' },
  ];
  return base.map((b) => ({ ...b, status: overrides[b.key] ?? 'done', detail: `${b.label} detail` }));
}

const keys = (steps: WizardSetupStep[]) => buildSpotlightSlides(steps).map((s) => s.key);

test('open steps play first, most severe first, rail order breaking ties, then one recap', () => {
  const steps = rail({ fx: 'attention', dispatch: 'pending', csv: 'blocked', contractors: 'attention' });
  assert.deepEqual(keys(steps), ['csv', 'fx', 'contractors', 'dispatch', DONE_RECAP_KEY]);
});

test('a done step never gets its own slide while anything is open', () => {
  const slides = buildSpotlightSlides(rail({ notes: 'attention' }));
  assert.deepEqual(slides.map((s) => s.key), ['notes', DONE_RECAP_KEY]);
  const recap = slides[1];
  assert.equal(recap.kind, 'recap');
  if (recap.kind === 'recap') {
    assert.deepEqual(recap.done.map((s) => s.key), ['csv', 'fx', 'orphanage', 'kpi', 'contractors', 'dispatch']);
  }
});

test('open slides carry their position among the open steps', () => {
  const slides = buildSpotlightSlides(rail({ fx: 'attention', orphanage: 'attention' }));
  const positions = slides.flatMap((s) => (s.kind === 'step' ? [[s.openIndex, s.openTotal]] : []));
  assert.deepEqual(positions, [[1, 2], [2, 2]]);
});

test('no recap when nothing is done yet', () => {
  const all = rail({
    csv: 'blocked', fx: 'attention', orphanage: 'attention', kpi: 'attention',
    notes: 'attention', contractors: 'attention', dispatch: 'pending',
  });
  const slides = buildSpotlightSlides(all);
  assert.equal(slides.length, 7);
  assert.ok(slides.every((s) => s.kind === 'step'));
});

test('a failed read (pending "Couldn\'t read…") is spotlighted as open, never recapped as done', () => {
  const steps = rail({ orphanage: 'pending' });
  const slides = buildSpotlightSlides(steps);
  assert.equal(slides[0].key, 'orphanage');
  const recap = slides.find((s) => s.kind === 'recap');
  assert.ok(recap && recap.kind === 'recap' && !recap.done.some((s) => s.key === 'orphanage'));
});

test('all done → each step in rail order, no recap, no open position', () => {
  const slides = buildSpotlightSlides(rail());
  assert.deepEqual(slides.map((s) => s.key), ['csv', 'fx', 'orphanage', 'kpi', 'notes', 'contractors', 'dispatch']);
  assert.ok(slides.every((s) => s.kind === 'step' && s.openIndex === null));
});

test('no steps → no slides, and the key helpers return null', () => {
  assert.deepEqual(buildSpotlightSlides([]), []);
  assert.equal(resolveActiveKey([], 'fx'), null);
  assert.equal(nextSlideKey([], 'fx'), null);
});

test('resolveActiveKey keeps the current slide across a refresh, else restarts', () => {
  const slides = buildSpotlightSlides(rail({ fx: 'attention', contractors: 'attention' }));
  assert.equal(resolveActiveKey(slides, 'contractors'), 'contractors');
  // fx got fixed between polls — it is now inside the recap, not a slide.
  assert.equal(resolveActiveKey(buildSpotlightSlides(rail({ contractors: 'attention' })), 'fx'), 'contractors');
  assert.equal(resolveActiveKey(slides, null), 'fx');
});

test('nextSlideKey walks the order and wraps', () => {
  const slides = buildSpotlightSlides(rail({ fx: 'attention', contractors: 'attention' }));
  assert.equal(nextSlideKey(slides, 'fx'), 'contractors');
  assert.equal(nextSlideKey(slides, 'contractors'), DONE_RECAP_KEY);
  assert.equal(nextSlideKey(slides, DONE_RECAP_KEY), 'fx');
  assert.equal(nextSlideKey(slides, 'gone'), 'fx');
});

test('worstSetupStatus picks the most urgent row; empty reads pending, never done', () => {
  assert.equal(worstSetupStatus(rail()), 'done');
  assert.equal(worstSetupStatus(rail({ dispatch: 'pending' })), 'pending');
  assert.equal(worstSetupStatus(rail({ dispatch: 'pending', fx: 'attention' })), 'attention');
  assert.equal(worstSetupStatus(rail({ fx: 'attention', csv: 'blocked' })), 'blocked');
  assert.equal(worstSetupStatus([]), 'pending');
});
