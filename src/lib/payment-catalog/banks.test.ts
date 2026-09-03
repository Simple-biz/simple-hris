import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BANK_ALIASES_MAX,
  OFFICIAL_BANKS,
  applyBankPatch,
  bankSpellingKey,
  buildBankEntry,
  foldBankSpellings,
  looksLikePersonName,
  officialBankFor,
  officialKeyFor,
  sanitizeBankEntry,
  unmappedGroupKey,
  validateBankInput,
  type BankRegistryEntry,
  type BankRosterRow,
} from './banks';

const row = (
  bankName: string | null,
  altBankName: string | null = null,
  preferredSlot: 'primary' | 'alternative' = 'primary',
): BankRosterRow => ({ bankName, altBankName, preferredSlot });

// ── The spelling key ─────────────────────────────────────────────────────────

test('bankSpellingKey folds case, punctuation, & vs and, and a TRAILING corporate suffix', () => {
  assert.equal(bankSpellingKey('BDO Unibank, Inc.'), 'bdo unibank');
  assert.equal(bankSpellingKey('Bdo Unibank Inc'), 'bdo unibank');
  assert.equal(bankSpellingKey('BDO UNIBANK'), 'bdo unibank');
  assert.equal(
    bankSpellingKey('Metropolitan Bank & Trust Company'),
    bankSpellingKey('Metropolitan Bank and Trust Co.'),
  );
  assert.equal(bankSpellingKey('  GoTyme   Bank  '), 'gotyme bank');
  assert.equal(bankSpellingKey(null), '');
  assert.equal(bankSpellingKey('   '), '');
});

test('the key NEVER merges distinct institutions — that is what aliases are for', () => {
  // Subsidiaries are separate licensed banks with their own clearing details.
  assert.notEqual(bankSpellingKey('China Bank'), bankSpellingKey('China Bank Savings'));
  assert.notEqual(bankSpellingKey('BDO Unibank'), bankSpellingKey('BDO Network Bank'));
  assert.notEqual(bankSpellingKey('EastWest Bank'), bankSpellingKey('EastWest Rural Bank'));
  assert.notEqual(bankSpellingKey('Union Bank'), bankSpellingKey('UnionDigital Bank'));
  // And it does not strip "Bank", country words or branches on its own.
  assert.equal(bankSpellingKey('CIMB Bank Philippines'), 'cimb bank philippines');
  assert.notEqual(bankSpellingKey('BPI'), bankSpellingKey('Bank of the Philippine Islands'));
});

test('a one-token name is never emptied by suffix stripping', () => {
  assert.equal(bankSpellingKey('Inc'), 'inc');
  assert.equal(bankSpellingKey('Co'), 'co');
});

// ── The declared table ───────────────────────────────────────────────────────

test('every official bank claims its own name, and keys are unique', () => {
  const keys = new Set<string>();
  for (const b of OFFICIAL_BANKS) {
    assert.ok(!keys.has(b.key), `duplicate official key ${b.key}`);
    keys.add(b.key);
    assert.equal(officialKeyFor(b.name), b.key, `${b.name} must claim itself`);
  }
});

test('no spelling is claimed by two different official banks', () => {
  const claimed = new Map<string, string>();
  for (const b of OFFICIAL_BANKS) {
    for (const spelling of [b.name, ...b.aliases]) {
      const k = bankSpellingKey(spelling);
      const prior = claimed.get(k);
      assert.ok(
        prior === undefined || prior === b.key,
        `"${spelling}" is claimed by both ${prior} and ${b.key}`,
      );
      claimed.set(k, b.key);
    }
  }
});

