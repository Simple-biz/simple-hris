import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addressLetterSummaryLabel,
  applyLetterFills,
  joinCityProvince,
  letterBlanks,
  pickLetterAddress,
  type RosterAddressParts,
  type SubmissionAddressRow,
} from './address-letter';

const ROSTER: RosterAddressParts = {
  fullAddress: '252 Labesang Aguedo St Brgy 168 Brgy Deparo Caloocan City, Metro Manila 1420',
  street: '252 Labesang Aguedo St',
  city: 'Caloocan',
  province: 'Metro Manila',
  postalCode: '1420',
};

const sub = (over: Partial<SubmissionAddressRow> = {}): SubmissionAddressRow => ({
  createdAt: '2026-08-04T03:00:00Z',
  street: '5 Pasong Balite Marulas',
  city: 'Valenzuela',
  province: 'Metro Manila',
  state: 'Metro Manila',
  postalCode: '1441',
  country: 'Philippines',
  ...over,
});

test('the roster wins, and full_address beats street for the address line (employee-id-card.md:99)', () => {
  const p = pickLetterAddress(ROSTER, [sub()]);
  assert.equal(p.addressSource, 'roster');
  assert.equal(p.address.street, ROSTER.fullAddress);
  assert.equal(p.address.cityProvince, 'Caloocan, Metro Manila');
  assert.equal(p.address.postalCode, '1420');
});

test('a roster row with only a street still counts as the roster address', () => {
  const p = pickLetterAddress({ ...ROSTER, fullAddress: null }, []);
  assert.equal(p.addressSource, 'roster');
  assert.equal(p.address.street, '252 Labesang Aguedo St');
});

test('a roster address NEVER borrows a part from the onboarding form — one source per address', () => {
  const p = pickLetterAddress({ ...ROSTER, postalCode: null }, [sub()]);
  assert.equal(p.addressSource, 'roster');
  assert.equal(p.address.postalCode, null, 'the roster has no postal code, so it stays blank');
  assert.deepEqual(letterBlanks(p.address), ['postalCode']);
});

test('a roster address takes its country from the onboarding form, the only country source', () => {
  const p = pickLetterAddress(ROSTER, [sub({ country: 'PH' })]);
  assert.equal(p.address.country, 'Philippines', 'canonicalised through the onboarding list');
  assert.equal(p.countrySource, 'onboarding');
});

test('a roster address with no form leaves the country blank — never inferred from the address', () => {
  const p = pickLetterAddress(ROSTER, []);
  assert.equal(p.address.country, null);
  assert.equal(p.countrySource, null);
  assert.deepEqual(letterBlanks(p.address), ['country']);
});

test('with no roster address the NEWEST submission carrying a street is used', () => {
  const older = sub({ createdAt: '2025-01-01T00:00:00Z', street: 'Old St', postalCode: '1000' });
  const newer = sub({ createdAt: '2026-09-01T00:00:00Z', street: 'New St', postalCode: '2000' });
  const noStreet = sub({ createdAt: '2026-10-01T00:00:00Z', street: '  ' });
  const p = pickLetterAddress(null, [older, noStreet, newer]);
  assert.equal(p.addressSource, 'onboarding');
  assert.equal(p.address.street, 'New St');
  assert.equal(p.address.postalCode, '2000');
  assert.match(p.addressSourceDetail ?? '', /^Onboarding form, submitted /);
});

test('an onboarding address takes its country from the SAME form, not an older one', () => {
  const older = sub({ createdAt: '2025-01-01T00:00:00Z', country: 'Colombia' });
  const newer = sub({ createdAt: '2026-09-01T00:00:00Z', country: null });
  const p = pickLetterAddress(null, [older, newer]);
  assert.equal(p.address.street, newer.street);
  assert.equal(p.address.country, null);
});

