/**
 * The departed-member guard: controls over where it is applied, and over the
 * fact that it shares ONE implementation with the Payment Catalog.
 *
 * `loadQcDepartedEmails` itself is `server-only` and pure I/O, so what is worth
 * pinning here is the wiring — the places a future edit could silently undo:
 * the shared predicate, the read-side filter that the sticky snapshot makes
 * mandatory, and the ordering that keeps it in front of `myRows`.
 *
 * Its behaviour against real data is verified by
 * `scripts/verify-qc-departed-members.mts` (read-only, runs the real function).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  hasDepartedBeforeWeek,
  isOffboardedForPaymentCatalog,
  type CatalogVisibilityInput,
} from '@/lib/payment-catalog/catalog-roster-visibility';

const base: CatalogVisibilityInput = {
  evidence: { offDate: '2026-07-20', reason: 'performance' },
  startDate: '2026-06-22',
  cycleWeekStart: '2026-09-06',
  hasCycleHours: false,
};
const input = (o: Partial<CatalogVisibilityInput> = {}): CatalogVisibilityInput => ({ ...base, ...o });

test("johna@'s real shape is hidden: left 2026-07-20, scored week 2026-09-06", () => {
  // Queue completed 2026-07-20, offboarded_sheet row written by the HRIS, master
  // row never stamped, still dealt a Lead Gen slot for 2026-09-14.
  assert.equal(hasDepartedBeforeWeek(input()), true);
});

test('the QC guard and the Payment Catalog run ONE implementation', () => {
  // Two copies of "has this person left" is how two surfaces come to disagree
  // about one employee.
  const cases: CatalogVisibilityInput[] = [
    input(),
    input({ evidence: null }),
    input({ hasCycleHours: true }),
    input({ startDate: null }),
    input({ cycleWeekStart: '' }),
    input({ evidence: { offDate: '2026-07-20', reason: 'temporary_pause' } }),
    input({ evidence: { offDate: '2026-07-20', reason: 'duplicate_cleanup' } }),
    input({ evidence: { offDate: '2026-09-20', reason: 'performance' } }),
  ];
  for (const c of cases) {
    assert.equal(
      isOffboardedForPaymentCatalog(c),
      hasDepartedBeforeWeek(c),
      `the catalog alias must stay a pure delegation: ${JSON.stringify(c)}`,
    );
  }
});

test('someone who left DURING or AFTER the scored week is never hidden', () => {
  // This is the line between the new guard and the roster_status rule that
  // officers.test.ts protects: a person who worked the week and then left stays
  // scoreable. Only a departure that PRE-DATES the week hides anyone.
  assert.equal(hasDepartedBeforeWeek(input({ evidence: { offDate: '2026-09-06', reason: 'resigned' } })), false);
  assert.equal(hasDepartedBeforeWeek(input({ evidence: { offDate: '2026-09-10', reason: 'resigned' } })), false);
  assert.equal(hasDepartedBeforeWeek(input({ evidence: { offDate: '2026-12-01', reason: 'resigned' } })), false);
});

test('hours in the scored week always keep a person, whatever the stamps say', () => {
  assert.equal(hasDepartedBeforeWeek(input({ hasCycleHours: true })), false);
});

test('a re-hire is not hidden by their previous stint', () => {
  assert.equal(hasDepartedBeforeWeek(input({ startDate: '2026-08-01' })), false);
});

const routeSrc = readFileSync(join(process.cwd(), 'app/api/qc/assignments/route.ts'), 'utf8');

test('CONTROL: the assignments route filters departed members at READ time', () => {
  // The deal refusing to create new ghost slots is not enough: a slot is a
  // STICKY SNAPSHOT and is never deleted, so the 188 dealt before this guard
  // existed would render forever without a read-side filter.
  assert.match(
    routeSrc,
    /departedEmails\.has\(/,
    'the route must drop slot-holders who had already left before the week',
  );
});

test('CONTROL: the departed filter runs BEFORE myRows is built', () => {
  const filterAt = routeSrc.indexOf('departedEmails.has(');
  const myRowsAt = routeSrc.indexOf('const myRows');
  assert.ok(filterAt > 0 && myRowsAt > 0);
  assert.ok(
    filterAt < myRowsAt,
    'myRows, assignments, deptTotals and the officer summary all derive from the ' +
      'same filtered rows — filtering after any of them would let one number on ' +
      'screen disagree with another',
  );
});

test('CONTROL: the read-side filter is not a roster_status filter', () => {
  // officers.test.ts forbids gating the officer list on roster_status, and that
  // rule stands. This guard is dated instead: it hides only people whose
  // departure pre-dates the week, never people who worked it and then left.
  const line = routeSrc.split('\n').find((l) => l.includes('departedEmails.has('));
  assert.ok(line);
  assert.doesNotMatch(line, /roster_status/);
});

const calcSrc = readFileSync(
  join(process.cwd(), 'src/components/manager/DeptBonusCalculator.tsx'),
  'utf8',
);

test('CONTROL: the calculator filters its member list in exactly one place', () => {
  // The first cut of this control counted every `isDepartedMember(` line and
  // broke the moment a COUNT was derived beside the filter — a detector that
  // cannot tell filtering from counting. What actually matters is that the
  // member list is narrowed once, at the source: filtering per render site is
  // how two numbers on one screen come to disagree.
  const filters = calcSrc.split('\n').filter((l) => l.includes('teamMembersAll.filter(')).length;
  assert.equal(filters, 1, 'the unfiltered roster is narrowed exactly once');
  assert.match(
    calcSrc,
    /useDepartedMembers\(weekResolved \? weekStart : ''\)/,
    'never filter on the unresolved week seed',
  );
});

test('CONTROL: the Active tile cannot disagree with the panel header', () => {
  // Both count `allMembers`. A second source for either — the roster map, a
  // re-filter, a length taken before the search — is how a header saying
  // "40 people" ends up above a tile saying 38.
  assert.match(
    calcSrc,
    /const activeCount = allMembers\.length - leaverCount;/,
    'Active is allMembers minus the leavers counted from that same array',
  );
  assert.match(
    calcSrc,
    /const leaverCount = allMembers\.filter\(\(m\) =>\s*\n?\s*offboardedEmailSet\.has\(canonEmail\(m\.email\)\),\s*\n?\s*\)\.length;/,
    'a leaver is identified by the SAME set the row chip uses, not a second rule',
  );
});

test('CONTROL: neither figure prints for an unresolved week', () => {
  // 0 is a claim ("nobody is offboarded"); the skeleton is an admission.
  for (const m of [
    /\{weekResolved \? activeCount : <CountSkeleton \/>\}/,
    /\{weekResolved \? offboardedThisWeek : <CountSkeleton \/>\}/,
  ]) {
    assert.match(calcSrc, m, 'both figures gate on weekResolved');
  }
});

test('CONTROL: the Offboarded figure counts THIS WEEK, not everyone who ever left', () => {
  // The bug Kane caught: it showed leavers already added to the table and
  // carried the hidden-departed figure beside it — for Lead Gen on 2026-09-06
  // that was 158 people who ALL left in July, printed under the word
  // "offboarded". It read as "158 left last week". It was not: ZERO Lead Gen
  // people left during that week, and the real figure is 93.
  // Anchor on CODE. 'Add External Member' also appears in a comment far above,
  // and indexOf would find that first — the slice then comes back empty and the
  // control passes on nothing.
  const figureAt = calcSrc.indexOf('offboardedThisWeek : <CountSkeleton');
  const buttonAt = calcSrc.indexOf('setExtAddKey(key)}');
  assert.ok(figureAt > 0 && buttonAt > figureAt, 'the offboarded figure sits before the Add External control');
  const stat = calcSrc.slice(figureAt, buttonAt);
  assert.doesNotMatch(
    stat,
    /deptDepartedHidden/,
    'people who left in earlier weeks must never be counted beside the word "offboarded"',
  );
  assert.doesNotMatch(stat, /leaverCount/, 'not "leavers already added" — that shrinks as you add them');
});

test('CONTROL: the hidden-departed figure is disclosed, but never as "offboarded"', () => {
  // Silence would be its own defect: a roster that quietly drops 158 people gets
  // reported as data loss. It is shown — on its own line, in its own words.
  const at = calcSrc.indexOf('deptDepartedHidden > 0 && (');
  assert.ok(at > 0, 'the disclosure renders when there is something to disclose');
  // End at the paragraph's own close: 700 characters would run into the
  // "Recently offboarded members" comment below and match its word, not ours.
  const snippet = calcSrc.slice(at, calcSrc.indexOf('</p>', at));
  assert.match(snippet, /who left before\s+this week/, 'it says WHEN they left');
  assert.doesNotMatch(
    snippet.toLowerCase(),
    /offboarded/,
    'and never borrows the word the toolbar figure uses',
  );
});

test('CONTROL: the figures sit in the toolbar, not in a gradient hero card', () => {
  // PRODUCT.md anti-reference: "No gradient-heavy hero treatments." The craft
  // floor refuses the hero-metric template outright. This is an Operate surface.
  assert.doesNotMatch(calcSrc, /StatCard/, 'no gradient KPI card on this surface');
  assert.doesNotMatch(calcSrc, /kpi-stat-card/, 'and no import left behind');
});