test('the real spellings from the live table fold to the right official bank', () => {
  // Sampled from scripts/audit-bank-spellings.mts against production, 2026-09-03.
  const cases: [string, string][] = [
    ['GoTyme Bank', 'GoTyme Bank'],
    ['GOTYME BANK CORPORATION', 'GoTyme Bank'],
    ['Go Tyme Bank', 'GoTyme Bank'],
    ['GoTymePH', 'GoTyme Bank'],
    ['BPI', 'Bank of the Philippine Islands (BPI)'],
    ['Bank of the Philippine Islands / BPI', 'Bank of the Philippine Islands (BPI)'],
    ['Bank of the Phillipine Islands', 'Bank of the Philippine Islands (BPI)'],
    ['BANK OF THE PHILIPPINE ISLAND- KIDAPAWAN BRANCH', 'Bank of the Philippine Islands (BPI)'],
    ['Bank of the Philippines Islands (BPI)', 'Bank of the Philippine Islands (BPI)'],
    ['Banco de Oro, Unibank, Inc', 'BDO Unibank, Inc.'],
    ['MARI BANK', 'MariBank Philippines, Inc.'],
    ['Maribank Philippines Inc. (A Rural Bank)', 'MariBank Philippines, Inc.'],
    ['Union Bank of the Philippines, Inc.', 'Union Bank of the Philippines'],
    ['Metropolitan and Trust Bank Company', 'Metropolitan Bank & Trust Company (Metrobank)'],
    ['(Gcash) G-Xchange, Inc', 'GCash (G-Xchange, Inc.)'],
    ['Bangko sa Lupa ng Pilipinas (Land Bank of the Philippines)', 'Land Bank of the Philippines'],
    ['Asian United Bank', 'Asia United Bank (AUB)'],
    ['Wise by Column Bank', 'Wise'],
    ['Davivienda', 'Banco Davivienda'],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(officialBankFor(raw), expected, `${raw} → ${expected}`);
  }
});

test('subsidiaries and ambiguous spellings are deliberately NOT claimed by their parent', () => {
  assert.equal(officialBankFor('BDO Network Bank'), 'BDO Network Bank');
  assert.equal(officialBankFor('China Bank Savings'), 'China Bank Savings');
  assert.equal(officialBankFor('BanKo (subsidiary of BPI)'), 'BPI Direct BanKo');
  assert.equal(officialBankFor('UnionDigital Bank'), 'UnionDigital Bank');
  // "Rizal Bank" could be RCBC or Rizal Microbank — guessing is the invented
  // equivalence bank-preferred-routing.md §10.1 forbids. It stays unmapped.
  assert.equal(officialBankFor('Rizal Bank'), null);
  assert.equal(officialBankFor('SSB Bank ("Domestic ACH" or "Direct Deposit")'), null);
  assert.equal(officialBankFor('Some Bank Nobody Declared'), null);
});

// ── Person names in the bank field ───────────────────────────────────────────

test('looksLikePersonName flags the account holder typed into the bank field', () => {
  // All eight of these are real rows (audit, 2026-09-03).
  for (const name of [
    'Richmond Rule Mabagos Aquino',
    'Mark Anthony Padilla',
    'Clarisse Keol',
    'Jonalyn De la Fuente',
    'Ivy Louella Espiritu',
    'Mark Andrew Tandoc De la Cruz',
    'Liam Jesufiel Eleguin',
    'Romerie Joy Villa',
  ]) {
    assert.equal(looksLikePersonName(name), true, `${name} should read as a person`);
  }
});

test('looksLikePersonName never flags a real bank', () => {
  for (const b of OFFICIAL_BANKS) {
    assert.equal(looksLikePersonName(b.name), false, `${b.name} must not read as a person`);
  }
  for (const s of ['Rizal Bank', 'South State Bank', 'Truist', 'FAIRWINDS', 'Davivienda', 'Column Bank']) {
    assert.equal(looksLikePersonName(s), false, `${s} must not read as a person`);
  }
});

// ── Folding ──────────────────────────────────────────────────────────────────

test('fold: spellings of one bank become ONE group, counted on the paid slot', () => {
  const groups = foldBankSpellings([
    row('GoTyme Bank'),
    row('GoTyme'),
    row('GO Tyme Bank'),
    row('BPI'),
  ]);
  const gotyme = groups.find((g) => g.key === 'gotyme')!;
  assert.equal(gotyme.preferredCount, 3);
  assert.equal(gotyme.altCount, 0);
  assert.equal(gotyme.name, 'GoTyme Bank');
  assert.equal(gotyme.official, true);
  assert.deepEqual(gotyme.spellings, ['GO Tyme Bank', 'GoTyme', 'GoTyme Bank']);
  assert.equal(groups.length, 2);
});

test('fold is SLOT-AWARE: the alternative slot is where the money goes when preferred', () => {
  const groups = foldBankSpellings([
    // Paid into the ALT bank — BPI is the one that counts, GoTyme is alt-only.
    row('GoTyme Bank', 'BPI', 'alternative'),
    // Paid into the primary.
    row('GoTyme Bank', 'BPI', 'primary'),
  ]);
  const bpi = groups.find((g) => g.key === 'bpi')!;
  const gotyme = groups.find((g) => g.key === 'gotyme')!;
  assert.equal(bpi.preferredCount, 1);
  assert.equal(bpi.altCount, 1);
  assert.equal(gotyme.preferredCount, 1);
  assert.equal(gotyme.altCount, 1);
});

