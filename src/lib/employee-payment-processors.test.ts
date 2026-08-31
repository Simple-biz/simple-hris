import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isWiresPreferred,
  isWalletRailLocked,
  isBankPreferredTransitionAllowed,
  mirroredDisbursementFor,
  processorIdFromBankPreferredText,
  processorForBankPreferredLabel,
  bankPreferredLabelForProcessor,
  PROCESSOR_OPTIONS,
  BANK_PREFERRED_OPTIONS,
  WALLET_RAILS,
  selectableBankPreferredOptions,
  walletRailLockedFromPayload,
  walletRailEffectiveFromPayload,
  walletRailLockedForResolvedRail,
  type ProcessorId,
} from './employee-payment-processors';
import { resolveEffectivePayoutProcessor } from './employee/payout-completeness';

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
// trim+lowercase is load-bearing for the guard's `current` side.
test('isWiresPreferred: case- and whitespace-insensitive on legacy free-text', () => {
  assert.equal(isWiresPreferred(' Hurupay '), false);
  assert.equal(isWiresPreferred('HIGLOBE'), false);
  assert.equal(isWiresPreferred(' Wires '), true);
  assert.equal(isBankPreferredTransitionAllowed(' HURUPAY ', 'higlobe'), true);
  assert.equal(isBankPreferredTransitionAllowed(' Wires ', 'hurupay'), false);
});

// The ONLY forbidden transition: a WIRES employee → hurupay/higlobe.
test('transition: wires -> hurupay/higlobe is forbidden', () => {
  assert.equal(isBankPreferredTransitionAllowed('wires', 'hurupay'), false);
  assert.equal(isBankPreferredTransitionAllowed('wires', 'higlobe'), false);
});

// CHANGED 2026-08-24 (Kane's ruling, deliberate — not a loosened assertion).
// LEGACY free-text and explicit wire accounts are still locked. UNSET is not:
// never having been assigned a rail is not the same as having been put on
// wires, and treating it as a lockout meant a new hire could never be placed on
// a wallet at all. See isWalletRailLocked.
test('transition: an EXPLICIT wire rail -> hurupay/higlobe is forbidden', () => {
  assert.equal(isBankPreferredTransitionAllowed('x1153', 'hurupay'), false);
  assert.equal(isBankPreferredTransitionAllowed('x1161', 'higlobe'), false);
  assert.equal(isBankPreferredTransitionAllowed('bpi', 'hurupay'), false);
  assert.equal(isBankPreferredTransitionAllowed('wise', 'hurupay'), false);
  // The rebranded spelling is locked out from wires exactly like the old one.
  assert.equal(isBankPreferredTransitionAllowed('x1153', 'kolan'), false);
});

test('transition: an UNSET person can be assigned a wallet rail', () => {
  assert.equal(isBankPreferredTransitionAllowed(null, 'hurupay'), true);
  assert.equal(isBankPreferredTransitionAllowed(undefined, 'higlobe'), true);
  assert.equal(isBankPreferredTransitionAllowed('', 'kolan'), true);
  assert.equal(isBankPreferredTransitionAllowed('   ', 'hurupay'), true);
});

// The two predicates answer DIFFERENT questions and must not be collapsed back
// into one: routing still treats an unset person as WIRES (they are paid by
// wire), while the lock does not treat them as locked.
test('isWiresPreferred vs isWalletRailLocked: unset differs, everything else agrees', () => {
  assert.equal(isWiresPreferred(null), true, 'routing: no rail => paid by wire');
  assert.equal(isWalletRailLocked(null), false, 'lock: no rail => still assignable');
  assert.equal(isWiresPreferred(''), true);
  assert.equal(isWalletRailLocked('   '), false);
  for (const v of ['wires', 'x1153', 'x1161', 'bpi', 'wise', 'jeeves']) {
    assert.equal(isWiresPreferred(v), true, v);
    assert.equal(isWalletRailLocked(v), true, v);
  }
  for (const v of ['hurupay', 'kolan', 'higlobe', ' Kolan ']) {
    assert.equal(isWiresPreferred(v), false, v);
    assert.equal(isWalletRailLocked(v), false, v);
  }
});

