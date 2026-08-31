import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isWiresPreferred,
  isWalletRailLocked,
  isBankPreferredAllowedForReceiving,
  walletFromReceiving,
  mirroredDisbursementFor,
  mirroredBankPreferredFor,
  processorIdFromBankPreferredText,
  processorForBankPreferredLabel,
  bankPreferredLabelForProcessor,
  selectableBankPreferredOptions,
  walletRailEffectiveFromPayload,
  PROCESSOR_OPTIONS,
  BANK_PREFERRED_OPTIONS,
  WALLET_RAILS,
  type ProcessorId,
} from './employee-payment-processors';

// WIRES is the residual: anything that isn't exactly hurupay/higlobe.
test('isWiresPreferred: hurupay and higlobe are NOT wires', () => {
  assert.equal(isWiresPreferred('hurupay'), false);
  assert.equal(isWiresPreferred('higlobe'), false);
});

test('isWiresPreferred: wires/x1153/legacy/null/empty all count as wires', () => {
  assert.equal(isWiresPreferred('wires'), true);
  assert.equal(isWiresPreferred('x1153'), true);
  assert.equal(isWiresPreferred('wise'), true);
  assert.equal(isWiresPreferred('jeeves'), true);
  assert.equal(isWiresPreferred('bpi'), true);
  assert.equal(isWiresPreferred(null), true);
  assert.equal(isWiresPreferred(undefined), true);
  assert.equal(isWiresPreferred(''), true);
});

// The DB's legacy free-text values may be cased/padded — the defensive
// trim+lowercase is load-bearing everywhere a stored value is judged.
test('isWiresPreferred: case- and whitespace-insensitive on legacy free-text', () => {
  assert.equal(isWiresPreferred(' Hurupay '), false);
  assert.equal(isWiresPreferred('HIGLOBE'), false);
  assert.equal(isWiresPreferred(' Wires '), true);
});

// The two predicates answer DIFFERENT questions and must not be collapsed back
// into one: routing still treats an unset person as WIRES (they are paid by
// wire), while the lock does not treat them as locked.
test('isWiresPreferred vs isWalletRailLocked: unset differs, everything else agrees', () => {
  assert.equal(isWiresPreferred(null), true, 'routing: no rail => paid by wire');
  assert.equal(isWalletRailLocked(null), false, 'lock: no rail => still assignable');
  assert.equal(isWiresPreferred(''), true);
  assert.equal(isWalletRailLocked('   '), false);
  for (const v of ['wires', 'x1153', 'wise', 'jeeves', 'bpi']) {
    assert.equal(isWiresPreferred(v), true, v);
    assert.equal(isWalletRailLocked(v), true, v);
  }
  for (const v of ['hurupay', 'higlobe']) {
    assert.equal(isWiresPreferred(v), false, v);
    assert.equal(isWalletRailLocked(v), false, v);
  }
});

// ── The two mirrors (forward 2026-08-24, reverse 2026-08-31 PM) ─────────────
// Only the two wallet rails impose anything, in EITHER direction. Kolan and
// HiGlobe pay INTO the wallet they send from, so send-from and receiving are
// physically the same account; wise/jeeves/wires stay independent.

test('wallet mirror: only Kolan and HiGlobe force the Disbursement channel', () => {
  assert.equal(mirroredDisbursementFor('hurupay'), 'hurupay');
  assert.equal(mirroredDisbursementFor('kolan'), 'hurupay');
  assert.equal(mirroredDisbursementFor('higlobe'), 'higlobe');
});

test('wallet mirror: every other rail leaves Disbursement alone', () => {
  for (const v of ['wise', 'jeeves', 'wires', 'x1153', 'bpi', '', null, undefined]) {
    assert.equal(mirroredDisbursementFor(v), null, String(v));
  }
});

