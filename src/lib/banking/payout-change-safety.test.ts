import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAYOUT_CHANGE_NOTICE_VERSION,
  assessPayoutChange,
  attestationAlertSentences,
  buildPayoutAttestation,
  foldPayoutTrackRecord,
  holderNameVerdict,
  judgePayoutChange,
  looksLikeCardNumber,
  parsePayoutTrack,
  payoutDestinationKey,
  snapshotDestinationKey,
  type PayoutSafetyAnswers,
} from './payout-change-safety';

const ACK: PayoutSafetyAnswers = { payout_notice_ack: PAYOUT_CHANGE_NOTICE_VERSION };

// ── Class 2: a card number typed as an account number ───────────────────────

test('card-shaped: Visa, Mastercard, Amex test numbers, with or without separators', () => {
  assert.equal(looksLikeCardNumber('4111111111111111'), true);
  assert.equal(looksLikeCardNumber('4111 1111 1111 1111'), true);
  assert.equal(looksLikeCardNumber('4111-1111-1111-1111'), true);
  assert.equal(looksLikeCardNumber('5555555555554444'), true);
  assert.equal(looksLikeCardNumber('2223003122003222'), true);
  assert.equal(looksLikeCardNumber('378282246310005'), true);
});

test('card-shaped: ordinary bank account numbers are NOT flagged', () => {
  assert.equal(looksLikeCardNumber('001234567890'), false, '12-digit (BDO / UnionBank / GoTyme length)');
  assert.equal(looksLikeCardNumber('1234567890'), false, '10-digit (BPI / Landbank length)');
  // 13 digits, Visa prefix, Luhn-valid: Metrobank / Security Bank length. Out by length.
  assert.equal(looksLikeCardNumber('4222222222222'), false);
  assert.equal(looksLikeCardNumber('4111111111111112'), false, 'Luhn-invalid');
  assert.equal(looksLikeCardNumber('9111111111111110'), false, 'no card-network prefix');
  assert.equal(looksLikeCardNumber('ABC4111111111111111'), false, 'letters');
  assert.equal(looksLikeCardNumber(null), false);
  assert.equal(looksLikeCardNumber(''), false);
});

// ── Class 3: a spouse's or anyone else's account ────────────────────────────

test('holder: the employee’s own name matches in either name order', () => {
  assert.equal(holderNameVerdict('Loivem Grace Alacre', ['Alacre, Loivem Grace']), 'match');
  assert.equal(holderNameVerdict('ALACRE LOIVEM', ['Loivem Grace Alacre']), 'match');
  assert.equal(holderNameVerdict('Grace Alacre', ['Loivem Grace Alacre']), 'match', 'a middle/short given name counts');
  assert.equal(holderNameVerdict('L. Alacre', ['Loivem Grace Alacre']), 'match', 'an initial counts for a given name');
  assert.equal(holderNameVerdict('José Peña', ['Jose Pena']), 'match', 'accents fold');
});

test('holder: a spouse sharing the surname is a MISMATCH', () => {
  assert.equal(holderNameVerdict('Maria Santos', ['Juan Santos']), 'mismatch');
  // Particles are shared by unrelated families and never count.
  assert.equal(holderNameVerdict('Maria Dela Cruz', ['Juan Dela Cruz']), 'mismatch');
  assert.equal(holderNameVerdict('Maria Dela Cruz', ['Dela Cruz, Juan']), 'mismatch');
});

test('holder: someone else entirely, or another employee, is a MISMATCH', () => {
  // The gracea@ incident (2026-07-24): another employee's account seeded onto her row.
  assert.equal(holderNameVerdict('Evannie Lorraine Manuel Aguilar', ['Alacre, Loivem Grace']), 'mismatch');
});

test('holder: blank holder or no usable own name is UNKNOWN, never a mismatch', () => {
  assert.equal(holderNameVerdict('', ['Juan Santos']), 'unknown');
  assert.equal(holderNameVerdict('Juan Santos', ['']), 'unknown');
  assert.equal(holderNameVerdict('Juan Santos', ['Juan']), 'unknown', 'one token cannot split given/surname');
});

test('holder: any one of the own names matching is enough', () => {
  assert.equal(holderNameVerdict('Maria Reyes', ['Maria Santos', 'Reyes, Maria']), 'match');
});

// ── Where the money goes ────────────────────────────────────────────────────

test('destination: wallet emails compare case-insensitively, accounts by digits', () => {
  assert.deepEqual(snapshotDestinationKey(' Ana@GMAIL.com '), { kind: 'wallet', value: 'ana@gmail.com' });
  assert.deepEqual(snapshotDestinationKey('0012-3456-7890'), { kind: 'account', value: '001234567890' });
  assert.equal(snapshotDestinationKey(''), null);
  assert.equal(snapshotDestinationKey('12'), null);
});

