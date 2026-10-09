import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KEY_LABEL_MAX,
  buildKeyGrid,
  canArchiveKey,
  cleanKeyLabel,
  liveSeatOf,
  matchesPerson,
  parseKeyCreate,
  parseKeySeatWrite,
  sameKeyName,
} from './keys';
import type { KeySeat, ScoreboardKey } from './types';

const KEY_A = '11111111-1111-4111-8111-111111111111';
const KEY_B = '22222222-2222-4222-8222-222222222222';
const KEY_OLD = '33333333-3333-4333-8333-333333333333';

const key = (id: string, label: string, archived = false): ScoreboardKey => ({
  id,
  label,
  createdBy: 'carla@simple.biz',
  createdAt: '2026-10-09T12:00:00Z',
  archived,
});

let n = 0;
const seat = (keyId: string, email: string, removedAt: string | null = null): KeySeat => ({
  id: `seat-${++n}`,
  keyId,
  email,
  givenBy: 'carla@simple.biz',
  givenAt: '2026-10-09T12:00:00Z',
  removedBy: removedAt ? 'carla@simple.biz' : null,
  removedAt,
});

test('a key name is trimmed, inner spaces collapsed, 1 to 40 characters', () => {
  assert.equal(cleanKeyLabel('  QBO  '), 'QBO');
  assert.equal(cleanKeyLabel('Chase   Business'), 'Chase Business');
  assert.equal(cleanKeyLabel('   '), null);
  assert.equal(cleanKeyLabel(''), null);
  assert.equal(cleanKeyLabel('x'.repeat(KEY_LABEL_MAX)), 'x'.repeat(KEY_LABEL_MAX));
  assert.equal(cleanKeyLabel('x'.repeat(KEY_LABEL_MAX + 1)), null);
  assert.equal(cleanKeyLabel(42), null);
});

test('the 40-character limit matches the table CHECK', () => {
  const sql = readFileSync(join(process.cwd(), 'references', 'sql', 'create', '2026-10-09_accounting_scoreboard_keys.sql'), 'utf8');
  assert.match(sql, new RegExp(`length\\(label\\) BETWEEN 1 AND ${KEY_LABEL_MAX}`));
});

test('parseKeyCreate takes a name and nothing else', () => {
  assert.deepEqual(parseKeyCreate({ label: ' Stripe ' }), { ok: true, value: { label: 'Stripe' } });
  assert.equal(parseKeyCreate({ label: '' }).ok, false);
  assert.equal(parseKeyCreate(null).ok, false);
  assert.equal(parseKeyCreate([]).ok, false);
});

test('parseKeySeatWrite needs a key id and a work email, lower-cased', () => {
  assert.deepEqual(parseKeySeatWrite({ keyId: KEY_A, email: ' Ainsley@Simple.biz ' }), {
    ok: true,
    value: { keyId: KEY_A, email: 'ainsley@simple.biz' },
  });
  assert.equal(parseKeySeatWrite({ keyId: 'qbo', email: 'a@simple.biz' }).ok, false);
  assert.equal(parseKeySeatWrite({ keyId: KEY_A, email: 'not an email' }).ok, false);
  assert.equal(parseKeySeatWrite({ keyId: KEY_A }).ok, false);
});

test('names compare whatever the case and spacing, like the unique index', () => {
  assert.equal(sameKeyName('QBO', ' qbo '), true);
  assert.equal(sameKeyName('QBO', 'QBO2'), false);
});

test('the grid: live keys A to Z, live seats counted, removed seats kept as history', () => {
  const grid = buildKeyGrid({
    keys: [key(KEY_B, 'Stripe'), key(KEY_A, 'QBO'), key(KEY_OLD, 'Old tool', true)],
    seats: [
      seat(KEY_A, 'alissa@simple.biz'),
      seat(KEY_B, 'alissa@simple.biz'),
      seat(KEY_A, 'ainsley@simple.biz', '2026-10-09T13:00:00Z'),
      seat(KEY_OLD, 'ainsley@simple.biz', '2026-10-01T13:00:00Z'),
    ],
    people: [
      { email: 'alissa@simple.biz', name: 'Alissa' },
      { email: 'ainsley@simple.biz', name: 'Ainsley' },
      { email: 'olivia@simple.biz', name: 'Olivia' },
    ],
  });
  assert.deepEqual(grid.keys.map((k) => k.label), ['QBO', 'Stripe']);
  assert.deepEqual(grid.seatCount, { [KEY_A]: 1, [KEY_B]: 1 });
  const alissa = grid.people.find((p) => p.email === 'alissa@simple.biz')!;
  assert.deepEqual(alissa.seats.map((s) => s.keyId), [KEY_A, KEY_B], 'seats follow the key order');
  const ainsley = grid.people.find((p) => p.email === 'ainsley@simple.biz')!;
  assert.equal(ainsley.seats.length, 0);
  assert.deepEqual(ainsley.removed.map((s) => s.keyId), [KEY_A, KEY_OLD], 'newest removal first');
  assert.equal(liveSeatOf(alissa, KEY_B)?.keyId, KEY_B);
  assert.equal(liveSeatOf(ainsley, KEY_A), null, 'a removed seat is not held');
  assert.deepEqual(grid.offBoard, []);
});

test('someone off the board who still holds a seat is listed first: that seat is still paid for', () => {
  const grid = buildKeyGrid({
    keys: [key(KEY_A, 'QBO')],
    seats: [seat(KEY_A, 'jerick@simple.biz'), seat(KEY_A, 'alissa@simple.biz'), seat(KEY_A, 'gone@simple.biz', '2026-10-01T00:00:00Z')],
    people: [
      { email: 'alissa@simple.biz', name: 'Alissa' },
      { email: 'aaron@simple.biz', name: 'Aaron' },
    ],
  });
  assert.deepEqual(grid.offBoard.map((p) => p.email), ['jerick@simple.biz']);
  assert.deepEqual(
    grid.people.map((p) => [p.email, p.onBoard]),
    [
      ['jerick@simple.biz', false],
      ['aaron@simple.biz', true],
      ['alissa@simple.biz', true],
      ['gone@simple.biz', false],
    ],
    'off-board holders first, then the board A to Z, then history-only people',
  );
  assert.equal(grid.people[0].name, 'jerick', 'an off-board holder is named by the address');
  assert.equal(grid.seatCount[KEY_A], 2);
});

test('a key is archived only once nobody holds a seat on it', () => {
  assert.equal(canArchiveKey(0), true);
  assert.equal(canArchiveKey(1), false);
});

test('search matches the name or the address', () => {
  const p = { name: 'Ainsley', email: 'ainsleyw@simple.biz' };
  assert.equal(matchesPerson(p, ''), true);
  assert.equal(matchesPerson(p, 'ains'), true);
  assert.equal(matchesPerson(p, 'AINSLEYW@'), true);
  assert.equal(matchesPerson(p, 'carla'), false);
});

test('removing a seat is a stamp, never a delete: the server never calls .delete() on the Keys tables', () => {
  const server = readFileSync(join(process.cwd(), 'src', 'lib', 'accounting-scoreboard', 'server.ts'), 'utf8');
  const start = server.indexOf('// Keys (Open item 424)');
  assert.ok(start > 0, 'the Keys block is in server.ts');
  const block = server.slice(start);
  assert.doesNotMatch(block, /\.delete\(/);
  assert.match(block, /removed_at: new Date\(\)\.toISOString\(\), removed_by: viewer\.email/);
});