test('reverse mirror: only a wallet RECEIVING pick pins the send-from', () => {
  assert.equal(mirroredBankPreferredFor('hurupay'), 'hurupay');
  assert.equal(mirroredBankPreferredFor('kolan'), 'hurupay');
  assert.equal(mirroredBankPreferredFor('higlobe'), 'higlobe');
  for (const v of ['wise', 'jeeves', 'wires', 'wepay', '', null, undefined]) {
    assert.equal(mirroredBankPreferredFor(v), null, String(v));
  }
});

test('walletFromReceiving: the two wallets, alias- and case-tolerant, nothing else', () => {
  assert.equal(walletFromReceiving('hurupay'), 'hurupay');
  assert.equal(walletFromReceiving(' KOLAN '), 'hurupay');
  assert.equal(walletFromReceiving('higlobe'), 'higlobe');
  for (const v of ['wise', 'jeeves', 'wires', 'wepay', 'x1153', 'bpi', '', null, undefined]) {
    assert.equal(walletFromReceiving(v), null, String(v));
  }
});

// ── THE 1:1 RULE (Kane, 2026-08-31 PM) ──────────────────────────────────────
// The RECEIVING bank drives the send-from rail. This SUPERSEDED the
// stored-transition guard (isBankPreferredTransitionAllowed, removed): the
// verdict is stateless, judged against the live receiving channel on every
// write, so there is no clear-then-set laundering walk left to defend.

test('1:1 rule: a wallet receiver sends from exactly that wallet', () => {
  assert.equal(isBankPreferredAllowedForReceiving('hurupay', 'hurupay'), true);
  assert.equal(isBankPreferredAllowedForReceiving('higlobe', 'higlobe'), true);
  assert.equal(isBankPreferredAllowedForReceiving('kolan', 'hurupay'), true, 'rebrand alias');

  // Not the OTHER wallet, and never a bank rail — "they cannot receive from an
  // x1153 or Wise if they have HiGlobe or Kolan".
  assert.equal(isBankPreferredAllowedForReceiving('hurupay', 'higlobe'), false);
  assert.equal(isBankPreferredAllowedForReceiving('higlobe', 'hurupay'), false);
  assert.equal(isBankPreferredAllowedForReceiving('hurupay', 'wise'), false);
  assert.equal(isBankPreferredAllowedForReceiving('hurupay', 'x1153'), false);
  assert.equal(isBankPreferredAllowedForReceiving('higlobe', 'wires'), false);
  assert.equal(isBankPreferredAllowedForReceiving('higlobe', 'jeeves'), false);
});

// TIGHTER than the old lock in this direction: wallet -> wires used to be an
// allowed transition; under the 1:1 rule a wallet receiver can never be pointed
// at a bank rail without changing the receiving bank in the same save.
test('1:1 rule: wallet -> wires is no longer reachable while receiving stays a wallet', () => {
  assert.equal(isBankPreferredAllowedForReceiving('hurupay', 'wires'), false);
  assert.equal(isBankPreferredAllowedForReceiving('kolan', 'x1153'), false);
});

test('1:1 rule: a bank-rail receiver never sends from a wallet', () => {
  assert.equal(isBankPreferredAllowedForReceiving('wires', 'hurupay'), false);
  assert.equal(isBankPreferredAllowedForReceiving('wires', 'kolan'), false, 'alias too');
  assert.equal(isBankPreferredAllowedForReceiving('wise', 'higlobe'), false);
  assert.equal(isBankPreferredAllowedForReceiving('jeeves', 'hurupay'), false);
  // Bank-to-bank stays free — Accounting corrections between wire rails.
  assert.equal(isBankPreferredAllowedForReceiving('wires', 'wires'), true);
  assert.equal(isBankPreferredAllowedForReceiving('wires', 'x1153'), true);
  assert.equal(isBankPreferredAllowedForReceiving('wise', 'wise'), true);
  assert.equal(isBankPreferredAllowedForReceiving('wise', 'jeeves'), true);
});