test('the same bank in both slots counts once, as preferred', () => {
  const groups = foldBankSpellings([row('BPI', 'Bank of the Philippine Islands')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].preferredCount, 1);
  assert.equal(groups[0].altCount, 0);
});

test('blank and whitespace-only bank cells are skipped, never a group', () => {
  const groups = foldBankSpellings([row(null, null), row('   ', ''), row('BPI')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'bpi');
});

test('an unmapped spelling gets its own group, named by its commonest spelling', () => {
  const groups = foldBankSpellings([row('Rizal Bank'), row('rizal bank'), row('Clarisse Keol')]);
  const rizal = groups.find((g) => g.key === unmappedGroupKey('Rizal Bank'))!;
  assert.equal(rizal.official, false);
  assert.equal(rizal.preferredCount, 2);
  assert.equal(rizal.name, 'Rizal Bank');
  assert.equal(rizal.looksLikePerson, false);
  const person = groups.find((g) => g.name === 'Clarisse Keol')!;
  assert.equal(person.looksLikePerson, true);
  assert.equal(person.official, false);
});

test('an unmapped group key can never collide with a declared official key', () => {
  assert.ok(unmappedGroupKey('BPI').startsWith('unmapped:'));
  assert.ok(!OFFICIAL_BANKS.some((b) => b.key.includes(':')));
});

test('groups sort by who is actually paid there, then alt, then name', () => {
  const groups = foldBankSpellings([row('BPI'), row('BPI'), row('GoTyme'), row('Metrobank')]);
  assert.deepEqual(groups.map((g) => g.key), ['bpi', 'gotyme', 'metrobank']);
});

// ── Registry overrides ───────────────────────────────────────────────────────

const entry = (over: Partial<BankRegistryEntry> & { key: string }): BankRegistryEntry => ({
  key: over.key,
  name: over.name ?? '',
  aliases: over.aliases ?? [],
  kind: over.kind ?? 'bank',
  logo: over.logo ?? null,
  notes: over.notes ?? '',
  createdBy: null,
  createdAt: new Date(0).toISOString(),
  updatedBy: null,
  updatedAt: null,
});

test('a registry alias CLAIMS an unmapped spelling into its bank', () => {
  const before = foldBankSpellings([row('Rizal Bank'), row('RCBC')]);
  assert.equal(before.length, 2);
  // Accounting decides "Rizal Bank" is RCBC — a human ruling, recorded, not inferred.
  const after = foldBankSpellings(
    [row('Rizal Bank'), row('RCBC')],
    [entry({ key: 'rcbc', aliases: ['Rizal Bank'] })],
  );
  assert.equal(after.length, 1);
  assert.equal(after[0].key, 'rcbc');
  assert.equal(after[0].preferredCount, 2);
});

test('a registry entry overrides the display name, kind, logo and notes', () => {
  const [g] = foldBankSpellings(
    [row('BPI')],
    [entry({ key: 'bpi', name: 'BPI — payroll', kind: 'wallet', notes: 'ask Lenny' })],
  );
  assert.equal(g.name, 'BPI — payroll');
  assert.equal(g.kind, 'wallet');
  assert.equal(g.notes, 'ask Lenny');
});

test('a blank registry name falls back to the official name, never to empty', () => {
  const [g] = foldBankSpellings([row('BPI')], [entry({ key: 'bpi', name: '   ' })]);
  assert.equal(g.name, 'Bank of the Philippine Islands (BPI)');
});

test('a registry entry for a bank nobody banks with produces no phantom group', () => {
  const groups = foldBankSpellings([row('BPI')], [entry({ key: 'truist', name: 'Truist' })]);
  assert.deepEqual(groups.map((g) => g.key), ['bpi']);
});

// ── Validation ───────────────────────────────────────────────────────────────

test('validateBankInput requires a key that names a LIVE group', () => {
  const live = new Set(['bpi']);
  assert.equal(validateBankInput({ key: 'bpi' }, live).ok, true);
  assert.equal(validateBankInput({ key: 'gotyme' }, live).ok, false);
  assert.equal(validateBankInput({ key: '' }, live).ok, false);
  assert.equal(validateBankInput(null, live).ok, false);
});

test('validateBankInput bounds the text fields and the alias list', () => {
  const live = new Set(['bpi']);
  assert.equal(validateBankInput({ key: 'bpi', name: 'x'.repeat(61) }, live).ok, false);
  assert.equal(validateBankInput({ key: 'bpi', notes: 'n'.repeat(501) }, live).ok, false);
  assert.equal(validateBankInput({ key: 'bpi', kind: 'crypto' }, live).ok, false);
  assert.equal(validateBankInput({ key: 'bpi', aliases: 'BPI' }, live).ok, false);
  assert.equal(
    validateBankInput({ key: 'bpi', aliases: new Array(BANK_ALIASES_MAX + 1).fill('x') }, live).ok,
    false,
  );
  assert.equal(validateBankInput({ key: 'bpi', aliases: ['ok', 'y'.repeat(61)] }, live).ok, false);
});

test('validateBankInput reuses the processor logo contract', () => {
  const live = new Set(['bpi']);
  assert.equal(validateBankInput({ key: 'bpi', logo: { kind: 'public', src: '/wise.png' } }, live).ok, true);
  assert.equal(validateBankInput({ key: 'bpi', logo: { kind: 'public', src: '/hack.png' } }, live).ok, false);
  const png = Buffer.alloc(64, 3).toString('base64');
  assert.equal(
    validateBankInput(
      { key: 'bpi', logo: { kind: 'data', dataUrl: `data:image/png;base64,${png}`, mime: 'image/png', bytes: 64 } },
      live,
    ).ok,
    true,
  );
});

// ── Entry mutations ──────────────────────────────────────────────────────────

test('buildBankEntry / applyBankPatch: key and creation are immutable, aliases dedupe by key', () => {
  const now = '2026-09-03T10:00:00.000Z';
  const created = buildBankEntry(
    { key: 'bpi', name: ' BPI ', aliases: ['Rizal Bank', 'rizal   bank', ' '], notes: ' hi ' },
    'kaner@simple.biz',
    now,
  );
  assert.equal(created.key, 'bpi');
  assert.equal(created.name, 'BPI');
  assert.deepEqual(created.aliases, ['Rizal Bank']); // second spelling has the same key
  assert.equal(created.notes, 'hi');

  const later = '2026-09-04T00:00:00.000Z';
  const patched = applyBankPatch(created, { key: 'bpi', name: 'BPI PH' }, 'lenny@simple.biz', later);
  assert.equal(patched.key, 'bpi');
  assert.equal(patched.createdBy, 'kaner@simple.biz');
  assert.equal(patched.createdAt, now);
  assert.equal(patched.updatedBy, 'lenny@simple.biz');
  assert.deepEqual(patched.aliases, ['Rizal Bank']); // omitted ⇒ kept
  assert.deepEqual(applyBankPatch(created, { key: 'bpi', aliases: [] }, 'a', later).aliases, []);
});

test('sanitizeBankEntry is strict on key, lenient elsewhere, and drops a bad logo not the row', () => {
  assert.equal(sanitizeBankEntry(null), null);
  assert.equal(sanitizeBankEntry({ name: 'no key' }), null);
  const e = sanitizeBankEntry({
    key: 'bpi',
    name: 'x'.repeat(200),
    aliases: ['BPI', 'BPI', 42],
    kind: 'nonsense',
    logo: { kind: 'public', src: '/not-shipped.png' },
    notes: 7,
  })!;
  assert.equal(e.name.length, 60);
  assert.deepEqual(e.aliases, ['BPI']);
  assert.equal(e.kind, 'bank');
  assert.equal(e.logo, null);
  assert.equal(e.notes, '');
});

// ── The payload carries banks, never people ──────────────────────────────────

test('a BankGroup exposes counts and spellings ONLY — no account data, ever', () => {
  // `employee_ids` also holds account_number, swift_code, routing_number, addresses
  // and wallet emails. The route projects three columns into the fold and returns
  // these groups, so there is nothing here to leak even if the payload is logged.
  // If a field is added to BankGroup, this test is the place that argues for it.
  const groups = foldBankSpellings([row('BPI'), row('GoTyme Bank', 'BPI', 'alternative')]);
  const allowed = new Set([
    'key', 'name', 'official', 'kind', 'preferredCount', 'altCount',
    'spellings', 'looksLikePerson', 'logo', 'notes',
  ]);
  for (const g of groups) {
    for (const field of Object.keys(g)) {
      assert.ok(allowed.has(field), `BankGroup gained an unreviewed field: ${field}`);
    }
    const serialized = JSON.stringify(g).toLowerCase();
    for (const forbidden of ['account', 'swift', 'routing_number', 'address', '@']) {
      assert.ok(!serialized.includes(forbidden), `group payload contains "${forbidden}"`);
    }
  }
});

test('the fold never returns a per-person row, whatever the input size', () => {
  const many = new Array(50).fill(null).map(() => row('BPI'));
  const groups = foldBankSpellings(many);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].preferredCount, 50);
});
