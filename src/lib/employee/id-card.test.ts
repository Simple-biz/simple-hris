import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIdCard,
  composeIdCardAddress,
  formatIdCardDate,
  idCardInitials,
  idCardPhotoSources,
  nameFromEmail,
} from './id-card';

/* ── department: no storage key may reach a human ── */

test('an hsl:* storage key is formatted, never printed raw', () => {
  const card = buildIdCard({ department: 'hsl:filing_specialist' });
  assert.equal(card.department, 'HSL — Filing Specialist');
  assert.ok(!card.department!.includes('hsl:'));
});

test('an unknown hsl:* sub-key still never shows the bare slug', () => {
  const card = buildIdCard({ department: 'hsl:brand_new_team' });
  assert.ok(card.department!.startsWith('HSL — '));
  assert.ok(!card.department!.includes('hsl:'));
});

test('a non-HSL department passes through unchanged', () => {
  assert.equal(buildIdCard({ department: 'AI/API Team' }).department, 'AI/API Team');
});

test('a blank department resolves to null so the line is omitted, not printed empty', () => {
  assert.equal(buildIdCard({ department: '   ' }).department, null);
  assert.equal(buildIdCard({}).department, null);
});

/* ── address ── */

test('full_address wins over the flat columns', () => {
  const addr = composeIdCardAddress({
    fullAddress: '28 Katipunan Ave, Quezon City',
    street: 'ignored',
    city: 'ignored',
  });
  assert.equal(addr, '28 Katipunan Ave, Quezon City');
});

test('flat columns join in postal order when full_address is empty', () => {
  const addr = composeIdCardAddress({
    fullAddress: '  ',
    street: '28 Katipunan Ave',
    city: 'Quezon City',
    province: 'Metro Manila',
    postalCode: '1108',
  });
  assert.equal(addr, '28 Katipunan Ave, Quezon City, Metro Manila, 1108');
});

test('a partial address joins only what exists, with no stray separators', () => {
  assert.equal(composeIdCardAddress({ city: 'Cebu City', postalCode: '6000' }), 'Cebu City, 6000');
});

test('no address at all is null, never an empty string', () => {
  assert.equal(composeIdCardAddress({}), null);
  assert.equal(composeIdCardAddress({ street: '', city: null, province: undefined }), null);
});

/* ── start date: must match EmployeeProfile's own formatStartDate ── */

test('a parseable date renders in the same shape Profile uses', () => {
  assert.equal(formatIdCardDate('2024-05-06'), 'May 6, 2024');
});

// Regression guard. `new Date('2024-05-06')` is UTC midnight, so a naive
// toLocaleDateString renders May 5 for every viewer west of UTC. A start date
// that drifts a day on an identity document is not acceptable, so this must go
// through parseDateOnlyLocal. This test fails in any negative-offset timezone if
// someone swaps it back.
test('a DATE-only value does not shift a day in a negative-offset timezone', () => {
  const shown = formatIdCardDate('2024-01-01');
  assert.equal(shown, 'Jan 1, 2024');
  assert.notEqual(shown, 'Dec 31, 2023');
});

test('an unparseable date is passed through verbatim, not blanked', () => {
  assert.equal(formatIdCardDate('sometime in May'), 'sometime in May');
});

test('a blank date is null so the line can read "Not on file"', () => {
  assert.equal(formatIdCardDate(''), null);
  assert.equal(formatIdCardDate(null), null);
  assert.equal(formatIdCardDate(undefined), null);
});

/* ── name ── */

test('the master name wins', () => {
  assert.equal(buildIdCard({ name: 'Maria Elena Santos', workEmail: 'mariaes@simple.biz' }).name, 'Maria Elena Santos');
});

test('a missing name falls back to the email prefix, like the shell does', () => {
  assert.equal(nameFromEmail('maria.santos@simple.biz'), 'Maria Santos');
  assert.equal(buildIdCard({ workEmail: 'mariaes@simple.biz' }).name, 'Mariaes');
});

test('no name and no email still renders a placeholder rather than throwing', () => {
  assert.equal(buildIdCard({}).name, '—');
});

test('the signed-in address is used when the master row has no work email', () => {
  const card = buildIdCard({ fallbackEmail: 'mariaes@simple.biz' });
  assert.equal(card.workEmail, 'mariaes@simple.biz');
});

/* ── serial ── */

test('a blank employee_id hides the serial', () => {
  assert.equal(buildIdCard({ employeeId: '   ' }).employeeId, null);
  assert.equal(buildIdCard({}).employeeId, null);
});

test('an employee_id is carried through verbatim', () => {
  assert.equal(buildIdCard({ employeeId: '2405-0012' }).employeeId, '2405-0012');
});

/* ── initials ── */

test('initials take the first and last word', () => {
  assert.equal(idCardInitials('Maria Elena Santos', null), 'MS');
});

test('a single-word name gives its first two letters', () => {
  assert.equal(idCardInitials('Prince', null), 'PR');
});

test('initials fall back to the email local part', () => {
  assert.equal(idCardInitials(null, 'maria.santos@simple.biz'), 'MS');
});

test('nothing at all still returns something renderable', () => {
  assert.equal(idCardInitials(null, null), '—');
});

/* ── photo ladder ── */

test('a manual upload outranks the Google SSO picture', () => {
  const sources = idCardPhotoSources({
    photoUrl: 'https://supabase/upload.jpg',
    googlePhotoUrl: 'https://google/pic.jpg',
  });
  assert.deepEqual(sources, ['https://supabase/upload.jpg', 'https://google/pic.jpg']);
});

test('with no upload the Google picture leads', () => {
  assert.deepEqual(idCardPhotoSources({ googlePhotoUrl: 'https://google/pic.jpg' }), [
    'https://google/pic.jpg',
  ]);
});

test('no photo anywhere leaves an empty list, which is what selects initials', () => {
  assert.deepEqual(idCardPhotoSources({ photoUrl: '  ', googlePhotoUrl: null }), []);
});

/* ── the whole card survives an empty master row ── */

test('an entirely empty input builds a card instead of throwing', () => {
  const card = buildIdCard({});
  assert.equal(card.name, '—');
  assert.equal(card.workEmail, null);
  assert.equal(card.department, null);
  assert.equal(card.address, null);
  assert.equal(card.startDate, null);
  assert.equal(card.employeeId, null);
  assert.deepEqual(card.photoSources, []);
});