// NO receiving channel: anything goes — a wallet send-from assigned here is
// completed into a 1:1 pair by the forward mirror. This carries Kane's
// 2026-08-24 "unassigned means assignable" ruling forward — every new hire.
test('1:1 rule: an unset receiver takes any assignment (mirror completes the pair)', () => {
  for (const recv of [null, undefined, '', '   ']) {
    assert.equal(isBankPreferredAllowedForReceiving(recv, 'hurupay'), true, String(recv));
    assert.equal(isBankPreferredAllowedForReceiving(recv, 'higlobe'), true, String(recv));
    assert.equal(isBankPreferredAllowedForReceiving(recv, 'wires'), true, String(recv));
    assert.equal(isBankPreferredAllowedForReceiving(recv, 'wise'), true, String(recv));
  }
});

// Clearing the send-from is always writable — the verdict is stateless and
// routing falls to the receiving channel, which for a wallet receiver is the
// same wallet anyway. (The old guard blocked clearing to prevent a two-step
// laundering walk; with no stored-transition semantics there is nothing to
// launder.)
test('1:1 rule: clearing is always allowed', () => {
  for (const recv of ['hurupay', 'higlobe', 'wires', 'wise', null]) {
    assert.equal(isBankPreferredAllowedForReceiving(recv, null), true, String(recv));
    assert.equal(isBankPreferredAllowedForReceiving(recv, ''), true, String(recv));
  }
});

// ── The pickers' option lists ────────────────────────────────────────────────

test('options: a wallet receiver sees exactly their wallet, both audiences', () => {
  assert.deepEqual(
    selectableBankPreferredOptions('hurupay', 'employee').map((o) => o.label),
    ['Kolan'],
  );
  assert.deepEqual(
    selectableBankPreferredOptions('kolan', 'accounting').map((o) => o.label),
    ['Kolan'],
  );
  assert.deepEqual(
    selectableBankPreferredOptions('higlobe', 'employee').map((o) => o.label),
    ['HiGlobe'],
  );
});

test('options: a bank-rail receiver gets bank rails only; Wise is Accounting-only', () => {
  // Kane, 2026-08-31 PM: "only accounting can set wise as their sending banks"
  // — set in People -> Banking, never offered to employees as a new pick.
  assert.deepEqual(
    selectableBankPreferredOptions('wires', 'employee').map((o) => o.label),
    ['Jeeves', 'x1153'],
  );
  assert.deepEqual(
    selectableBankPreferredOptions('wise', 'accounting').map((o) => o.label),
    ['Jeeves', 'Wise', 'x1153'],
  );
});

test('options: no receiving channel offers the full list (minus Wise for employees)', () => {
  assert.deepEqual(
    selectableBankPreferredOptions(null, 'accounting').map((o) => o.label),
    ['HiGlobe', 'Kolan', 'Jeeves', 'Wise', 'x1153'],
  );
  assert.deepEqual(
    selectableBankPreferredOptions('', 'employee').map((o) => o.label),
    ['HiGlobe', 'Kolan', 'Jeeves', 'x1153'],
  );
});

// Structural pins: whatever the receiving value, an employee list never offers
// Wise, and a wallet receiver's list never contains anything but their wallet.
test('options: structural — employee lists are Wise-free, wallet lists are pinned', () => {
  const receivings = ['hurupay', 'kolan', 'higlobe', 'wise', 'jeeves', 'wires', '', null];
  for (const recv of receivings) {
    assert.equal(
      selectableBankPreferredOptions(recv, 'employee').some((o) => o.id === 'wise'),
      false,
      `employee list for ${String(recv)}`,
    );
    const wallet = walletFromReceiving(recv);
    if (wallet) {
      for (const audience of ['employee', 'accounting'] as const) {
        assert.deepEqual(
          selectableBankPreferredOptions(recv, audience).map((o) => o.id),
          [wallet],
          `${audience} list for ${String(recv)}`,
        );
      }
    }
  }
});

// ── Kolan rebrand (2026-08-24) ──────────────────────────────────────────────
// Hurupay renamed itself to Kolan. The STORED value stayed `hurupay` on purpose,
// so these pin the things that would otherwise silently misroute money.