// Only the two wallet rails impose a Disbursement channel. This is the whole
// of Kane's 2026-08-24 mirror rule.
test('wallet mirror: only Kolan and HiGlobe force the Disbursement channel', () => {
  assert.equal(mirroredDisbursementFor('hurupay'), 'hurupay');
  assert.equal(mirroredDisbursementFor('kolan'), 'hurupay');
  assert.equal(mirroredDisbursementFor(' KOLAN '), 'hurupay');
  assert.equal(mirroredDisbursementFor('higlobe'), 'higlobe');
});

test('wallet mirror: every other rail leaves Disbursement alone', () => {
  for (const v of ['wise', 'jeeves', 'wires', 'x1153', 'x1161', 'bpi', '', null, undefined]) {
    assert.equal(mirroredDisbursementFor(v), null, String(v));
  }
});

test('transition: wires -> wires and null -> wires are allowed', () => {
  assert.equal(isBankPreferredTransitionAllowed('wires', 'wires'), true);
  assert.equal(isBankPreferredTransitionAllowed(null, 'wires'), true);
  assert.equal(isBankPreferredTransitionAllowed('x1153', 'wires'), true);
});

test('transition: hurupay/higlobe can move freely (incl. to wires)', () => {
  assert.equal(isBankPreferredTransitionAllowed('hurupay', 'higlobe'), true);
  assert.equal(isBankPreferredTransitionAllowed('higlobe', 'hurupay'), true);
  assert.equal(isBankPreferredTransitionAllowed('hurupay', 'wires'), true);
  assert.equal(isBankPreferredTransitionAllowed('higlobe', 'wires'), true);
  assert.equal(isBankPreferredTransitionAllowed('hurupay', 'hurupay'), true);
});

// ── Kolan rebrand (2026-08-24) ──────────────────────────────────────────────
// Hurupay renamed itself to Kolan. The STORED value stayed `hurupay` on purpose,
// so these pin the two things that would otherwise silently misroute money.

// A rates-sheet cell that says "Kolan" must resolve to the SAME rail. Without
// this the person resolves to no processor at all and Payment Dispatch drops
// them from the queue — they simply do not get paid, with no error anywhere.
test('kolan resolves to the hurupay rail (sheet cell after the rebrand)', () => {
  assert.equal(processorIdFromBankPreferredText('kolan'), 'hurupay');
  assert.equal(processorIdFromBankPreferredText('Kolan'), 'hurupay');
  assert.equal(processorIdFromBankPreferredText(' KOLAN '), 'hurupay');
  // …and every pre-rebrand spelling keeps resolving exactly as before.
  assert.equal(processorIdFromBankPreferredText('hurupay'), 'hurupay');
  assert.equal(processorIdFromBankPreferredText('huru'), 'hurupay');
  assert.equal(processorIdFromBankPreferredText('huropay'), 'hurupay');
});

// `kolan` is the wallet rail, not the WIRES residual. Reading it as WIRES would
// permanently lock a wallet payee out of their own rail via the transition guard.
test('isWiresPreferred: kolan is the hurupay wallet, NOT wires', () => {
  assert.equal(isWiresPreferred('kolan'), false);
  assert.equal(isWiresPreferred(' Kolan '), false);
  assert.equal(isWiresPreferred('KOLAN'), false);
});

test('transition: kolan behaves exactly as hurupay on both sides of the guard', () => {
  assert.equal(isBankPreferredTransitionAllowed('kolan', 'higlobe'), true);
  assert.equal(isBankPreferredTransitionAllowed('kolan', 'wires'), true);
  assert.equal(isBankPreferredTransitionAllowed('higlobe', 'kolan'), true);
  // A payee EXPLICITLY on wires still cannot be moved onto the wallet,
  // whichever name the wallet happens to be called by.
  assert.equal(isBankPreferredTransitionAllowed('wires', 'kolan'), false);
  assert.equal(isBankPreferredTransitionAllowed('x1153', 'kolan'), false);
  // An UNSET person is assignable as of 2026-08-24 — see the isWalletRailLocked
  // tests below. This assertion was `false` until that ruling.
  assert.equal(isBankPreferredTransitionAllowed(null, 'kolan'), true);
});

