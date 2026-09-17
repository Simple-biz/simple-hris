import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  divideIntoGroups,
  fpuGroupCount,
  fpuGroupSeed,
  leastLoadedGroupNo,
  validatePerGroup,
  type FpuGroupCandidate,
} from './fpu-groups';

const people = (n: number): FpuGroupCandidate[] =>
  Array.from({ length: n }, (_, i) => ({
    // Deliberately NOT in sorted order, and deliberately not alphabetical by name:
    // the divider must impose its own stable order before shuffling.
    enrollmentId: `e-${String(n - i).padStart(3, '0')}`,
    email: `p${i}@simple.biz`,
    name: `Person ${i}`,
  }));

const sizes = (groups: { members: unknown[] }[]) => groups.map((g) => g.members.length);

// Kane, 2026-09-17, Q4: the number is a TARGET, not a cap.
test('13 people at 4 per group is 4/3/3/3, never 4/4/4/1', () => {
  const g = divideIntoGroups(people(13), 4, 'seed');
  assert.equal(g.length, 4);
  assert.deepEqual(sizes(g).sort((a, b) => b - a), [4, 3, 3, 3]);
});

test('every division is balanced to within one person', () => {
  for (const n of [2, 3, 5, 7, 9, 10, 17, 23, 41, 97, 193]) {
    for (const per of [2, 3, 4, 5, 8]) {
      const g = divideIntoGroups(people(n), per, `s-${n}-${per}`);
      const s = sizes(g);
      assert.equal(s.reduce((a, b) => a + b, 0), n, `${n}/${per} loses people`);
      assert.ok(Math.max(...s) - Math.min(...s) <= 1, `${n}/${per} is lopsided: ${s.join(',')}`);
      // Nobody is ever grouped alone unless the whole class is one person.
      if (n >= 2) assert.ok(Math.min(...s) >= 2, `${n}/${per} stranded someone: ${s.join(',')}`);
      // The target is respected wherever respecting it does not strand anyone.
      if (Math.floor(n / 2) >= Math.ceil(n / per)) assert.ok(Math.max(...s) <= per, `${n}/${per} exceeded the target: ${s.join(',')}`);
    }
  }
});

test('nobody is lost, duplicated, or left out', () => {
  const p = people(31);
  const g = divideIntoGroups(p, 5, 'seed');
  const placed = g.flatMap((x) => x.members.map((m) => m.enrollmentId));
  assert.equal(placed.length, 31);
  assert.equal(new Set(placed).size, 31);
  assert.deepEqual([...placed].sort(), p.map((x) => x.enrollmentId).sort());
});

test('group numbers are 1-based and contiguous', () => {
  const g = divideIntoGroups(people(10), 3, 'seed');
  assert.deepEqual(g.map((x) => x.groupNo), [1, 2, 3, 4]);
});

// The preview/confirm contract: HR confirms what HR saw.
test('the same seed always deals the same division, whatever order the rows arrive in', () => {
  const p = people(20);
  const a = divideIntoGroups(p, 4, 'fixed');
  const b = divideIntoGroups([...p].reverse(), 4, 'fixed');
  const shuffledInput = [...p].sort((x, y) => x.email.localeCompare(y.email));
  const c = divideIntoGroups(shuffledInput, 4, 'fixed');
  const key = (g: ReturnType<typeof divideIntoGroups>) => g.map((x) => x.members.map((m) => m.enrollmentId).join(',')).join('|');
  assert.equal(key(a), key(b));
  assert.equal(key(a), key(c));
});

test('a different seed deals a different division', () => {
  const p = people(20);
  const key = (s: string) => divideIntoGroups(p, 4, s).map((x) => x.members.map((m) => m.enrollmentId).join(',')).join('|');
  assert.notEqual(key('roll-0'), key('roll-1'));
});

test('the division is not just the input order re-cut', () => {
  const p = people(24);
  const stable = [...p].sort((a, b) => a.enrollmentId.localeCompare(b.enrollmentId));
  const first = divideIntoGroups(p, 4, 'seed')[0]!.members.map((m) => m.enrollmentId);
  assert.notDeepEqual(first, stable.slice(0, first.length).map((m) => m.enrollmentId));
});

test('changing the size changes the permutation, not just the cut', () => {
  const p = people(24);
  const at4 = divideIntoGroups(p, 4, fpuGroupSeed('c1', 4, 0));
  const at6 = divideIntoGroups(p, 6, fpuGroupSeed('c1', 6, 0));
  assert.notDeepEqual(at4[0]!.members.map((m) => m.enrollmentId), at6[0]!.members.slice(0, at4[0]!.members.length).map((m) => m.enrollmentId));
});

test('the seed names the class, the size and the roll', () => {
  assert.equal(fpuGroupSeed('abc', 4, 2), 'abc|4|2');
  assert.notEqual(fpuGroupSeed('abc', 4, 0), fpuGroupSeed('abc', 4, 1));
  assert.notEqual(fpuGroupSeed('abc', 4, 0), fpuGroupSeed('xyz', 4, 0));
});

test('a small class runs one over target rather than grouping someone alone', () => {
  assert.deepEqual(sizes(divideIntoGroups(people(5), 2, 's')).sort((a, b) => b - a), [3, 2]);
  assert.deepEqual(sizes(divideIntoGroups(people(7), 2, 's')).sort((a, b) => b - a), [3, 2, 2]);
  assert.deepEqual(sizes(divideIntoGroups(people(3), 2, 's')), [3]);
  assert.deepEqual(sizes(divideIntoGroups(people(2), 2, 's')), [2]);
});

test('degenerate populations', () => {
  assert.deepEqual(divideIntoGroups([], 4, 's'), []);
  assert.deepEqual(sizes(divideIntoGroups(people(1), 4, 's')), [1]);
  assert.equal(fpuGroupCount(0, 4), 0);
  assert.equal(fpuGroupCount(1, 4), 1);
  assert.equal(fpuGroupCount(12, 4), 3);
  assert.equal(fpuGroupCount(13, 4), 4);
});

test('a late arrival goes to the least loaded group, ties to the lowest number', () => {
  assert.equal(leastLoadedGroupNo(new Map([[1, 4], [2, 3], [3, 4]])), 2);
  assert.equal(leastLoadedGroupNo(new Map([[1, 3], [2, 3], [3, 4]])), 1);
  assert.equal(leastLoadedGroupNo(new Map()), null);
});

test('validatePerGroup refuses what the table would refuse, in words', () => {
  assert.deepEqual(validatePerGroup(4, 13), { ok: true, perGroup: 4 });
  for (const [raw, needle] of [[1, /at least/], [0, /at least/], [4.5, /whole number/], ['x', /whole number/], [999, /more than/]] as const) {
    const r = validatePerGroup(raw, 13);
    assert.equal(r.ok, false, String(raw));
    if (!r.ok) assert.match(r.error, needle);
  }
  const empty = validatePerGroup(4, 0);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.error, /approved seat/);
});