// A rates-sheet cell that says "Kolan" must resolve to the SAME rail. Without
// this the person resolves to no processor at all and Payment Dispatch drops
// them from the queue — they simply do not get paid, with no error anywhere.
test('kolan resolves to the hurupay rail (sheet cell after the rebrand)', () => {
  assert.equal(processorIdFromBankPreferredText('kolan'), 'hurupay');
  assert.equal(processorIdFromBankPreferredText(' Kolan '), 'hurupay');
  assert.equal(processorIdFromBankPreferredText('KOLAN'), 'hurupay');
  assert.equal(processorIdFromBankPreferredText('hurupay'), 'hurupay');
  assert.equal(processorIdFromBankPreferredText('huru'), 'hurupay');
  assert.equal(processorIdFromBankPreferredText('huropay'), 'hurupay');
});

// `kolan` is the wallet rail, not the WIRES residual. Reading it as WIRES would
// misclassify a wallet payee's rail everywhere the residual is consulted.
test('isWiresPreferred: kolan is the hurupay wallet, NOT wires', () => {
  assert.equal(isWiresPreferred('kolan'), false);
  assert.equal(isWiresPreferred(' Kolan '), false);
  assert.equal(isWiresPreferred('KOLAN'), false);
});

// Non-widening proof: ONLY `kolan` joined the wallet set. Every other legacy
// free-text spelling stays WIRES — including the typo aliases the TEXT
// normaliser separately accepts (that asymmetry is deliberate: the residual
// must not misread a legacy spelling as a wallet).
test('isWiresPreferred: nothing except kolan was widened', () => {
  assert.equal(isWiresPreferred('huru'), true);
  assert.equal(isWiresPreferred('huropay'), true);
  assert.equal(isWiresPreferred('higloble'), true);
  assert.equal(isWiresPreferred('wise'), true);
  assert.equal(isWiresPreferred('kolanx'), true);
  assert.equal(isWiresPreferred('ko lan'), true);
});

// The label moved; the id did not. That is the whole rebrand in one assertion.
test('registry: hurupay id keeps its value, label reads Kolan', () => {
  const opt = PROCESSOR_OPTIONS.find((p) => p.id === 'hurupay');
  assert.ok(opt);
  assert.equal(opt.label, 'Kolan');
  assert.equal(BANK_PREFERRED_OPTIONS.find((o) => o.id === 'hurupay')?.label, 'Kolan');
  assert.equal(processorForBankPreferredLabel('Kolan'), 'hurupay');
  assert.equal(bankPreferredLabelForProcessor('hurupay'), 'Kolan');
  // x1153 is the wires option's display name, not a distinct processor.
  assert.equal(processorForBankPreferredLabel('x1153'), 'wires');
  assert.equal(bankPreferredLabelForProcessor('wires'), 'x1153');
});

// ── The employee dashboard's display default payload ────────────────────────

test('walletRailEffectiveFromPayload: only a real ProcessorId survives', () => {
  assert.equal(walletRailEffectiveFromPayload({ effectiveRail: 'higlobe' }), 'higlobe');
  assert.equal(walletRailEffectiveFromPayload({ effectiveRail: 'kolan' }), null, 'stored ids only');
  assert.equal(walletRailEffectiveFromPayload({ effectiveRail: null }), null);
  assert.equal(walletRailEffectiveFromPayload({}), null);
  assert.equal(walletRailEffectiveFromPayload(undefined), null);
});

// WALLET_RAILS is the single source for "which rails are wallets" — the 1:1
// rule, both mirrors, and the option pinning all derive from it. If a third
// wallet rail is ever added, every one of them follows automatically.
test('structural: the wallet set is exactly hurupay + higlobe', () => {
  assert.deepEqual([...WALLET_RAILS].sort(), ['higlobe', 'hurupay']);
  const walletIds: ProcessorId[] = [...WALLET_RAILS];
  for (const id of walletIds) {
    assert.equal(mirroredBankPreferredFor(id), id);
    assert.equal(mirroredDisbursementFor(id), id);
    assert.equal(walletFromReceiving(id), id);
  }
});
