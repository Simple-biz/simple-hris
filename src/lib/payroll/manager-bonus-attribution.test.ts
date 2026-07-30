import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSharedEmailOwners,
  attributeKpiRows,
  roundedKpiTotals,
  summarizeSharedEmail,
  type AppliedKpiRow,
} from './manager-bonus-attribution';

// ── The 2026-07-30 incident, in miniature ────────────────────────────────────
// Rhocel Bencito's master row carried John Marc Corpuz's personal gmail, so the
// wizard's per-email KPI sum handed BOTH people 2,500 (her pm_team KPI) plus
// 8,666.67 (his HR split) = 11,167. Attribution has to hand each person only
// the rows snapshotted under their own name.

const rhocel = {
  name: 'Bencito, Rhocel "Rhocel"',
  work_email: 'russell@simple.biz',
  personal_email: 'corpuzmachacon@gmail.com',
  alternate_work_email: 'rhocelb@simple.biz',
};
const john = {
  name: 'Corpuz, John Marc "John"',
  work_email: 'johnc@simple.biz',
  personal_email: 'corpuzmachacon@gmail.com',
};

const week: AppliedKpiRow[] = [
  { dept: 'pm_team', name: 'Bencito, Rhocel "Rhocel"', amount: 1000 },
  { dept: 'pm_team', name: 'Bencito, Rhocel "Rhocel"', amount: 1000 },
  { dept: 'pm_team', name: 'Bencito, Rhocel "Rhocel"', amount: 500 },
  { dept: 'hr', name: 'Corpuz, John Marc "John"', amount: 8666.67 },
];

test('an email on two master rows with different names is shared', () => {
  const owners = buildSharedEmailOwners([rhocel, john]);
  const o = owners.get('corpuzmachacon@gmail.com');
  assert.ok(o, 'collision email must be flagged');
  assert.equal(o.length, 2);
});

test('every email column participates in collision detection', () => {
  const owners = buildSharedEmailOwners([
    { name: 'A One', work_email: 'shared@simple.biz' },
    { name: 'B Two', alternate_work_email_2: 'SHARED@simple.biz ' },
  ]);
  assert.ok(owners.get('shared@simple.biz'), 'alternate columns + casing/whitespace must fold in');
});

test('duplicate-person rows (same name tokens) are NOT a collision', () => {
  // Seungyong Lee exists twice on the master list ("Lee, Seungyong" vs
  // "Seungyong, Lee") sharing one gmail — same human, so attribution must not
  // split (splitting would change today's correct behavior for dupe rows).
  const owners = buildSharedEmailOwners([
    { name: 'Lee, Seungyong', personal_email: 'yong092734@gmail.com' },
    { name: 'Seungyong, Lee', personal_email: 'yong092734@gmail.com' },
  ]);
  assert.equal(owners.get('yong092734@gmail.com'), undefined);
});

test('unshared emails are absent from the owners map', () => {
  const owners = buildSharedEmailOwners([rhocel, john]);
  assert.equal(owners.get('russell@simple.biz'), undefined);
  assert.equal(owners.get('johnc@simple.biz'), undefined);
});

test('rows split by snapshotted name: Rhocel gets 2,500, John gets 8,667', () => {
  const owners = buildSharedEmailOwners([rhocel, john]).get('corpuzmachacon@gmail.com')!;

  const hers = attributeKpiRows(week, owners, 'Rhocel Bencito'); // Hubstaff "First Last" order
  assert.equal(roundedKpiTotals(hers.mine).total, 2500);
  assert.deepEqual(roundedKpiTotals(hers.mine).byDept, { pm_team: 2500 });
  assert.equal(hers.foreign.length, 1);
  assert.equal(hers.unattributed.length, 0);

  const his = attributeKpiRows(week, owners, 'Corpuz, John Marc "John"');
  assert.equal(roundedKpiTotals(his.mine).total, 8667);
  assert.deepEqual(roundedKpiTotals(his.mine).byDept, { hr: 8667 });
});

test('curly-quote name snapshots still match their owner', () => {
  const owners = buildSharedEmailOwners([rhocel, john]).get('corpuzmachacon@gmail.com')!;
  const rows: AppliedKpiRow[] = [{ dept: 'pm_team', name: 'Bencito, Rhocel “Rhocel”', amount: 750 }];
  const hers = attributeKpiRows(rows, owners, 'Bencito, Rhocel "Rhocel"');
  assert.equal(roundedKpiTotals(hers.mine).total, 750);
});

test('a row naming neither owner is unattributed, never paid to a claimant', () => {
  const owners = buildSharedEmailOwners([rhocel, john]).get('corpuzmachacon@gmail.com')!;
  const rows: AppliedKpiRow[] = [
    { dept: 'pm_team', name: 'Somebody Else', amount: 999 },
    { dept: 'pm_team', name: null, amount: 111 },
  ];
  const hers = attributeKpiRows(rows, owners, 'Rhocel Bencito');
  assert.equal(hers.mine.length, 0);
  assert.equal(hers.unattributed.length, 2);
});

test('a claimant with no rows of their own gets an empty mine set', () => {
  const owners = buildSharedEmailOwners([rhocel, john]).get('corpuzmachacon@gmail.com')!;
  const onlyHers = week.filter((r) => r.dept === 'pm_team');
  const his = attributeKpiRows(onlyHers, owners, 'Corpuz, John Marc "John"');
  assert.equal(his.mine.length, 0);
  assert.equal(his.foreign.length, 3);
});

test('rounding matches the wizard: per-dept and total round to whole pesos', () => {
  const { total, byDept } = roundedKpiTotals([
    { dept: 'hr', name: 'X', amount: 8666.67 },
    { dept: 'qc', name: 'X', amount: 33.4 },
  ]);
  assert.equal(byDept.hr, 8667);
  assert.equal(byDept.qc, 33);
  assert.equal(total, 8700); // round(8700.07)
});

test('summarizeSharedEmail reports per-owner totals + unattributed for the banner', () => {
  const owners = buildSharedEmailOwners([rhocel, john]).get('corpuzmachacon@gmail.com')!;
  const rows = [...week, { dept: 'qc', name: 'Somebody Else', amount: 42 }];
  const s = summarizeSharedEmail(rows, owners);
  const byName = new Map(s.perOwner.map((o) => [o.displayName, o.total]));
  assert.equal(byName.get('Bencito, Rhocel "Rhocel"'), 2500);
  assert.equal(byName.get('Corpuz, John Marc "John"'), 8667);
  assert.equal(s.unattributed.length, 1);
  assert.equal(s.unattributed[0].amount, 42);
});
