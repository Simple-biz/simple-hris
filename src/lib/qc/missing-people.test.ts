import test from 'node:test';
import assert from 'node:assert/strict';

import { findMissingPeople, type KnownPerson, type TableMember } from './missing-people';
import type { QcSubmissionLite } from './compare';

const VAR = 'Appts_Set';
const B = 'bonus_mq9yxlmsyj7avdmc';

/** On the table: keyed personal-first, with the work email bridging in. */
const members: TableMember[] = [
  { canonical: 'marc.personal@gmail.com', emails: ['marc.personal@gmail.com', 'marcc@simple.biz'] },
];

/** Known people the component resolved, each with its PAY KEY already decided. */
const known: KnownPerson[] = [
  // A leaver whose final pay cycle is this week: keyed on the Hubstaff login.
  { name: 'Mayorca, Richard "Richard"', emails: ['richardma@simple.biz', 'richard.p@gmail.com'], payKey: 'richardma@simple.biz', source: 'offboarded', department: 'lead_gen' },
  // Transferred to HSL after the week: still active, keyed personal-first.
  { name: 'Rondobio, Hannah "Hannah"', emails: ['hannahr@simple.biz', 'hannah.p@gmail.com'], payKey: 'hannah.p@gmail.com', source: 'active', department: 'hsl:intake_specialist' },
  // Two people who somehow share an address — must be refused, never picked.
  { name: 'Twin A', emails: ['shared@simple.biz'], payKey: 'twin.a@gmail.com', source: 'active', department: 'hsl' },
  { name: 'Twin B', emails: ['shared@simple.biz'], payKey: 'twin.b@gmail.com', source: 'active', department: 'hsl' },
];

const qc: QcSubmissionLite[] = [
  // Scored by QC under the personal email; on Jackie's sheet under the work email.
  { employee_email: 'richard.p@gmail.com', employee_name: 'Mayorca, Richard "Richard"', bonus_id: B, vars: { Appts_Set: 1 }, scored_by: 'maui@simple.biz' },
  // Scored by QC, NOT on the sheet.
  { employee_email: 'hannah.p@gmail.com', employee_name: 'Rondobio, Hannah "Hannah"', bonus_id: B, vars: { Appts_Set: 2 }, scored_by: 'joshuadc@simple.biz' },
  // On the table already — Compare's business.
  { employee_email: 'marc.personal@gmail.com', employee_name: 'Cahig, Marc Joseph', bonus_id: B, vars: { Appts_Set: 32 }, scored_by: 'perryb@simple.biz' },
];

test('a sheet line off the table, known as a leaver, is added under the LEAVER pay key with the SHEET count', () => {
  const r = findMissingPeople({
    members,
    pasted: [{ line: 4, email: 'richardma@simple.biz', displayName: 'Mayorca, Richard', count: 3 }],
    qcRows: qc,
    known,
    varName: VAR,
  });
  const richard = r.add.find((a) => a.payKey === 'richardma@simple.biz');
  assert.ok(richard, 'added');
  assert.equal(richard.count, 3, 'the sheet wins over QC (1)');
  assert.equal(richard.countSource, 'sheet');
  assert.equal(richard.line, 4);
  assert.equal(richard.source, 'offboarded');
  assert.equal(richard.scoredBy, 'maui@simple.biz', 'the officer is still carried for the audit row');
});

test('a QC-scored person off the table and NOT on the sheet is added with the QC count under the ACTIVE pay key', () => {
  const r = findMissingPeople({ members, pasted: [], qcRows: qc, known, varName: VAR });
  const hannah = r.add.find((a) => a.payKey === 'hannah.p@gmail.com');
  assert.ok(hannah);
  assert.equal(hannah.count, 2);
  assert.equal(hannah.countSource, 'qc');
  assert.equal(hannah.source, 'active');
  assert.equal(hannah.department, 'hsl:intake_specialist', 'where they are now, for the chip');
  assert.equal(hannah.scoredBy, 'joshuadc@simple.biz');
});

test('someone already on the table is never added, whichever email names them', () => {
  const r = findMissingPeople({
    members,
    pasted: [{ line: 1, email: 'marcc@simple.biz', displayName: 'Cahig, Marc Joseph', count: 32 }],
    qcRows: qc,
    known,
    varName: VAR,
  });
  assert.equal(r.add.find((a) => a.payKey.startsWith('marc')), undefined);
  assert.equal(r.problems.length, 0);
});

