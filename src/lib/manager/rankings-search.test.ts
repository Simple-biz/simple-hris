import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeRankingQuery,
  rankingRowMatches,
  workEmailIndex,
  workEmailsOf,
} from './rankings-search';

/* Kane, 2026-09-27: "search names and work emails". The team tab's lesson: a search that
 * matches what the board hides makes redaction cosmetic — so never a personal address. */

const ram = {
  name: 'Dacara, Ramil Ordeneza "Ram"',
  personal_email: 'ramil.dacara@gmail.com',
  work_email: 'ramil@simple.biz',
  alternate_work_email: 'ram@simple.biz',
  alternate_work_email_2: null,
};

describe('rankingRowMatches', () => {
  const fields = { name: ram.name, workEmails: workEmailsOf(ram) };

  it('matches the name in any word order, ignoring its punctuation', () => {
    assert.equal(rankingRowMatches(normalizeRankingQuery('  Ram   Dacara '), fields), true);
    assert.equal(rankingRowMatches(normalizeRankingQuery('ordeneza'), fields), true);
  });

  it('matches the work email and its alternates', () => {
    assert.equal(rankingRowMatches(normalizeRankingQuery('ramil@'), fields), true);
    assert.equal(rankingRowMatches(normalizeRankingQuery('RAM@SIMPLE.BIZ'), fields), true);
  });

  it('NEVER matches the personal email', () => {
    assert.equal(rankingRowMatches(normalizeRankingQuery('gmail'), fields), false);
    assert.equal(rankingRowMatches(normalizeRankingQuery('ramil.dacara'), fields), false);
    assert.deepEqual(workEmailsOf(ram), ['ramil@simple.biz', 'ram@simple.biz']);
  });

  it('every word must match; an empty query matches everyone', () => {
    assert.equal(rankingRowMatches(normalizeRankingQuery('ram zzz'), fields), false);
    assert.equal(rankingRowMatches(normalizeRankingQuery(''), fields), true);
  });

  it('a short display name (SP rows) is matched as shown', () => {
    assert.equal(rankingRowMatches('ram d', { name: 'Ram D.', workEmails: [] }), true);
    assert.equal(rankingRowMatches('dacara', { name: 'Ram D.', workEmails: [] }), false);
  });
});

describe('workEmailIndex — SP rows are keyed personal-first', () => {
  it('finds the work emails through ANY address, including the personal key', () => {
    const idx = workEmailIndex([ram]);
    assert.deepEqual(idx.get('ramil.dacara@gmail.com'), ['ramil@simple.biz', 'ram@simple.biz']);
    assert.deepEqual(idx.get('ram@simple.biz'), ['ramil@simple.biz', 'ram@simple.biz']);
  });

  it('a row with no work email contributes nothing to match', () => {
    const idx = workEmailIndex([{ personal_email: 'only@gmail.com', work_email: null }]);
    assert.equal(idx.has('only@gmail.com'), false);
  });
});