// Non-loosening proof: ONLY `kolan` joined the wallet set. Every other legacy
// free-text spelling stays WIRES exactly as bank-preferred-routing.md §4
// requires — including the typo aliases the TEXT normaliser separately accepts.
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
  assert.ok(opt, 'hurupay must remain a processor id');
  assert.equal(opt.label, 'Kolan');
  assert.equal(BANK_PREFERRED_OPTIONS.find((o) => o.id === 'hurupay')?.label, 'Kolan');
  // Label <-> id round trip stays closed after the rename.
  assert.equal(processorForBankPreferredLabel('Kolan'), 'hurupay');
  assert.equal(bankPreferredLabelForProcessor('hurupay'), 'Kolan');
});

// Unset became assignable (2026-08-24), which opens a two-step laundering path
// unless clearing is blocked for a locked payee. This is the proof it is closed.
test('lock laundering: an explicitly-wires payee cannot be CLEARED to unset', () => {
  assert.equal(isBankPreferredTransitionAllowed('wires', null), false);
  assert.equal(isBankPreferredTransitionAllowed('wires', ''), false);
  assert.equal(isBankPreferredTransitionAllowed('wires', '   '), false);
  assert.equal(isBankPreferredTransitionAllowed('x1153', null), false);
  assert.equal(isBankPreferredTransitionAllowed('bpi', ''), false);
  // …so the full two-step walk is dead at step one.
  assert.equal(isBankPreferredTransitionAllowed('wires', null), false, 'step 1: clear');
  assert.equal(isBankPreferredTransitionAllowed('wires', 'kolan'), false, 'direct move');
});

// Clearing a WALLET rail launders nothing — unset was already assignable to a
// wallet — so it stays allowed and Accounting keeps that escape hatch.
test('lock laundering: clearing a WALLET rail is still allowed', () => {
  assert.equal(isBankPreferredTransitionAllowed('hurupay', null), true);
  assert.equal(isBankPreferredTransitionAllowed('kolan', ''), true);
  assert.equal(isBankPreferredTransitionAllowed('higlobe', null), true);
  // And an already-unset person can stay unset.
  assert.equal(isBankPreferredTransitionAllowed(null, null), true);
});

// A locked payee can still be moved BETWEEN wire rails — the guard blocks
// escapes, not ordinary wire-account corrections.
test('lock laundering: wire-to-wire moves are unaffected', () => {
  assert.equal(isBankPreferredTransitionAllowed('wires', 'x1153'), true);
  assert.equal(isBankPreferredTransitionAllowed('x1153', 'x1161'), true);
  assert.equal(isBankPreferredTransitionAllowed('bpi', 'wires'), true);
});

// ---------------------------------------------------------------------------
// The Employee Profile dropdown's option list (2026-08-31)
//
// The dropdown used to judge the lock from `employee_ids.bank_preferred` alone
// and treat NULL as locked. Tier 1 is NULL for 1,796 of 1,926 people, 920 of
// whom route to a wallet via tier 2 — so the rail they are actually paid on was
// missing from their own dropdown. The verdict now comes from the EFFECTIVE
// rail (resolveWalletRailLock, server-side, fail-closed) and these pin the two
// halves of that: what a locked list may contain, and how a client must read a
// lock payload it does not fully trust.
// ---------------------------------------------------------------------------

test('selectableBankPreferredOptions: locked withholds BOTH wallet rails', () => {
  const locked = selectableBankPreferredOptions(true);
  assert.equal(
    locked.some((o) => (WALLET_RAILS as readonly ProcessorId[]).includes(o.id)),
    false,
    'a locked list must never contain a wallet rail',
  );
  // Stated positively too, so widening WALLET_RAILS alone cannot pass this.
  assert.deepEqual(
    locked.map((o) => o.label),
    ['Jeeves', 'Wise', 'x1153'],
  );
});

test('selectableBankPreferredOptions: unlocked offers the full list', () => {
  const open = selectableBankPreferredOptions(false);
  assert.deepEqual(open, BANK_PREFERRED_OPTIONS);
  assert.deepEqual(
    open.map((o) => o.label),
    ['HiGlobe', 'Kolan', 'Jeeves', 'Wise', 'x1153'],
  );
});

// The whole point of the change: someone whose EFFECTIVE rail is a wallet sees
// the wallet rails, even though their tier 1 is NULL.
test('selectableBankPreferredOptions: a tier-2 wallet payee sees Kolan and HiGlobe', () => {
  const effective = resolveEffectivePayoutProcessor({
    bank_preferred: null,
    preferred_processor: 'hurupay',
  });
  assert.equal(effective, 'hurupay');
  const labels = selectableBankPreferredOptions(isWalletRailLocked(effective)).map((o) => o.label);
  assert.ok(labels.includes('Kolan'));
  assert.ok(labels.includes('HiGlobe'));
});