test('an email nobody on record holds is a PROBLEM, named, never guessed (Kane: "marked as problems")', () => {
  const r = findMissingPeople({
    members,
    pasted: [{ line: 9, email: 'typo@simple.biz', displayName: 'Typo, Person', count: 2 }],
    qcRows: [],
    known,
    varName: VAR,
  });
  assert.equal(r.add.length, 0);
  assert.equal(r.problems.length, 1);
  const p = r.problems[0]!;
  assert.equal(p.kind, 'not_on_master_list');
  assert.equal(p.line, 9);
  assert.equal(p.email, 'typo@simple.biz');
  assert.match(p.who, /Typo/);
  assert.match(p.reason, /Global Master List/);
});

test('an address two people share is a PROBLEM (ambiguous)', () => {
  const r = findMissingPeople({
    members,
    pasted: [{ line: 2, email: 'shared@simple.biz', displayName: 'Twin', count: 1 }],
    qcRows: [],
    known,
    varName: VAR,
  });
  assert.equal(r.add.length, 0);
  assert.equal(r.problems[0]!.kind, 'ambiguous');
  assert.match(r.problems[0]!.reason, /2 people/);
});

test('QC-scored at ZERO and not on the sheet is skipped and COUNTED, not added', () => {
  const r = findMissingPeople({
    members,
    pasted: [],
    qcRows: [{ employee_email: 'hannah.p@gmail.com', employee_name: 'Rondobio, Hannah', bonus_id: B, vars: { Appts_Set: 0 }, scored_by: 'x@simple.biz' }],
    known,
    varName: VAR,
  });
  assert.equal(r.add.length, 0);
  assert.equal(r.skippedZeroQc, 1);
  assert.equal(r.problems.length, 0);
});

test('a sheet count of ZERO is still added — the sheet lists who was in the department', () => {
  const r = findMissingPeople({
    members,
    pasted: [{ line: 5, email: 'hannahr@simple.biz', displayName: 'Rondobio, Hannah', count: 0 }],
    qcRows: [],
    known,
    varName: VAR,
  });
  assert.equal(r.add.length, 1);
  assert.equal(r.add[0]!.count, 0);
});

test('two sheet lines resolving to the same person: the second is a PROBLEM (duplicate of a PERSON)', () => {
  const r = findMissingPeople({
    members,
    pasted: [
      { line: 1, email: 'hannahr@simple.biz', displayName: 'Rondobio, Hannah', count: 2 },
      { line: 7, email: 'hannah.p@gmail.com', displayName: 'Rondobio, Hannah', count: 2 },
    ],
    qcRows: [],
    known,
    varName: VAR,
  });
  assert.equal(r.add.length, 1);
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0]!.kind, 'duplicate_person');
  assert.match(r.problems[0]!.reason, /same person as line 1/);
});

test('no formula variable ⇒ nothing is added and every off-table person is a PROBLEM that says why', () => {
  const r = findMissingPeople({
    members,
    pasted: [{ line: 1, email: 'hannahr@simple.biz', displayName: 'Rondobio, Hannah', count: 2 }],
    qcRows: qc,
    known,
    varName: null,
  });
  assert.equal(r.add.length, 0);
  assert.ok(r.problems.length >= 2);
  assert.ok(r.problems.every((p) => p.kind === 'no_bonus'));
});

test('a QC row under a different variable is ignored, not a problem', () => {
  const r = findMissingPeople({
    members,
    pasted: [],
    qcRows: [{ employee_email: 'hannah.p@gmail.com', employee_name: 'Rondobio, Hannah', bonus_id: 'cop', vars: { Appts: 7 }, scored_by: 'x@simple.biz' }],
    known,
    varName: VAR,
  });
  assert.equal(r.add.length, 0);
  assert.equal(r.problems.length, 0);
});

test('a known person whose pay key is empty is treated as unknown — the caller must decide the key', () => {
  const r = findMissingPeople({
    members,
    pasted: [{ line: 1, email: 'nokey@simple.biz', displayName: 'No Key', count: 2 }],
    qcRows: [],
    known: [{ name: 'No Key', emails: ['nokey@simple.biz'], payKey: '', source: 'active', department: null }],
    varName: VAR,
  });
  assert.equal(r.add.length, 0);
  assert.equal(r.problems[0]!.kind, 'not_on_master_list');
});