test('destination: rail decides which field is the destination; the PAID slot wins', () => {
  const row = {
    preferred_bank_slot: 'alternative',
    bank_name: 'BPI', account_number: '1111111111',
    alt_bank_name: 'GoTyme', alt_account_number: '222222222222',
    hurupay_email: 'ana@kolan.test', wise_tag: '@ana',
  };
  assert.deepEqual(payoutDestinationKey(row, 'wires'), { kind: 'account', value: '222222222222' });
  assert.deepEqual(payoutDestinationKey(row, 'hurupay'), { kind: 'wallet', value: 'ana@kolan.test' });
  assert.deepEqual(payoutDestinationKey(row, 'wise'), { kind: 'account', value: '222222222222' }, 'Wise with wire details pays the bank');
  assert.deepEqual(
    payoutDestinationKey({ wise_tag: '@ana' }, 'wise'),
    { kind: 'wallet', value: '@ana' },
    'Wise without wire details pays the handle',
  );
  assert.equal(payoutDestinationKey(row, null), null);
});

// ── The track record (and class 6: a failed read is never "0 payments") ─────

test('track record counts only rows to THIS destination', () => {
  const rows = [
    { recipient_account_number: '0012-3456-7890', status: 'paid', sent_date: '2026-08-01' },
    { recipient_account_number: '001234567890', status: 'paid', sent_date: '2026-09-12' },
    { recipient_account_number: '001234567890', status: 'problem', sent_date: '2026-09-19' },
    { recipient_account_number: '999999999999', status: 'paid', sent_date: '2026-07-01' },
    { recipient_account_number: null, status: 'paid', sent_date: '2026-06-01' },
    { recipient_account_number: '001234567890', status: 'threshold', sent_date: '2026-09-26' },
    { recipient_account_number: '001234567890', status: 'paid', sent_date: '2026-09-05', payee_type: 'contractor' },
  ];
  const t = foldPayoutTrackRecord(rows, { kind: 'account', value: '001234567890' });
  assert.deepEqual(t, {
    status: 'ok', destination: 'account', paidCount: 2, problemCount: 1,
    firstPaidOn: '2026-08-01', lastPaidOn: '2026-09-12', lastProblemOn: '2026-09-19',
  });
});

test('track record with no destination says so, and never counts', () => {
  const t = foldPayoutTrackRecord([{ recipient_account_number: '1', status: 'paid', sent_date: null }], null);
  assert.equal(t.status, 'ok');
  assert.equal(t.status === 'ok' && t.destination, 'none');
  assert.equal(t.status === 'ok' && t.paidCount, 0);
});

test('class 6: a payload that is malformed reads as unavailable, an absent one as null — never zero', () => {
  assert.equal(parsePayoutTrack(undefined), null);
  assert.deepEqual(parsePayoutTrack({ status: 'unavailable' }), { status: 'unavailable' });
  assert.deepEqual(parsePayoutTrack({ status: 'ok', destination: 'account' }), { status: 'unavailable' });
  assert.deepEqual(parsePayoutTrack('nope'), { status: 'unavailable' });
  assert.deepEqual(
    parsePayoutTrack({ status: 'ok', destination: 'wallet', paidCount: 3, problemCount: 0, lastPaidOn: '2026-09-26' }),
    { status: 'ok', destination: 'wallet', paidCount: 3, problemCount: 0, firstPaidOn: null, lastPaidOn: '2026-09-26', lastProblemOn: null },
  );
});

// ── Assessing a change ──────────────────────────────────────────────────────

const stored = {
  name: 'Juan Santos',
  preferred_processor: 'wires',
  preferred_bank_slot: 'primary',
  bank_name: 'BPI',
  account_holder_name: 'Juan Santos',
  account_number: '1234567890',
};

test('re-saving identical details is not a change and needs no acknowledgement', () => {
  const a = assessPayoutChange(stored, { ...stored, swift_code: null }, ['Juan Santos']);
  assert.equal(a.changed, false);
  assert.equal(judgePayoutChange(a, {}).ok, true);
});

test('class 1: any change without the acknowledged notice is refused', () => {
  const a = assessPayoutChange(stored, { full_address: 'Cebu City' }, ['Juan Santos']);
  assert.equal(a.changed, true);
  assert.equal(a.destinationChanged, false);
  const v = judgePayoutChange(a, {});
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.code, 'payout_notice_ack_required');
});

test('class 4: a stale page posting an older notice version is refused', () => {
  const a = assessPayoutChange(stored, { account_number: '0987654321' }, ['Juan Santos']);
  const v = judgePayoutChange(a, { payout_notice_ack: '2026-01-01' });
  assert.equal(!v.ok && v.code, 'payout_notice_ack_required');
  assert.equal(judgePayoutChange(a, { payout_notice_ack: true }).ok, false, 'a boolean is not the version');
});

test('an unread stored row ({}) reads as changed: the gate fails toward asking', () => {
  const a = assessPayoutChange({}, { account_number: '1234567890' }, ['Juan Santos']);
  assert.equal(a.changed, true);
  assert.equal(judgePayoutChange(a, {}).ok, false);
});

