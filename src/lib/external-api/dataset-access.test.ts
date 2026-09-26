import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GML_CATALOG } from './catalog';
import { GLOBAL_MASTER_LIST_DATASET, type LiveDataset } from './datasets';
import { accessStateOf, clientAccess, describeAccess, fieldGrantFor, liveCount, type AccessClient } from './dataset-access';

const NOW = Date.parse('2026-09-25T12:00:00Z');

function client(over: Partial<AccessClient> = {}): AccessClient {
  return {
    id: '5b1f2c3a-0000-4000-8000-000000000001',
    name: 'Orphanage Management System',
    system: 'OMS',
    contact_email: null,
    key_prefix: 'hris_live_abc123',
    scopes: ['global_master_list.read'],
    granted_columns: null,
    expires_at: null,
    revoked_at: null,
    last_used_at: null,
    calls_7d: 0,
    ...over,
  };
}

test('a client without the scope is not listed', () => {
  const rows = clientAccess([client({ scopes: ['orphanage_pay.read'] }), client({ scopes: null })], GLOBAL_MASTER_LIST_DATASET, NOW);
  assert.equal(rows.length, 0);
});

test('revoked wins over expired — the order the auth gate refuses in', () => {
  assert.equal(accessStateOf({ revoked_at: '2026-09-20T00:00:00Z', expires_at: '2026-09-01T00:00:00Z' }, NOW), 'revoked');
});

test('an expiry in the past is expired; in the future or null is live', () => {
  assert.equal(accessStateOf({ revoked_at: null, expires_at: '2026-09-25T11:59:59Z' }, NOW), 'expired');
  assert.equal(accessStateOf({ revoked_at: null, expires_at: '2026-10-25T00:00:00Z' }, NOW), 'live');
  assert.equal(accessStateOf({ revoked_at: null, expires_at: null }, NOW), 'live');
});

test('an unparseable expiry is EXPIRED, never live (fail closed, same as isExpired)', () => {
  assert.equal(accessStateOf({ revoked_at: null, expires_at: 'not a date' }, NOW), 'expired');
});

test('only live clients count as able to read now', () => {
  const rows = clientAccess(
    [
      client({ id: 'a', name: 'B live' }),
      client({ id: 'b', name: 'A revoked', revoked_at: '2026-09-20T00:00:00Z' }),
      client({ id: 'c', name: 'C expired', expires_at: '2026-09-01T00:00:00Z' }),
      client({ id: 'd', name: 'A live' }),
    ],
    GLOBAL_MASTER_LIST_DATASET,
    NOW,
  );
  assert.equal(liveCount(rows), 2);
  assert.deepEqual(
    rows.map((r) => `${r.state}:${r.client.name}`),
    ['live:A live', 'live:B live', 'expired:C expired', 'revoked:A revoked'],
  );
});

test('a null grant is the whole table', () => {
  assert.deepEqual(fieldGrantFor({ granted_columns: null }, GLOBAL_MASTER_LIST_DATASET), { kind: 'whole' });
});

test('a partial grant lists what is visible and what is hidden, in catalog order', () => {
  const g = fieldGrantFor({ granted_columns: ['Work Email', 'Name'] }, GLOBAL_MASTER_LIST_DATASET);
  assert.equal(g.kind, 'partial');
  if (g.kind !== 'partial') return;
  assert.deepEqual(g.visible, ['Name', 'Work Email']);
  assert.equal(g.visible.length + g.hidden.length, GML_CATALOG.length);
  assert.ok(g.hidden.includes('Personal Email'));
});

test('a list that ticks every field reads as the whole table', () => {
  const g = fieldGrantFor({ granted_columns: GML_CATALOG.map((c) => c.name) }, GLOBAL_MASTER_LIST_DATASET);
  assert.deepEqual(g, { kind: 'whole' });
});

test('the GML column grant is never applied to another dataset — it is unknown, not guessed', () => {
  const other: LiveDataset = { ...GLOBAL_MASTER_LIST_DATASET, slug: 'x', scope: 'orphanage_pay.read' };
  assert.deepEqual(fieldGrantFor({ granted_columns: ['Name'] }, other), { kind: 'unknown' });
  assert.deepEqual(fieldGrantFor({ granted_columns: null }, other), { kind: 'unknown' });
});

test('a client list that was not read is UNKNOWN, never "no clients"', () => {
  const d = describeAccess(null);
  assert.equal(d.tone, 'unknown');
  assert.doesNotMatch(d.text, /\b0\b|no client/i);
});

test('the access line counts live clients and names the inactive ones', () => {
  assert.deepEqual(describeAccess([]), { tone: 'none', text: 'No client holds it' });
  const rows = clientAccess(
    [client({ id: 'a', name: 'A' }), client({ id: 'b', name: 'B', revoked_at: '2026-09-20T00:00:00Z' })],
    GLOBAL_MASTER_LIST_DATASET,
    NOW,
  );
  assert.deepEqual(describeAccess(rows), { tone: 'some', text: '1 live client · 1 inactive' });
  assert.deepEqual(describeAccess(rows.filter((r) => r.state !== 'live')), { tone: 'none', text: 'No live client · 1 inactive' });
});