test('a submission falls back to state when it has no province', () => {
  const p = pickLetterAddress(null, [sub({ province: null, state: 'Antioquia', city: 'Medellín', country: 'Colombia' })]);
  assert.equal(p.address.cityProvince, 'Medellín, Antioquia');
  assert.equal(p.address.country, 'Colombia');
});

test('a blank roster address row is not a roster address', () => {
  const p = pickLetterAddress({ fullAddress: ' ', street: null, city: 'Caloocan', province: null, postalCode: '1420' }, [sub()]);
  assert.equal(p.addressSource, 'onboarding', 'a city without a street line is not an address');
});

test('nothing on file ⇒ every field blank, source null', () => {
  const p = pickLetterAddress(null, []);
  assert.equal(p.addressSource, null);
  assert.deepEqual(letterBlanks(p.address), ['street', 'cityProvince', 'postalCode', 'country']);
});

test('joinCityProvince prints a repeated name once and tolerates either half missing', () => {
  assert.equal(joinCityProvince('Makati', 'makati'), 'Makati');
  assert.equal(joinCityProvince('Cebu City', 'Cebu'), 'Cebu City, Cebu');
  assert.equal(joinCityProvince(null, 'Batangas'), 'Batangas');
  assert.equal(joinCityProvince('  ', null), null);
});

const BLANK = { street: null, cityProvince: null, postalCode: null, country: null };

test('the rep may fill every blank field', () => {
  const r = applyLetterFills(BLANK, {
    street: ' 12  Rizal St ',
    cityProvince: 'Lipa, Batangas',
    postalCode: '4217',
    country: 'philippines',
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.address, {
    street: '12 Rizal St',
    cityProvince: 'Lipa, Batangas',
    postalCode: '4217',
    country: 'Philippines',
  });
  assert.deepEqual(r.typed, ['street', 'cityProvince', 'postalCode', 'country']);
});

test('the rep can NOT overwrite an on-file value (termination-docs.md:310)', () => {
  const onFile = { street: 'A St', cityProvince: 'B', postalCode: '1', country: null };
  const r = applyLetterFills(onFile, { street: 'Somewhere else', country: 'Philippines' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /already on file/);
});

test('an on-file address needs no fills at all', () => {
  const onFile = { street: 'A St', cityProvince: 'B', postalCode: '1', country: 'Philippines' };
  const r = applyLetterFills(onFile, undefined);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.typed, []);
});

test('a field left blank after the merge refuses — the letter never prints an empty line', () => {
  const r = applyLetterFills(BLANK, { street: 'A St', cityProvince: 'B', country: 'Philippines', postalCode: '  ' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /Still blank: Postal \/ ZIP code/);
});

test('unknown keys, non-text values, bad countries and bad postal codes are refused', () => {
  assert.equal(applyLetterFills(BLANK, { street: 'A', zip: '1' }).ok, false);
  assert.equal(applyLetterFills(BLANK, { street: 42 }).ok, false);
  assert.equal(applyLetterFills(BLANK, ['x']).ok, false);
  const country = applyLetterFills(BLANK, { street: 'A', cityProvince: 'B', postalCode: '1', country: 'Japan' });
  assert.equal(country.ok, false);
  if (!country.ok) assert.match(country.error, /Country must be one of/);
  const postal = applyLetterFills(BLANK, { street: 'A', cityProvince: 'B', postalCode: '=SUM(A1)', country: 'Philippines' });
  assert.equal(postal.ok, false);
  assert.equal(applyLetterFills(BLANK, { street: 'A\u0007', cityProvince: 'B', postalCode: '1', country: 'Philippines' }).ok, false);
  assert.equal(applyLetterFills(BLANK, { street: 'x'.repeat(201), cityProvince: 'B', postalCode: '1', country: 'Philippines' }).ok, false);
});

test('the queue chip reads city · country', () => {
  assert.equal(
    addressLetterSummaryLabel({ street: 'x', cityProvince: 'Caloocan, Metro Manila', postalCode: '1420', country: 'Philippines' }),
    'Caloocan, Metro Manila · Philippines',
  );
});
