import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSettlementCurrencyByEmail,
  isNativeSettlement,
  resolveSettlementRate,
  settlementAmountFromPhp,
  type EmailPair,
  type OnboardingCountryRow,
} from './settlement-currency';
import { OFFICIAL_USD_TO_COP_RATE } from '../fx/currency-fx';
import { OFFICIAL_USD_TO_PHP_RATE } from '../fx/usd-php';

// A realistic live pair: ₱61.52/$1 and COP 4,150/$1 → php_per_cop ≈ 0.01482.
const LIVE_PHP = '61.52';
const LIVE_COP = '4150';
const liveRate = resolveSettlementRate(LIVE_PHP, LIVE_COP);

function aliasMap(groups: string[][]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const g of groups) for (const e of g) m.set(e, g);
  return m;
}

// ── The marker: onboarding country only, bridged across every alias ──────────

test('a Colombia submission marks every alias of that human', () => {
  const rows: OnboardingCountryRow[] = [
    { email: 'arturo.personal@gmail.com', invite_personal_email: null, country: 'Colombia' },
  ];
  const aliases = aliasMap([
    ['arturo.personal@gmail.com', 'arturoa@simple.biz', 'arturo.alt@simple.biz'],
  ]);
  const byEmail = buildSettlementCurrencyByEmail(rows, aliases);
  // The work email is the one payroll keys on — the whole point of the bridge.
  assert.equal(byEmail.get('arturoa@simple.biz'), 'COP');
  assert.equal(byEmail.get('arturo.alt@simple.biz'), 'COP');
  assert.equal(byEmail.get('arturo.personal@gmail.com'), 'COP');
});

test('the rate-pair bridge carries a marker to a work email the master row missed', () => {
  const rows: OnboardingCountryRow[] = [
    { email: 'canas.personal@gmail.com', invite_personal_email: null, country: 'Colombia' },
  ];
  // No master alias row for this human at all.
  const pairs: EmailPair[] = [
    { work_email: 'canasm@simple.biz', personal_email: 'canas.personal@gmail.com' },
  ];
  const byEmail = buildSettlementCurrencyByEmail(rows, new Map(), pairs);
  assert.equal(byEmail.get('canasm@simple.biz'), 'COP');
});

test('a submission filed under invite_personal_email still resolves', () => {
  const rows: OnboardingCountryRow[] = [
    { email: null, invite_personal_email: 'reinel@gmail.com', country: 'Colombia' },
  ];
  const byEmail = buildSettlementCurrencyByEmail(rows, aliasMap([['reinel@gmail.com', 'reinelr@simple.biz']]));
  assert.equal(byEmail.get('reinelr@simple.biz'), 'COP');
});

test('country aliases and the "Columbia" misspelling resolve; junk does not', () => {
  const rows: OnboardingCountryRow[] = [
    { email: 'a@x.com', invite_personal_email: null, country: 'Columbia' },
    { email: 'b@x.com', invite_personal_email: null, country: 'USA' },
    { email: 'c@x.com', invite_personal_email: null, country: 'Narnia' },
    { email: 'd@x.com', invite_personal_email: null, country: '' },
  ];
  const byEmail = buildSettlementCurrencyByEmail(rows, new Map());
  assert.equal(byEmail.get('a@x.com'), 'COP');
  assert.equal(byEmail.get('b@x.com'), 'USD');
  assert.equal(byEmail.has('c@x.com'), false, 'an unmapped country marks nobody');
  assert.equal(byEmail.has('d@x.com'), false, 'a blank country marks nobody');
});

test('Philippines resolves to PHP and is not treated as a native settlement', () => {
  const rows: OnboardingCountryRow[] = [
    { email: 'juan@x.com', invite_personal_email: null, country: 'Philippines' },
  ];
  const byEmail = buildSettlementCurrencyByEmail(rows, new Map());
  assert.equal(byEmail.get('juan@x.com'), 'PHP');
  assert.equal(isNativeSettlement('PHP'), false, 'a PHP payee has no second figure to show');
  assert.equal(settlementAmountFromPhp(1200, 'PHP', liveRate), null);
});

