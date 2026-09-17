import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADMIN_CACHE_KEYS,
  __resetAdminCacheMemory,
  __setAdminCacheStorage,
  bindAdminCacheIdentity,
  boundAdminCacheIdentity,
  clearAdminCache,
  clearAllAdminCache,
  getAdminCache,
  hasAdminCache,
  readAdminCacheStamp,
  setAdminCache,
} from './tab-cache';

/**
 * The Admin shell cache holds the Integrations client list and the Webhooks
 * config across a tab-switch remount and a reload. Failure classes pinned:
 *   1. cross-viewer paint (two admins on one machine, or a ?email= override)
 *   2. residue after a viewer swap, including keys an older deploy wrote
 *   3. a stale list past the ceiling painting a revoked key as live
 *   4. schema drift
 *   5. storage unavailable / quota → degrade, never throw
 *   6. inert-until-bound, which closes (1) on a cold reload
 *   7. (by construction) no skip-fetch flag — pinned below
 *   8. no key ever names a credential
 */

function fakeStorage(): Storage & { failWrites: boolean } {
  const map = new Map<string, string>();
  return {
    failWrites: false,
    get length() {
      return map.size;
    },
    key(i: number) {
      return Array.from(map.keys())[i] ?? null;
    },
    getItem(k: string) {
      return map.get(k) ?? null;
    },
    setItem(this: { failWrites: boolean }, k: string, v: string) {
      if (this.failWrites) throw new DOMException('QuotaExceededError');
      map.set(k, v);
    },
    removeItem(k: string) {
      map.delete(k);
    },
    clear() {
      map.clear();
    },
  } as Storage & { failWrites: boolean };
}

function newTab() {
  __resetAdminCacheMemory();
  const s = fakeStorage();
  __setAdminCacheStorage(s);
  return s;
}

function reload(s: Storage) {
  __resetAdminCacheMemory();
  __setAdminCacheStorage(s);
}

const CLIENTS = ADMIN_CACHE_KEYS.integrationsClients;
const SECTION = ADMIN_CACHE_KEYS.webhooksSection;

test('a tab-switch remount keeps the cached client list — the point of the module', () => {
  const s = newTab();
  bindAdminCacheIdentity('kaner@simple.biz');
  setAdminCache(CLIENTS, { clients: [{ id: 'a', key_prefix: 'hris_live_abc123' }] });
  reload(s);
  assert.equal(getAdminCache(CLIENTS), undefined, 'inert until re-bound');
  bindAdminCacheIdentity('kaner@simple.biz');
  assert.deepEqual(getAdminCache(CLIENTS), { clients: [{ id: 'a', key_prefix: 'hris_live_abc123' }] });
});

test('the open section survives a reload', () => {
  const s = newTab();
  bindAdminCacheIdentity('kaner@simple.biz');
  setAdminCache(SECTION, 'integrations');
  reload(s);
  bindAdminCacheIdentity('kaner@simple.biz');
  assert.equal(getAdminCache(SECTION), 'integrations');
});

test('class 1 — another admin on the same machine never reads this list', () => {
  const s = newTab();
  bindAdminCacheIdentity('kaner@simple.biz');
  setAdminCache(CLIENTS, { clients: [1] });
  reload(s);
  bindAdminCacheIdentity('other@simple.biz');
  assert.equal(getAdminCache(CLIENTS), undefined);
  assert.equal(s.getItem(`adm-tab:${CLIENTS}`), null, 'purged, not merely unreadable');
});

test('class 1 — a stamp from another viewer is rejected even on the same key', () => {
  const s = newTab();
  bindAdminCacheIdentity('kaner@simple.biz');
  setAdminCache(CLIENTS, { clients: [1] });
  const raw = JSON.parse(s.getItem(`adm-tab:${CLIENTS}`) as string) as Record<string, unknown>;
  s.setItem(`adm-tab:${CLIENTS}`, JSON.stringify({ ...raw, id: 'other@simple.biz' }));
  reload(s);
  bindAdminCacheIdentity('kaner@simple.biz');
  assert.equal(getAdminCache(CLIENTS), undefined);
});

test('identity is normalised', () => {
  const s = newTab();
  bindAdminCacheIdentity('kaner@simple.biz');
  setAdminCache(CLIENTS, 1);
  reload(s);
  bindAdminCacheIdentity('  KanER@Simple.Biz ');
  assert.equal(getAdminCache(CLIENTS), 1);
  assert.equal(boundAdminCacheIdentity(), 'kaner@simple.biz');
});

test('class 2 — a purge also clears keys this build does not know about, and nothing else', () => {
  const s = newTab();
  bindAdminCacheIdentity('kaner@simple.biz');
  s.setItem('adm-tab:retired:old', JSON.stringify({ v: 1, id: 'kaner@simple.biz', at: Date.now(), data: 1 }));
  s.setItem('mgr-tab:shell:team-roster', 'not ours');
  clearAllAdminCache();
  assert.equal(s.getItem('adm-tab:retired:old'), null);
  assert.equal(s.getItem('mgr-tab:shell:team-roster'), 'not ours');
  assert.equal(s.getItem('adm-tab:@identity'), null);
});

