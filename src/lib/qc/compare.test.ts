import test from 'node:test';
import assert from 'node:assert/strict';

import { compareAppointments, overrideTargets, type CompareMember, type QcSubmissionLite } from './compare';

/**
 * These two keys are the LIVE values read from production on 2026-09-10 — the
 * department bonus `bonus_mq9yxlmsyj7avdmc` (`=IF(Appts_Set>=10, …)`) and
 * reinelr@'s individual `Lead Gen (COP)` bonus `bonus_mtddp1p5rf4hq1rw`
 * (`=Appts*14000`). Pinned here the way team-rankings.test.ts pins its keys: the
 * code resolves them dynamically from the catalog; this fixture is what tells the
 * next reader what they actually are.
 */
const LEAD_GEN = { bonusId: 'bonus_mq9yxlmsyj7avdmc', varName: 'Appts_Set' };
const LEAD_GEN_COP = { bonusId: 'bonus_mtddp1p5rf4hq1rw', varName: 'Appts' };

/** Members are keyed PERSONAL-first; the paste supplies WORK emails. */
const members: CompareMember[] = [
  { canonical: 'marc.personal@gmail.com', emails: ['marc.personal@gmail.com', 'marcc@simple.biz'], name: 'Cahig, Marc Joseph', workEmail: 'marcc@simple.biz', ...LEAD_GEN },
  { canonical: 'jaysonm@simple.biz', emails: ['jaysonm@simple.biz'], name: 'Mahinay, Jayson', workEmail: 'jaysonm@simple.biz', ...LEAD_GEN },
  { canonical: 'ike.p@gmail.com', emails: ['ike.p@gmail.com', 'iked@simple.biz', 'ike.alt@simple.biz'], name: 'Dispo, Kenneth "Ike"', workEmail: 'iked@simple.biz', ...LEAD_GEN },
  { canonical: 'reinel.p@gmail.com', emails: ['reinel.p@gmail.com', 'reinelr@simple.biz'], name: 'Ruiz, Reinel "Reinel"', workEmail: 'reinelr@simple.biz', ...LEAD_GEN_COP },
  { canonical: 'nobonus@simple.biz', emails: ['nobonus@simple.biz'], name: 'No Bonus', workEmail: 'nobonus@simple.biz', bonusId: null, varName: null },
];

const qc: QcSubmissionLite[] = [
  { employee_email: 'marc.personal@gmail.com', bonus_id: LEAD_GEN.bonusId, vars: { Appts_Set: 32 }, scored_by: 'perryb@simple.biz' },
  { employee_email: 'jaysonm@simple.biz', bonus_id: LEAD_GEN.bonusId, vars: { Appts_Set: 20 }, scored_by: 'Enzy@simple.biz' },
  { employee_email: 'reinel.p@gmail.com', bonus_id: LEAD_GEN_COP.bonusId, vars: { Appts: 7 }, scored_by: 'perryb@simple.biz' },
  // Someone the officers scored whom Jackie will not paste.
  { employee_email: 'ike.p@gmail.com', bonus_id: LEAD_GEN.bonusId, vars: { Appts_Set: 4 }, scored_by: 'sheila@simple.biz' },
];

function by(result: ReturnType<typeof compareAppointments>, canonical: string) {
  return result.entries.find((e) => e.canonical === canonical);
}

test('a WORK email bridges to the PERSONAL-first canonical, and a matching count is a match', () => {
  const r = compareAppointments([{ line: 1, email: 'marcc@simple.biz', displayName: 'Cahig, Marc Joseph', count: 32 }], members, qc);
  const e = by(r, 'marc.personal@gmail.com');
  assert.ok(e);
  assert.equal(e.bucket, 'match');
  assert.equal(e.qc, 32);
  assert.equal(e.pasted, 32);
  assert.equal(e.scoredBy, 'perryb@simple.biz');
  assert.equal(e.varName, 'Appts_Set');
});

test('a differing count is a MISMATCH and names the officer who entered it (lowercased)', () => {
  const r = compareAppointments([{ line: 1, email: 'jaysonm@simple.biz', displayName: 'Mahinay, Jayson', count: 25 }], members, qc);
  const e = by(r, 'jaysonm@simple.biz');
  assert.equal(e?.bucket, 'mismatch');
  assert.equal(e?.qc, 20);
  assert.equal(e?.pasted, 25);
  assert.equal(e?.scoredBy, 'enzy@simple.biz');
});

test('the variable is resolved PER MEMBER — reinelr@ compares on Appts, not Appts_Set', () => {
  const r = compareAppointments([{ line: 1, email: 'reinelr@simple.biz', displayName: 'Ruiz, Reinel', count: 9 }], members, qc);
  const e = by(r, 'reinel.p@gmail.com');
  assert.equal(e?.bucket, 'mismatch');
  assert.equal(e?.varName, 'Appts');
  assert.equal(e?.bonusId, LEAD_GEN_COP.bonusId);
  assert.equal(e?.qc, 7);
});

