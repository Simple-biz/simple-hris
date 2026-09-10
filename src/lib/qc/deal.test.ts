import test from 'node:test';
import assert from 'node:assert/strict';

import { dealDeptSlots, leastLoadedOfficer, type DealSlot } from './deal';

/** Jackie's nine QC officers, in `employee_roles.assigned_at` order. */
const OFFICERS = ['perry@', 'sam@', 'ivd@', 'joshua@', 'marilyn@', 'maui@', 'enzy@', 'ace@', 'sheila@'];

function roster(n: number, dept = 'lead_gen'): DealSlot[] {
  // Deliberately alphabetical by email, which is how the master list arrives — the
  // old bug was invisible precisely because the input is already sorted.
  return Array.from({ length: n }, (_, i) => ({
    email: `member${String(i).padStart(3, '0')}@simple.biz`,
    dept,
  }));
}

function countsByOfficer(pairs: ReturnType<typeof dealDeptSlots>): number[] {
  const m = new Map<string, number>();
  for (const { officer } of pairs) m.set(officer, (m.get(officer) ?? 0) + 1);
  return [...m.values()].sort((a, b) => a - b);
}

test('every slot is dealt exactly once, to a real officer', () => {
  const slots = roster(97);
  const pairs = dealDeptSlots(slots, OFFICERS, '2026-09-14', 'lead_gen');
  assert.equal(pairs.length, slots.length);
  assert.deepEqual(
    pairs.map((p) => p.slot.email).sort(),
    slots.map((s) => s.email).sort(),
    'no slot dropped or duplicated',
  );
  for (const { officer } of pairs) assert.ok(OFFICERS.includes(officer), `unknown officer ${officer}`);
});

test('the split stays EVEN — counts differ by at most one', () => {
  // 97 across 9 officers is deliberately not divisible.
  for (const n of [9, 10, 97, 193, 280]) {
    const counts = countsByOfficer(dealDeptSlots(roster(n), OFFICERS, '2026-09-14', 'lead_gen'));
    assert.ok(
      counts[counts.length - 1]! - counts[0]! <= 1,
      `n=${n}: spread was ${counts[0]}..${counts[counts.length - 1]}`,
    );
  }
});

/**
 * THE REGRESSION TEST. Until 2026-09-10 the deal sorted by email and handed out
 * `i % officers.length`, so officer #1 always held the alphabetically-first slice.
 * Carla ratified randomization specifically to stop an officer keeping the same
 * people, so this is the assertion that keeps the control real.
 */
test('the deal is NOT the alphabetical round-robin it replaced', () => {
  const slots = roster(97);
  const pairs = dealDeptSlots(slots, OFFICERS, '2026-09-14', 'lead_gen');
  const byEmail = new Map(pairs.map((p) => [p.slot.email, p.officer]));

  const oldDeal = slots.map((s, i) => ({ email: s.email, officer: OFFICERS[i % OFFICERS.length]! }));
  const sameAsOld = oldDeal.filter((o) => byEmail.get(o.email) === o.officer).length;
  // With 9 officers, chance alone puts ~1/9 (~11%) in the same place. Anything near
  // 100% means the shuffle is not shuffling.
  assert.ok(
    sameAsOld < slots.length * 0.4,
    `${sameAsOld}/${slots.length} slots kept their alphabetical officer — the deal is not random`,
  );

  // And specifically: the first officer must not own a contiguous alphabetical block.
  const firstOfficerSlice = pairs.filter((p) => p.officer === OFFICERS[0]).map((p) => p.slot.email);
  const firstNAlphabetical = slots.slice(0, firstOfficerSlice.length).map((s) => s.email);
  assert.notDeepEqual([...firstOfficerSlice].sort(), firstNAlphabetical.sort());
});

test('the same week deals the same way twice — a re-read must be a no-op', () => {
  // The engine recomputes on every GET /api/qc/assignments and writes only the diff.
  // An unstable deal would rewrite the whole week on every dashboard load.
  const slots = roster(60);
  const a = dealDeptSlots(slots, OFFICERS, '2026-09-14', 'lead_gen');
  const b = dealDeptSlots(slots, OFFICERS, '2026-09-14', 'lead_gen');
  assert.deepEqual(a, b);
});

/** Compare WHO EACH MEMBER GETS, never the positional officer sequence: the deal
 *  reorders the slots and then walks `officers[i % n]`, so that sequence is
 *  identical by design and comparing it proves nothing. */
function officerByEmail(pairs: ReturnType<typeof dealDeptSlots>): Map<string, string> {
  return new Map(pairs.map((p) => [p.slot.email, p.officer]));
}

test('a different week deals differently — this is what "randomized weekly" means', () => {
  const slots = roster(60);
  const wk1 = officerByEmail(dealDeptSlots(slots, OFFICERS, '2026-09-14', 'lead_gen'));
  const wk2 = officerByEmail(dealDeptSlots(slots, OFFICERS, '2026-09-21', 'lead_gen'));
  const moved = slots.filter((s) => wk1.get(s.email) !== wk2.get(s.email)).length;
  assert.ok(moved > 0, 'two consecutive weeks dealt identically — nobody changed officer');
  // An independent permutation moves most people; with 9 officers ~8/9 expected.
  assert.ok(moved > slots.length * 0.5, `only ${moved}/${slots.length} changed officer between weeks`);
});

test('two departments in one week are not correlated', () => {
  // Seeded on (period_start, department) precisely so a member who sits in two QC
  // departments does not land on the same officer twice, and so one dept's deal
  // cannot be inferred from the other's.
  const emails = roster(40).map((s) => s.email);
  const a = officerByEmail(dealDeptSlots(roster(40, 'lead_gen'), OFFICERS, '2026-09-14', 'lead_gen'));
  const b = officerByEmail(dealDeptSlots(roster(40, 'callback'), OFFICERS, '2026-09-14', 'callback'));
  const same = emails.filter((e) => a.get(e) === b.get(e)).length;
  assert.ok(same < emails.length * 0.5, `${same}/${emails.length} members drew the same officer in both depts`);
});

test('degenerate inputs deal nothing rather than throwing', () => {
  assert.deepEqual(dealDeptSlots([], OFFICERS, '2026-09-14', 'lead_gen'), []);
  assert.deepEqual(dealDeptSlots(roster(5), [], '2026-09-14', 'lead_gen'), []);
});

test('one officer takes the whole department', () => {
  const pairs = dealDeptSlots(roster(12), ['solo@'], '2026-09-14', 'lead_gen');
  assert.equal(pairs.length, 12);
  assert.ok(pairs.every((p) => p.officer === 'solo@'));
});

test('leastLoadedOfficer picks the minimum, and ties break to the earliest grant', () => {
  const load = new Map([
    ['perry@', 3],
    ['sam@', 1],
    ['ivd@', 1],
  ]);
  // sam@ precedes ivd@ in the officer order (assigned_at), so a tie goes to sam@.
  assert.equal(leastLoadedOfficer(['perry@', 'sam@', 'ivd@'], load), 'sam@');
  // An officer absent from the map counts as zero load, so a brand-new officer fills first.
  assert.equal(leastLoadedOfficer(['perry@', 'sam@', 'fresh@'], load), 'fresh@');
  assert.equal(leastLoadedOfficer([], load), null);
});