test('class 3 — past the 12h ceiling reads as absent and is evicted; inside it paints', () => {
  const s = newTab();
  bindAdminCacheIdentity('kaner@simple.biz');
  s.setItem(`adm-tab:${CLIENTS}`, JSON.stringify({ v: 1, id: 'kaner@simple.biz', at: Date.now() - 13 * 3_600_000, data: 'old' }));
  assert.equal(getAdminCache(CLIENTS), undefined);
  assert.equal(s.getItem(`adm-tab:${CLIENTS}`), null);
  s.setItem(`adm-tab:${CLIENTS}`, JSON.stringify({ v: 1, id: 'kaner@simple.biz', at: Date.now() - 11 * 3_600_000, data: 'ok' }));
  assert.equal(getAdminCache(CLIENTS), 'ok');
});

test('class 3 — the write stamp is readable for an "updated … ago" line', () => {
  newTab();
  bindAdminCacheIdentity('kaner@simple.biz');
  const before = Date.now();
  setAdminCache(CLIENTS, 1);
  const at = readAdminCacheStamp(CLIENTS);
  assert.ok(at !== undefined && at >= before);
  assert.equal(readAdminCacheStamp('nothing'), undefined);
});

test('class 4 — old schema, corrupt and non-envelope payloads read as absent, never throw', () => {
  const s = newTab();
  bindAdminCacheIdentity('kaner@simple.biz');
  for (const bad of [JSON.stringify({ v: 0, id: 'kaner@simple.biz', at: Date.now(), data: 1 }), 'nope', '"x"', 'null', '{"v":1}', '[]']) {
    s.setItem(`adm-tab:${CLIENTS}`, bad);
    assert.equal(getAdminCache(CLIENTS), undefined, `payload ${bad} must not paint`);
  }
});

test('class 5 — quota and no-storage degrade to memory, and capacity evicts the oldest', () => {
  const s = newTab();
  bindAdminCacheIdentity('kaner@simple.biz');
  s.failWrites = true;
  assert.doesNotThrow(() => setAdminCache(CLIENTS, 1));
  assert.equal(getAdminCache(CLIENTS), 1);
  s.failWrites = false;
  for (let i = 0; i < 40; i += 1) setAdminCache(`legacy:${i}`, i);
  const stored = Array.from({ length: s.length }, (_, i) => s.key(i)).filter(
    (k): k is string => !!k && k.startsWith('adm-tab:') && k !== 'adm-tab:@identity',
  );
  assert.ok(stored.length <= 32);
  assert.equal(getAdminCache('legacy:39'), 39);

  __resetAdminCacheMemory();
  __setAdminCacheStorage(null);
  bindAdminCacheIdentity('kaner@simple.biz');
  assert.doesNotThrow(() => setAdminCache(CLIENTS, 2));
  assert.equal(getAdminCache(CLIENTS), 2);
});

test('class 6 — unbound writes are dropped; binding null purges and returns to inert', () => {
  const s = newTab();
  setAdminCache(CLIENTS, 'leaked');
  assert.equal(s.getItem(`adm-tab:${CLIENTS}`), null);
  bindAdminCacheIdentity('kaner@simple.biz');
  assert.equal(getAdminCache(CLIENTS), undefined);
  setAdminCache(CLIENTS, 1);
  bindAdminCacheIdentity(null);
  assert.equal(boundAdminCacheIdentity(), null);
  assert.equal(s.getItem(`adm-tab:${CLIENTS}`), null);
  assert.equal(hasAdminCache(CLIENTS), false);
});

test('undefined is "nothing cached"; null, [] and 0 are values; clearing one key leaves others', () => {
  newTab();
  bindAdminCacheIdentity('kaner@simple.biz');
  setAdminCache(CLIENTS, null);
  assert.equal(getAdminCache(CLIENTS), null);
  assert.ok(hasAdminCache(CLIENTS));
  setAdminCache(SECTION, []);
  assert.deepEqual(getAdminCache(SECTION), []);
  setAdminCache(CLIENTS, undefined);
  assert.equal(getAdminCache(CLIENTS), null, 'undefined is never stored, the previous value stands');
  clearAdminCache(CLIENTS);
  assert.equal(hasAdminCache(CLIENTS), false);
  assert.deepEqual(getAdminCache(SECTION), []);
});

test('keys are uniquely spelled and none collides with the identity marker', () => {
  const all = Object.values(ADMIN_CACHE_KEYS);
  assert.equal(new Set(all).size, all.length);
  assert.ok(!all.map((v) => `adm-tab:${v}`).includes('adm-tab:@identity'));
});

test('no-skip-flag — nothing exported could let a caller skip a fetch', async () => {
  const mod: Record<string, unknown> = await import('./tab-cache');
  const banned = Object.keys(mod).filter((n) => /fetched|revalidat|skip|ttlHit/i.test(n));
  assert.deepEqual(banned, []);
});

test('class 8 — no key names a credential, bank field or signed URL', () => {
  const spelled = Object.entries(ADMIN_CACHE_KEYS)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  assert.ok(!/api[_-]?key|secret|token|bank|account|signed|presence/i.test(spelled), spelled);
});
