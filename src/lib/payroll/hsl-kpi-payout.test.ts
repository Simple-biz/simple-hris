import test from 'node:test';
import assert from 'node:assert/strict';
import { addHslKpiBonuses } from './hsl-kpi-payout';

// The 2026-09-08 mispay: HSL KPI was added only for rows whose home department
// resolved to 'hogan_smith_law', dropping external members and duplicate-row
// people. addHslKpiBonuses pays every scored amount — the home dept never enters.

test('adds every scored HSL amount onto the running totals', () => {
  const totals: Record<string, number> = {};
  addHslKpiBonuses(totals, { 'hansc@simple.biz': 250, 'christiane@simple.biz': 2400, 'clarizr@simple.biz': 2500 });
  assert.deepEqual(totals, { 'hansc@simple.biz': 250, 'christiane@simple.biz': 2400, 'clarizr@simple.biz': 2500 });
});

test('sums on top of an existing total (a dual-dept person keeps their other bonus)', () => {
  const totals: Record<string, number> = { 'debbief@simple.biz': 500 };
  addHslKpiBonuses(totals, { 'debbief@simple.biz': 8050 });
  assert.equal(totals['debbief@simple.biz'], 8550);
});

test('skips zero amounts — no spurious ₱0 entry for an unscored row', () => {
  const totals: Record<string, number> = {};
  addHslKpiBonuses(totals, { 'ceasarm@simple.biz': 0, 'joyg@simple.biz': 0 });
  assert.deepEqual(totals, {});
});

test('the home department is irrelevant — nothing in the signature can gate on it', () => {
  // A pure regression pin: the function takes only totals + amounts. If a future
  // edit reintroduces a dept gate it must change this signature, which fails here.
  assert.equal(addHslKpiBonuses.length, 2);
  const totals: Record<string, number> = {};
  const out = addHslKpiBonuses(totals, { 'someone-in-lead-gen@simple.biz': 6100 });
  assert.equal(out['someone-in-lead-gen@simple.biz'], 6100);
  assert.equal(out, totals, 'mutates and returns the same object');
});