test('a pasted person with no QC row is PASTE_ONLY; a scored person not in the paste is QC_ONLY', () => {
  const noQc = qc.filter((q) => q.employee_email !== 'marc.personal@gmail.com');
  const r = compareAppointments([{ line: 1, email: 'marcc@simple.biz', displayName: 'Cahig', count: 32 }], members, noQc);
  assert.equal(by(r, 'marc.personal@gmail.com')?.bucket, 'paste_only');
  assert.equal(by(r, 'marc.personal@gmail.com')?.qc, null);
  // Ike was scored (4) but Jackie did not paste him.
  const ike = by(r, 'ike.p@gmail.com');
  assert.equal(ike?.bucket, 'qc_only');
  assert.equal(ike?.pasted, null);
  assert.equal(ike?.qc, 4);
  assert.equal(ike?.scoredBy, 'sheila@simple.biz');
});

test('a QC row whose vars lack the member variable counts as no QC value', () => {
  const wrongKey: QcSubmissionLite[] = [{ employee_email: 'jaysonm@simple.biz', bonus_id: LEAD_GEN.bonusId, vars: { Appts: 20 }, scored_by: 'x@' }];
  const r = compareAppointments([{ line: 1, email: 'jaysonm@simple.biz', displayName: 'J', count: 20 }], members, wrongKey);
  assert.equal(by(r, 'jaysonm@simple.biz')?.bucket, 'paste_only');
});

test('an email matching nobody is refused as UNMATCHED, not created', () => {
  const r = compareAppointments([{ line: 3, email: 'ghost@simple.biz', displayName: 'Ghost', count: 5 }], members, qc);
  assert.equal(r.entries.length - r.counts.qc_only, 0);
  assert.equal(r.refusals.length, 1);
  assert.equal(r.refusals[0]!.kind, 'unmatched');
  assert.equal(r.refusals[0]!.line, 3);
});

test('an email that belongs to TWO people is refused as AMBIGUOUS, never guessed', () => {
  const twoPeople: CompareMember[] = [
    { canonical: 'a@gmail.com', emails: ['a@gmail.com', 'shared@simple.biz'], name: 'A', workEmail: 'shared@simple.biz', ...LEAD_GEN },
    { canonical: 'b@gmail.com', emails: ['b@gmail.com', 'shared@simple.biz'], name: 'B', workEmail: 'shared@simple.biz', ...LEAD_GEN },
  ];
  const r = compareAppointments([{ line: 1, email: 'shared@simple.biz', displayName: 'S', count: 5 }], twoPeople, []);
  assert.equal(r.entries.length, 0);
  assert.equal(r.refusals[0]!.kind, 'ambiguous');
  assert.match(r.refusals[0]!.reason, /2 people/);
});

test('a member with no formula bonus is refused as NO_BONUS, not silently skipped', () => {
  const r = compareAppointments([{ line: 2, email: 'nobonus@simple.biz', displayName: 'N', count: 5 }], members, qc);
  assert.equal(r.refusals[0]!.kind, 'no_bonus');
  assert.equal(r.refusals[0]!.line, 2);
});

test('two pasted emails resolving to the SAME person: the second is a duplicate-PERSON refusal', () => {
  // Ike has a work email and an alternate; both bridge to one canonical.
  const r = compareAppointments(
    [
      { line: 1, email: 'iked@simple.biz', displayName: 'Ike', count: 21 },
      { line: 2, email: 'ike.alt@simple.biz', displayName: 'Ike', count: 22 },
    ],
    members,
    qc,
  );
  assert.equal(r.entries.filter((e) => e.canonical === 'ike.p@gmail.com').length, 1);
  assert.equal(by(r, 'ike.p@gmail.com')?.pasted, 21, 'the first occurrence stands');
  assert.equal(r.refusals[0]!.kind, 'duplicate_person');
  assert.match(r.refusals[0]!.reason, /line 1/);
});

test('matching is case-insensitive on every email', () => {
  const r = compareAppointments([{ line: 1, email: 'MarcC@Simple.BIZ', displayName: 'M', count: 32 }], members, qc);
  assert.equal(by(r, 'marc.personal@gmail.com')?.bucket, 'match');
});

test('counts add up, and overrideTargets is exactly mismatch + paste_only', () => {
  const noMarcQc = qc.filter((q) => q.employee_email !== 'marc.personal@gmail.com');
  const r = compareAppointments(
    [
      { line: 1, email: 'marcc@simple.biz', displayName: 'M', count: 32 },    // paste_only
      { line: 2, email: 'jaysonm@simple.biz', displayName: 'J', count: 25 },  // mismatch (qc 20)
      { line: 3, email: 'reinelr@simple.biz', displayName: 'R', count: 7 },   // match
    ],
    members,
    noMarcQc,
  );
  assert.deepEqual(r.counts, { match: 1, mismatch: 1, paste_only: 1, qc_only: 1 });
  assert.equal(r.entries.length, 4);
  const targets = overrideTargets(r).map((e) => e.canonical).sort();
  assert.deepEqual(targets, ['jaysonm@simple.biz', 'marc.personal@gmail.com']);
});