test('class 2: a NEW card-shaped account number needs its own confirmation', () => {
  const a = assessPayoutChange(stored, { account_number: '4111 1111 1111 1111' }, ['Juan Santos']);
  assert.deepEqual(a.flags, ['card_shaped_account']);
  assert.equal(a.destinationChanged, true);
  const missing = judgePayoutChange(a, ACK);
  assert.equal(!missing.ok && missing.code, 'card_confirm_required');
  assert.equal(judgePayoutChange(a, { ...ACK, confirm_not_card_number: 'true' }).ok, false, 'only literal true');
  assert.equal(judgePayoutChange(a, { ...ACK, confirm_not_card_number: true }).ok, true);
});

test('class 2: a card-shaped number ALREADY on file is not re-flagged on an unrelated edit', () => {
  const onFile = { ...stored, account_number: '4111111111111111' };
  const a = assessPayoutChange(onFile, { ...onFile, full_address: 'Davao' }, ['Juan Santos']);
  assert.deepEqual(a.flags, []);
});

test('class 3: a new holder who is not the employee needs the holder confirmation', () => {
  const a = assessPayoutChange(stored, { account_holder_name: 'Maria Santos', account_number: '5550001112' }, ['Juan Santos']);
  assert.deepEqual(a.flags, ['holder_not_employee']);
  const missing = judgePayoutChange(a, ACK);
  assert.equal(!missing.ok && missing.code, 'holder_confirm_required');
  assert.equal(judgePayoutChange(a, { ...ACK, confirm_holder_is_self: true }).ok, true);
});

test('class 3: the backup (alternative) slot is checked too, and so is the switch onto it', () => {
  const a = assessPayoutChange(
    stored,
    { alt_bank_name: 'GCash', alt_account_holder_name: 'Pedro Reyes', alt_account_number: '09171234567' },
    ['Juan Santos'],
  );
  assert.deepEqual(a.flags, ['holder_not_employee']);
  const withAlt = { ...stored, alt_bank_name: 'GCash', alt_account_holder_name: 'Pedro Reyes', alt_account_number: '09171234567' };
  const sw = assessPayoutChange(withAlt, { preferred_bank_slot: 'alternative' }, ['Juan Santos']);
  assert.deepEqual(sw.flags, ['holder_not_employee']);
  assert.equal(sw.destinationChanged, true);
});

test('class 3: an untouched slot with an odd holder is not re-flagged', () => {
  const odd = { ...stored, alt_bank_name: 'GCash', alt_account_holder_name: 'Pedro Reyes', alt_account_number: '09171234567' };
  const a = assessPayoutChange(odd, { account_number: '5550001112' }, ['Juan Santos']);
  assert.deepEqual(a.flags, []);
});

test('class 3: HiGlobe’s account name is a holder name too', () => {
  const a = assessPayoutChange(
    { name: 'Juan Santos', preferred_processor: 'higlobe' },
    { higlobe_email: 'x@higlobe.test', higlobe_account_name: 'Maria Lopez' },
    ['Juan Santos'],
  );
  assert.deepEqual(a.flags, ['holder_not_employee']);
});

test('moving to a wallet is a destination change even with the bank untouched', () => {
  const a = assessPayoutChange(stored, { preferred_processor: 'hurupay', hurupay_email: 'juan@kolan.test' }, ['Juan Santos']);
  assert.equal(a.destinationChanged, true);
  assert.deepEqual(a.flags, []);
});

// ── Class 5: the attestation on record ──────────────────────────────────────

test('the attestation records version, flags, confirmations and the account being left; never a value', () => {
  const a = assessPayoutChange(stored, { account_holder_name: 'Maria Santos', account_number: '4111111111111111' }, ['Juan Santos']);
  const answers = { ...ACK, confirm_holder_is_self: true, confirm_not_card_number: true };
  assert.equal(judgePayoutChange(a, answers).ok, true);
  const previous = foldPayoutTrackRecord(
    [{ recipient_account_number: '1234567890', status: 'paid', sent_date: '2026-09-26' }],
    { kind: 'account', value: '1234567890' },
  );
  const att = buildPayoutAttestation(a, answers, previous, new Date('2026-10-07T12:00:00Z'));
  assert.deepEqual(att, {
    notice_version: PAYOUT_CHANGE_NOTICE_VERSION,
    attested_at: '2026-10-07T12:00:00.000Z',
    destination_changed: true,
    flags: ['card_shaped_account', 'holder_not_employee'],
    holder_confirmed: true,
    card_confirmed: true,
    previous_account: { paid_count: 1, problem_count: 0, last_paid_on: '2026-09-26' },
  });
  const blob = JSON.stringify(att) + attestationAlertSentences(att).join(' ');
  assert.equal(blob.includes('4111'), false, 'no account digits in the record or the alert');
  assert.equal(blob.includes('Maria'), false, 'no holder name in the record or the alert');
  assert.equal(attestationAlertSentences(att).length, 3);
});

test('an unreadable previous record is null in the attestation, never zero', () => {
  const a = assessPayoutChange(stored, { account_number: '5550001112' }, ['Juan Santos']);
  const att = buildPayoutAttestation(a, ACK, { status: 'unavailable' });
  assert.equal(att.previous_account, null);
  assert.deepEqual(attestationAlertSentences(att), []);
});