// ...and someone explicitly on wires via the LEGACY CELL still does not — the
// population a tier-1-only read would have wrongly unlocked.
test('selectableBankPreferredOptions: a legacy-cell wires payee stays locked', () => {
  const effective = resolveEffectivePayoutProcessor(
    { bank_preferred: null, preferred_processor: null },
    { bankPreferredRaw: 'x1153' },
  );
  const labels = selectableBankPreferredOptions(isWalletRailLocked(effective)).map((o) => o.label);
  assert.equal(labels.includes('Kolan'), false);
  assert.equal(labels.includes('HiGlobe'), false);
});

test('walletRailLockedFromPayload: fails CLOSED on anything but an explicit clean unlock', () => {
  // The only shape that unlocks.
  assert.equal(walletRailLockedFromPayload({ locked: false, effectiveRail: 'hurupay', error: null }), false);

  assert.equal(walletRailLockedFromPayload(undefined), true, 'payload absent (list branch)');
  assert.equal(walletRailLockedFromPayload(null), true);
  assert.equal(walletRailLockedFromPayload({}), true, 'no `locked` key at all');
  assert.equal(walletRailLockedFromPayload({ locked: true }), true);
  assert.equal(walletRailLockedFromPayload('false'), true, 'not an object');
  assert.equal(walletRailLockedFromPayload({ locked: 'false' }), true, 'string is not false');
  assert.equal(walletRailLockedFromPayload({ locked: 0 }), true, 'falsy is not false');
  assert.equal(
    walletRailLockedFromPayload({ locked: false, error: 'read failed' }),
    true,
    'a read error outranks an unlocked verdict',
  );
});

test('walletRailEffectiveFromPayload: only a real ProcessorId survives', () => {
  assert.equal(walletRailEffectiveFromPayload({ effectiveRail: 'higlobe' }), 'higlobe');
  assert.equal(walletRailEffectiveFromPayload({ effectiveRail: 'kolan' }), null, 'stored ids only');
  assert.equal(walletRailEffectiveFromPayload({ effectiveRail: null }), null);
  assert.equal(walletRailEffectiveFromPayload({}), null);
  assert.equal(walletRailEffectiveFromPayload(undefined), null);
});

// People → Banking holds a server-resolved effective rail, not a lock payload,
// and `banking === null` there conflates "read failed" with "no rail anywhere".
// Those need opposite verdicts, so the resolved flag carries the difference.
test('walletRailLockedForResolvedRail: an UNRESOLVED read is locked, whatever the rail says', () => {
  assert.equal(walletRailLockedForResolvedRail(false, null), true, 'fetch failed / not landed');
  assert.equal(walletRailLockedForResolvedRail(false, 'hurupay'), true, 'stale wallet rail');
  assert.equal(walletRailLockedForResolvedRail(false, undefined), true);
});

test('walletRailLockedForResolvedRail: a RESOLVED read keeps the 2026-08-24 ruling', () => {
  // No rail in any tier, and we know it — assignable. Covers every new hire.
  assert.equal(walletRailLockedForResolvedRail(true, null), false);
  assert.equal(walletRailLockedForResolvedRail(true, ''), false);
  // Already on a wallet — assignable between wallets.
  assert.equal(walletRailLockedForResolvedRail(true, 'hurupay'), false);
  assert.equal(walletRailLockedForResolvedRail(true, 'higlobe'), false);
  // Explicitly on a non-wallet rail — locked, Wise and Jeeves included.
  assert.equal(walletRailLockedForResolvedRail(true, 'wires'), true);
  assert.equal(walletRailLockedForResolvedRail(true, 'x1153'), true);
  assert.equal(walletRailLockedForResolvedRail(true, 'wise'), true);
  assert.equal(walletRailLockedForResolvedRail(true, 'jeeves'), true);
});

// The regression this closed: a null payload used to reach isWalletRailLocked
// directly, which unlocked the picker AND the laundering "Not set" option.
test('walletRailLockedForResolvedRail: unresolved is stricter than the raw predicate', () => {
  assert.equal(isWalletRailLocked(null), false, 'the raw predicate says assignable');
  assert.equal(walletRailLockedForResolvedRail(false, null), true, 'the UI must not');
});
