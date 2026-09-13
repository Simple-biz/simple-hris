import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPENSATION_SECTIONS, resolveCompensationSection, sectionSlideDirection } from './compensation-sections';
import { PROFILE_SECTIONS } from './profile-tabs';

test('the Pay Stubs label literal survives, because a build test scans for it', () => {
  // src/lib/penny/employee-guides.test.ts:167 does a plain substring scan of
  // EmployeeProfile.tsx for `label: 'Pay Stubs'` and FAILS THE BUILD if it goes.
  assert.ok(COMPENSATION_SECTIONS.some((s) => s.label === 'Pay Stubs'));
});

test('the active section is DERIVED with a fallback, never trusted blindly', () => {
  // A stored section can outlive the condition that offered it — Profile already
  // hides content by state (the Address block is hasAnyAddress-gated).
  assert.equal(resolveCompensationSection('payout', ['rates', 'payStubs']), 'rates');
  assert.equal(resolveCompensationSection('payStubs', ['rates', 'payStubs', 'payout']), 'payStubs');
  assert.equal(resolveCompensationSection(null, ['rates', 'payStubs', 'payout']), 'rates');
});

test('slide direction comes from the CANONICAL order, so a hidden section cannot reverse it', () => {
  assert.equal(sectionSlideDirection('rates', 'payout'), 1);
  assert.equal(sectionSlideDirection('payout', 'rates'), -1);
});

test('resolveCompensationSection falls back to rates when nothing is available', () => {
  // available[0] ?? 'rates' — belt-and-suspenders for an empty available list.
  assert.equal(resolveCompensationSection('rates', []), 'rates');
});

test('sectionSlideDirection treats equal from/to as forward, matching the >= tie-break', () => {
  assert.equal(sectionSlideDirection('payStubs', 'payStubs'), 1);
});

test('COMPENSATION_SECTIONS agrees with PROFILE_SECTIONS.compensation — one canonical list, not two', () => {
  // COMPENSATION_SECTIONS is typed on the flat SectionId union, so a Skills
  // section (e.g. 'commendations') would type-check here without this. This
  // is the only thing tying the two lists together.
  assert.deepEqual(COMPENSATION_SECTIONS.map((s) => s.id), [...PROFILE_SECTIONS.compensation]);
});