test('emails are normalized, so case/whitespace cannot hide a marker', () => {
  const rows: OnboardingCountryRow[] = [
    { email: '  Arturo.Personal@GMAIL.com ', invite_personal_email: null, country: 'Colombia' },
  ];
  const byEmail = buildSettlementCurrencyByEmail(rows, aliasMap([['arturo.personal@gmail.com', 'arturoa@simple.biz']]));
  assert.equal(byEmail.get('arturoa@simple.biz'), 'COP');
});

test('the resolver has no way to read invite_country', () => {
  // Guards the trust rule structurally: a Filipino hire was once INVITED under
  // "Colombia", and honoring that would put a COP figure on her pay. The row
  // type carries no invite_country field, so extra keys are simply inert.
  const rows = [
    { email: 'shanice@x.com', invite_personal_email: null, country: 'Philippines', invite_country: 'Colombia' },
  ] as unknown as OnboardingCountryRow[];
  const byEmail = buildSettlementCurrencyByEmail(rows, new Map());
  assert.equal(byEmail.get('shanice@x.com'), 'PHP', 'the hire-selected country wins outright');
});

// ── FX provenance: the two silent-fabrication classes ────────────────────────

test('a zero or blank rate leg is unset, never a figure', () => {
  for (const [php, cop] of [
    ['0', '4150'],
    ['61.52', '0'],
    ['', '4150'],
    ['61.52', null],
    [null, null],
    ['-5', '4150'],
    ['abc', '4150'],
  ] as Array<[string | null, string | null]>) {
    const rate = resolveSettlementRate(php, cop);
    assert.equal(rate.status, 'unset', `expected unset for php=${php} cop=${cop}`);
    assert.equal(settlementAmountFromPhp(1200, 'COP', rate), null);
  }
});

test('the official placeholder rates are fallback, never a figure', () => {
  // OFFICIAL_USD_TO_COP_RATE (4000) is indistinguishable from a real COP rate
  // and OFFICIAL_USD_TO_PHP_RATE is literally 1 — both must refuse to render.
  const copFallback = resolveSettlementRate(LIVE_PHP, String(OFFICIAL_USD_TO_COP_RATE));
  assert.equal(copFallback.status, 'fallback');
  assert.equal(settlementAmountFromPhp(1200, 'COP', copFallback), null);

  const phpFallback = resolveSettlementRate(String(OFFICIAL_USD_TO_PHP_RATE), LIVE_COP);
  assert.equal(phpFallback.status, 'fallback');
  assert.equal(settlementAmountFromPhp(1200, 'COP', phpFallback), null);
});

test('a live rate converts through the USD anchor and rounds COP to whole pesos', () => {
  assert.equal(liveRate.status, 'live');
  // ₱1,200 ÷ 61.52 = $19.50585… × 4,150 = COP 80,949.28…
  assert.equal(settlementAmountFromPhp(1200, 'COP', liveRate), 80949);
  // USD keeps centavos.
  assert.equal(settlementAmountFromPhp(1200, 'USD', liveRate), 19.51);
});

test('the COP figure is worth ~68x the peso figure — the underpay this prevents', () => {
  // Reading a ₱1,200 bonus AS COP 1,200 (i.e. feeding settlement currency into
  // phpPerUnit) would pay ₱1,200 × 61.52/4150 ≈ ₱17.79. The correct settlement
  // figure is the conversion, and it is ~68x larger than the peso number.
  const cop = settlementAmountFromPhp(1200, 'COP', liveRate)!;
  assert.ok(cop > 1200 * 60, `COP figure ${cop} must dwarf the peso figure, not equal it`);
});

test('a non-finite or zero peso amount is handled without inventing money', () => {
  assert.equal(settlementAmountFromPhp(Number.NaN, 'COP', liveRate), null);
  assert.equal(settlementAmountFromPhp(Number.POSITIVE_INFINITY, 'COP', liveRate), null);
  assert.equal(settlementAmountFromPhp(0, 'COP', liveRate), 0);
});

test('a null marker never produces a native figure', () => {
  assert.equal(isNativeSettlement(null), false);
  assert.equal(isNativeSettlement(undefined), false);
  assert.equal(settlementAmountFromPhp(1200, null, liveRate), null);
});
