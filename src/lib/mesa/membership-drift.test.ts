import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isMesaNeverCharged,
  mesaLedgerSaysSaving,
  mesaMembershipDrift,
  mesaPayrollWillCharge,
  scanMesaMembershipDrift,
  type MesaMembershipFacts,
} from './membership-drift';

// `jimg@simple.biz` and `dales@simple.biz` were MESA members the Payroll Wizard
// had NEVER charged — 0 of 14 staged paystubs each — while Accounting → MESA →
// Active Members showed them saving with a ₱3,600 balance. Their ledger
// identity is an alias (`jim@` / `dale@`); the read path resolves it, the pay
// path does not. Nothing in the app reported the contradiction; it took a
// hand-run probe to find, and only because Kane asked about one man by name.
//
// These tests pin the predicate that makes the disagreement legible, and pin
// that the ALREADY-CLOSED direction (a flag left true after an opt-out) stays
// closed.

const facts = (over: Partial<MesaMembershipFacts> = {}): MesaMembershipFacts => ({
  mesaMember: false,
  ledger: null,
  ...over,
});

/** Saving: deposits on the ledger, no trailing opt-out. */
const saving = (depositCount = 9) => ({ depositCount, lastEventOptedOut: false });

// ── mesaPayrollWillCharge — a restatement of mesa.md:165 ───────────────────

test('charges a flagged member with no trailing opt-out', () => {
  assert.equal(mesaPayrollWillCharge(facts({ mesaMember: true, ledger: saving() })), true);
});

test('charges a freshly flagged member who has no ledger history yet', () => {
  assert.equal(mesaPayrollWillCharge(facts({ mesaMember: true, ledger: null })), true);
});

test('does NOT charge an unflagged person, however much the ledger holds', () => {
  assert.equal(mesaPayrollWillCharge(facts({ mesaMember: false, ledger: saving(72) })), false);
});

test('does NOT charge a flag-drifted ex-member (opt-out suppression)', () => {
  const optedOut = { depositCount: 40, lastEventOptedOut: true };
  assert.equal(mesaPayrollWillCharge(facts({ mesaMember: true, ledger: optedOut })), false);
});

// ── the fail-safe: an unreadable ledger never INVENTS a deduction ──────────

test('an unreadable ledger falls back to flag-only and cannot add a charge', () => {
  // ledger null is what a failed /api/mesa-ledger leaves behind. It must not
  // turn a non-member into a charged one.
  assert.equal(mesaPayrollWillCharge(facts({ mesaMember: false, ledger: null })), false);
  // ...and must not suppress a legitimate one either.
  assert.equal(mesaPayrollWillCharge(facts({ mesaMember: true, ledger: null })), true);
});

// ── mesaLedgerSaysSaving ───────────────────────────────────────────────────

test('contributions prove membership; zero deposits do not', () => {
  assert.equal(mesaLedgerSaysSaving(facts({ ledger: saving(1) })), true);
  assert.equal(mesaLedgerSaysSaving(facts({ ledger: { depositCount: 0, lastEventOptedOut: false } })), false);
  assert.equal(mesaLedgerSaysSaving(facts({ ledger: null })), false);
});

test('a trailing opt-out ends the saving, whatever the deposit count', () => {
  assert.equal(mesaLedgerSaysSaving(facts({ ledger: { depositCount: 72, lastEventOptedOut: true } })), false);
});

// ── the drift itself ───────────────────────────────────────────────────────

test('dales@: 9 deposits on the ledger, flag false — never_charged', () => {
  const dale = facts({ mesaMember: false, ledger: saving(9) });
  assert.equal(mesaMembershipDrift(dale), 'never_charged');
  assert.equal(isMesaNeverCharged(dale), true);
});

test('the repair closes it — the same member, flag stamped, reads none', () => {
  const repaired = facts({ mesaMember: true, ledger: saving(9) });
  assert.equal(mesaMembershipDrift(repaired), 'none');
  assert.equal(isMesaNeverCharged(repaired), false);
});

test('a flag left true after an opt-out is flag_not_cleared, NOT never_charged', () => {
  // The mirror-image drift, already closed by isMesaOptedOut. Pinned so the two
  // directions can never be confused for one another.
  const f = facts({ mesaMember: true, ledger: { depositCount: 40, lastEventOptedOut: true } });
  assert.equal(mesaMembershipDrift(f), 'flag_not_cleared');
  assert.equal(isMesaNeverCharged(f), false);
});

test('a never-joined employee is not a drift', () => {
  assert.equal(mesaMembershipDrift(facts()), 'none');
  assert.equal(mesaMembershipDrift(facts({ ledger: { depositCount: 0, lastEventOptedOut: false } })), 'none');
});

test('an ex-member, unflagged and opted out, is not a drift', () => {
  const f = facts({ mesaMember: false, ledger: { depositCount: 72, lastEventOptedOut: true } });
  assert.equal(mesaMembershipDrift(f), 'none');
});

test('INVARIANT: never_charged ⇔ the ledger says saving and payroll will not charge', () => {
  for (const mesaMember of [true, false]) {
    for (const ledger of [null, saving(0), saving(9), { depositCount: 9, lastEventOptedOut: true }]) {
      const f = facts({ mesaMember, ledger });
      assert.equal(
        isMesaNeverCharged(f),
        mesaLedgerSaysSaving(f) && !mesaPayrollWillCharge(f),
        JSON.stringify({ mesaMember, ledger }),
      );
    }
  }
});

// ── the scan: a failed read is never an all-clear ──────────────────────────

const row = (mesaMember: boolean, depositCount: number) => ({
  mesaMember,
  ledger: { depositCount, lastEventOptedOut: false },
});
const asFacts = (r: ReturnType<typeof row>): MesaMembershipFacts => r;

test('scan finds the drifted rows when the ledger was read', () => {
  const rows = [row(true, 9), row(false, 9), row(false, 0), row(true, 0)];
  const scan = scanMesaMembershipDrift(rows, asFacts, 'ok');
  assert.equal(scan.neverCharged.length, 1);
  assert.equal(scan.neverCharged[0], rows[1]);
  assert.equal(scan.clear, false);
});

test('scan reports a MEASURED all-clear only when the ledger was read', () => {
  const rows = [row(true, 9), row(false, 0)];
  assert.equal(scanMesaMembershipDrift(rows, asFacts, 'ok').clear, true);
});

test('a FAILED ledger read is never reported as clear', () => {
  // The whole point. With the ledger down every row arrives ledger-less, every
  // drift evaluates to none, and a naive count would paint "0 problems" over an
  // unmeasured screen.
  const rows = [row(false, 9), row(false, 9)];
  for (const state of ['failed', 'unknown'] as const) {
    const scan = scanMesaMembershipDrift(rows, asFacts, state);
    assert.equal(scan.clear, false, state);
    assert.equal(scan.neverCharged.length, 0, state);
    assert.equal(scan.ledgerRead, state);
  }
});

test('an empty roster with a good ledger read is clear', () => {
  assert.equal(scanMesaMembershipDrift([], asFacts, 'ok').clear, true);
});
