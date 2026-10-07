import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SCOPES, EXTERNAL_SCOPES, GML_SCOPE, OFFBOARDED_SCOPE, holdsScope, normalizeScopes } from './scopes';

test('the two scopes, in picker order', () => {
  assert.deepEqual([...EXTERNAL_SCOPES], ['global_master_list.read', 'offboarded.read']);
});

test('every scope is a read', () => {
  for (const s of EXTERNAL_SCOPES) assert.match(s, /^[a-z_]+\.read$/);
});

test('a new client is roster-only unless the admin ticks Offboarded', () => {
  assert.deepEqual([...DEFAULT_SCOPES], [GML_SCOPE]);
});

test('normalizeScopes: canonical order, deduped', () => {
  assert.deepEqual(normalizeScopes([OFFBOARDED_SCOPE, GML_SCOPE, OFFBOARDED_SCOPE]), { ok: true, scopes: [GML_SCOPE, OFFBOARDED_SCOPE] });
  assert.deepEqual(normalizeScopes([' offboarded.read ']), { ok: true, scopes: [OFFBOARDED_SCOPE] });
});

test('normalizeScopes: an unknown name is named, never dropped', () => {
  const r = normalizeScopes([GML_SCOPE, 'bank_info.read']);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /bank_info\.read/);
  assert.equal(normalizeScopes(['offboarded.write']).ok, false);
  assert.equal(normalizeScopes([42]).ok, false);
});

test('normalizeScopes: empty or not-a-list is refused', () => {
  assert.equal(normalizeScopes([]).ok, false);
  assert.equal(normalizeScopes(null).ok, false);
  assert.equal(normalizeScopes('global_master_list.read').ok, false);
});

test('holdsScope: a non-array holds nothing', () => {
  assert.equal(holdsScope(null, GML_SCOPE), false);
  assert.equal(holdsScope('global_master_list.read', GML_SCOPE), false);
  assert.equal(holdsScope([GML_SCOPE], OFFBOARDED_SCOPE), false);
  assert.equal(holdsScope([GML_SCOPE, OFFBOARDED_SCOPE], OFFBOARDED_SCOPE), true);
});

test('the gate takes the accepted scopes as a REQUIRED argument — no default, no module constant', () => {
  // authenticate.ts is server-only, so this pins its source. A default here would make a
  // forgotten argument on a future route silently grant whatever the default names
  // (docs/superpowers/plans/2026-09-21-external-api-resources-and-writes.md § Global constraints).
  const dir = path.join(process.cwd(), 'src', 'lib', 'external-api');
  const src = readFileSync(path.join(dir, 'authenticate.ts'), 'utf8');
  const sig = /export async function authenticateExternalRequest\(([^)]*)\)/.exec(src);
  assert.ok(sig, 'authenticateExternalRequest signature not found');
  assert.match(sig[1], /accepted:\s*readonly ExternalScope\[\]/);
  assert.doesNotMatch(sig[1], /=/, 'the accepted scopes must not have a default');
  assert.doesNotMatch(src, /export const REQUIRED_SCOPE\b/, 'the old single-scope constant must not come back');
  const serve = readFileSync(path.join(dir, 'serve.ts'), 'utf8');
  assert.match(serve, /scopes:\s*readonly ExternalScope\[\];/, 'ExternalCallInfo.scopes must be required');
});
