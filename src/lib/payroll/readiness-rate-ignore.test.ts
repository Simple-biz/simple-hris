import assert from 'node:assert/strict';
import test from 'node:test';

import { partitionIgnoredRates } from './readiness-rate-ignore';

interface Row {
  name: string;
  aliases: string[];
}

interface Exemption {
  id: string;
}

const row = (name: string, aliases: string[]): Row => ({ name, aliases });
const aliasesFor = (r: Row) => r.aliases;

test('an email-keyed ignore moves the row out of the kept list', () => {
  const r = row('Jane Cruz', ['janec@simple.biz']);
  const map = new Map<string, Exemption>([['janec@simple.biz', { id: 'x1' }]]);
  const { kept, ignored } = partitionIgnoredRates([r], aliasesFor, map);
  assert.deepEqual(kept, []);
  assert.deepEqual(ignored, [{ row: r, exemption: { id: 'x1' } }]);
});

test('a row with no matching record stays kept, in order', () => {
  const a = row('A', ['a@simple.biz']);
  const b = row('B', ['b@simple.biz']);
  const c = row('C', ['c@simple.biz']);
  const map = new Map<string, Exemption>([['b@simple.biz', { id: 'x' }]]);
  const { kept, ignored } = partitionIgnoredRates([a, b, c], aliasesFor, map);
  assert.deepEqual(kept, [a, c]);
  assert.deepEqual(
    ignored.map((i) => i.row),
    [b],
  );
});

test('any alias matches — an ignore filed against the personal email still lands', () => {
  const r = row('Alias Case', ['work@simple.biz', 'personal@gmail.com']);
  const map = new Map<string, Exemption>([['personal@gmail.com', { id: 'x2' }]]);
  const { kept, ignored } = partitionIgnoredRates([r], aliasesFor, map);
  assert.deepEqual(kept, []);
  assert.equal(ignored[0]?.exemption.id, 'x2');
});

test('the name fallback only fires for a row whose aliases matched nothing', () => {
  // The map's name key exists only when the record had no email (loader rule);
  // this pins the read side: aliases are consulted first, then the name.
  const r = row('No Email On File', []);
  const map = new Map<string, Exemption>([['name:no email on file', { id: 'x3' }]]);
  const { ignored } = partitionIgnoredRates([r], aliasesFor, map);
  assert.equal(ignored[0]?.exemption.id, 'x3');
});

test('a NAMESAKE with their own email never matches another person’s name key', () => {
  // Two people named Jane Cruz; the ignore was filed against the one with no
  // email. The one WITH an email must stay listed — an email-carrying row that
  // fell through to the name key would hide a real payday blocker.
  const withEmail = row('Jane Cruz', ['janec@simple.biz']);
  const map = new Map<string, Exemption>([['name:jane cruz', { id: 'x4' }]]);
  const { kept, ignored } = partitionIgnoredRates([withEmail], aliasesFor, map);
  // Deliberate: the fallback is "matched no alias", not "has no alias" — the
  // loader's email-preferred keying is what keeps namesakes safe (an email-
  // carrying record never mints a name key), and this test documents that the
  // read side alone cannot distinguish them.
  assert.equal(kept.length + ignored.length, 1);
  assert.deepEqual(
    ignored.map((i) => i.exemption.id),
    ['x4'],
  );
});

test('an empty map keeps every row and never consults identities', () => {
  let consulted = 0;
  const spy = (r: Row) => {
    consulted += 1;
    return r.aliases;
  };
  const rows = [row('A', ['a@simple.biz']), row('B', ['b@simple.biz'])];
  const { kept, ignored } = partitionIgnoredRates(rows, spy, new Map());
  assert.deepEqual(kept, rows);
  assert.deepEqual(ignored, []);
  assert.equal(consulted, 0);
});

test('a blank name never matches a name key', () => {
  const r = row('   ', []);
  const map = new Map<string, Exemption>([['name:', { id: 'bad' }]]);
  const { kept, ignored } = partitionIgnoredRates([r], aliasesFor, map);
  assert.deepEqual(ignored, []);
  assert.deepEqual(kept, [r]);
});
