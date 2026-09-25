import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MATCH_RANK, isMissingBankInfo, matchRank, searchPeopleByNameOrEmail } from './bank-search';

describe('isMissingBankInfo', () => {
  it('flags a payee with no complete payout details', () => {
    assert.equal(isMissingBankInfo({ hasBanking: false, department: 'Lead Gen' }), true);
    assert.equal(isMissingBankInfo({ hasBanking: false, department: null }), true);
  });
  it('never flags someone who is payable', () => {
    assert.equal(isMissingBankInfo({ hasBanking: true, department: 'Lead Gen' }), false);
  });
  it('exempts USEE (paid through a separate channel), whatever the casing or padding', () => {
    assert.equal(isMissingBankInfo({ hasBanking: false, department: 'USEE' }), false);
    assert.equal(isMissingBankInfo({ hasBanking: false, department: ' usee ' }), false);
  });
});

const person = (name: string | null, work_email: string | null, personal_email: string | null = null) => ({
  name,
  work_email,
  personal_email,
});

describe('matchRank', () => {
  it('ranks name prefix < word prefix < name contains < work email', () => {
    assert.equal(matchRank(person('Cargo, James', 'x@simple.biz'), 'car'), MATCH_RANK.namePrefix);
    assert.equal(matchRank(person('Cargo, James', 'x@simple.biz'), 'jam'), MATCH_RANK.wordPrefix);
    assert.equal(matchRank(person('Cargo, James', 'x@simple.biz'), 'ames'), MATCH_RANK.nameContains);
    assert.equal(matchRank(person('Cargo, James', 'jc@simple.biz'), 'jc@'), MATCH_RANK.workEmail);
  });

  it('treats quotes and commas as word breaks (surname-first roster names)', () => {
    assert.equal(matchRank(person('Cargo, James Adrian "James"', null), 'adrian'), MATCH_RANK.wordPrefix);
    assert.equal(matchRank(person('Morales, Angelyne "Ang"', null), 'ang'), MATCH_RANK.wordPrefix);
  });

  it('is case-insensitive on both name and email', () => {
    assert.equal(matchRank(person('SANTOS, Maria', 'MariaS@Simple.biz'), 'santos'), MATCH_RANK.namePrefix);
    assert.equal(matchRank(person(null, 'MariaS@Simple.biz'), 'marias@'), MATCH_RANK.workEmail);
  });

  it('never matches a personal email', () => {
    assert.equal(matchRank(person('Reyes, Ana', 'anar@simple.biz', 'zzz.personal@gmail.com'), 'zzz'), null);
  });

  it('returns null for an empty query and for a row with no name or email', () => {
    assert.equal(matchRank(person('Reyes, Ana', 'anar@simple.biz'), ''), null);
    assert.equal(matchRank(person(null, null), 'a'), null);
  });
});

describe('searchPeopleByNameOrEmail', () => {
  it('returns [] for a blank or whitespace query', () => {
    const rows = [person('Reyes, Ana', 'anar@simple.biz')];
    assert.deepEqual(searchPeopleByNameOrEmail(rows, ''), []);
    assert.deepEqual(searchPeopleByNameOrEmail(rows, '   '), []);
  });

  it('orders by rank, then A→Z within a rank', () => {
    const rows = [
      person('Zamora, Ana', 'zana@simple.biz'), // "ana" word prefix
      person('Anaya, Bea', 'bea@simple.biz'), // "ana" name prefix
      person('Banana, Cy', 'cy@simple.biz'), // "ana" contains
      person('Dela Cruz, Ana', 'dana@simple.biz'), // "ana" word prefix
      person('Lopez, Rey', 'anaflores@simple.biz'), // work email only
    ];
    assert.deepEqual(
      searchPeopleByNameOrEmail(rows, 'ana').map((r) => r.name),
      ['Anaya, Bea', 'Dela Cruz, Ana', 'Zamora, Ana', 'Banana, Cy', 'Lopez, Rey'],
    );
  });

  it('trims the query and never caps the result', () => {
    const rows = Array.from({ length: 75 }, (_, i) => person(`Maria ${String(i).padStart(2, '0')}`, `m${i}@simple.biz`));
    assert.equal(searchPeopleByNameOrEmail(rows, '  maria ').length, 75);
  });

  it('keeps every row of a duplicated name (never dedupes people)', () => {
    const rows = [person('Cruz, Jo', 'jo1@simple.biz'), person('Cruz, Jo', 'jo2@simple.biz')];
    assert.equal(searchPeopleByNameOrEmail(rows, 'cruz').length, 2);
  });
});
