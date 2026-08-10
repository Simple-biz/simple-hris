import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHslTransferEffectiveMap } from './hsl-transfer-effective';

const base = { employee_work_email: null, status: 'applied' };

test('a genuine entry into HSL sets the effective date', () => {
  const m = buildHslTransferEffectiveMap([
    {
      ...base,
      employee_email: 'a@x.com',
      from_department: 'Lead Gen',
      to_department: 'hsl:intake_specialist',
      effective_date: '2026-08-05',
    },
  ]);
  assert.equal(m.get('a@x.com'), '2026-08-05');
});

test('a within-HSL reshuffle does NOT reset the effective date', () => {
  const m = buildHslTransferEffectiveMap([
    {
      ...base,
      employee_email: 'a@x.com',
      from_department: 'Lead Gen',
      to_department: 'HSL',
      effective_date: '2026-01-05',
    },
    {
      ...base,
      employee_email: 'a@x.com',
      from_department: 'HSL',
      to_department: 'hsl:intake_specialist',
      effective_date: '2026-08-05',
    },
    {
      ...base,
      employee_email: 'a@x.com',
      from_department: 'hsl:intake_specialist',
      to_department: 'hsl:collections',
      effective_date: '2026-08-12',
    },
  ]);
  assert.equal(m.get('a@x.com'), '2026-01-05');
});

test('the live case: a plain HSL -> hsl:case_managers relabel leaves no date at all', () => {
  // Five people were relabeled this way on 2026-07-06/07-12 with no prior
  // into-HSL transfer on file (they predate the transfer ledger). Before this
  // fix the relabel date became their "entered HSL" date and day-scoped the
  // +₱15/h weekend premium from it.
  const m = buildHslTransferEffectiveMap([
    {
      ...base,
      employee_email: 'nadinec@simple.biz',
      from_department: 'HSL',
      to_department: 'hsl:case_managers',
      effective_date: '2026-07-06',
    },
  ]);
  assert.equal(m.has('nadinec@simple.biz'), false);
});

test('a re-entry into HSL after leaving still counts', () => {
  const m = buildHslTransferEffectiveMap([
    {
      ...base,
      employee_email: 'a@x.com',
      from_department: 'HSL',
      to_department: 'Lead Gen',
      effective_date: '2026-03-01',
    },
    {
      ...base,
      employee_email: 'a@x.com',
      from_department: 'Lead Gen',
      to_department: 'hsl:collections',
      effective_date: '2026-06-01',
    },
  ]);
  assert.equal(m.get('a@x.com'), '2026-06-01');
});

test('non-applied rows and unparseable dates are still ignored', () => {
  const m = buildHslTransferEffectiveMap([
    {
      ...base,
      status: 'pending',
      employee_email: 'a@x.com',
      from_department: 'Lead Gen',
      to_department: 'HSL',
      effective_date: '2026-08-05',
    },
    {
      ...base,
      employee_email: 'b@x.com',
      from_department: 'Lead Gen',
      to_department: 'HSL',
      effective_date: null,
    },
  ]);
  assert.equal(m.size, 0);
});
