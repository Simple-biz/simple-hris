/**
 * Pins the Additions review totals to the money.
 *
 * PAB attaches to the ONE file week containing the PAB period end. Off that
 * week the staged paystub pays ₱0 PAB, so every Additions figure — per-row
 * Final, department footer, header cards, HSL footer — must drop it too. The
 * live 2026-08 shape is the reason: a custom Aug 2 – Aug 29 window closes on
 * the Aug 23–29 file, leaving Aug 30 – Sep 5 owned by August with a FINISHED
 * period, genuine `eligible` verdicts, and a ₱5,000 that dispatch never pays.
 *
 * Run: npx tsx --test src/lib/payroll/additions-pab-gate.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { regatePabInBonusTotals } from './additions-pab-gate';

const PAB = 5000;

test('the payout week passes the month-wide totals through untouched', () => {
  const totals = { 'a@x.biz': 12000, 'b@x.biz': 5000 };
  assert.equal(regatePabInBonusTotals(totals, true, () => PAB), totals);
});

test('off the payout week the PAB term comes out, and nothing else does', () => {
  const totals = { 'a@x.biz': 7000 /* 2000 KPI + 5000 PAB */ };
  const out = regatePabInBonusTotals(totals, false, () => PAB);
  assert.deepEqual(out, { 'a@x.biz': 2000 });
});

test('someone whose PAB was never in the sum is left alone', () => {
  // Toggle off, department not on the PAB allowlist, or accountant-excluded —
  // every one of those makes the mirrored term 0.
  const totals = { 'ineligible@x.biz': 3200 };
  assert.deepEqual(regatePabInBonusTotals(totals, false, () => 0), { 'ineligible@x.biz': 3200 });
});

test('per-department PAB amounts are honoured, not a flat constant', () => {
  const amounts: Record<string, number> = { 'ph@x.biz': 5000, 'hsl@x.biz': 3000 };
  const totals = { 'ph@x.biz': 5000, 'hsl@x.biz': 8000 };
  assert.deepEqual(
    regatePabInBonusTotals(totals, false, (e) => amounts[e] ?? 0),
    { 'ph@x.biz': 0, 'hsl@x.biz': 5000 },
  );
});

test('every key survives the re-gate — a dropped email is a dropped person', () => {
  const totals = { 'a@x.biz': 5000, 'b@x.biz': 0, 'c@x.biz': 1200 };
  const out = regatePabInBonusTotals(totals, false, (e) => (e === 'a@x.biz' ? PAB : 0));
  assert.deepEqual(Object.keys(out).sort(), ['a@x.biz', 'b@x.biz', 'c@x.biz']);
});

test('no clamp: a drifted mirror must show as a wrong number, never be absorbed', () => {
  // If `pabTermFor` ever stops mirroring what `bonusTotals` added, the result
  // goes negative and someone notices. Clamping here would hide it.
  assert.deepEqual(regatePabInBonusTotals({ 'a@x.biz': 1000 }, false, () => PAB), { 'a@x.biz': -4000 });
});
