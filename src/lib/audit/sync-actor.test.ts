import test from 'node:test';
import assert from 'node:assert/strict';

import { syncRunActor } from './sync-actor';

const SYSTEM = { name: 'GSheets Sync', role: 'System' };

test('a manual sync names the person who clicked, never the system', () => {
  const a = syncRunActor(
    { ok: true, sessionEmail: 'carla@simple.biz', effectiveEmail: 'carla@simple.biz', elevated: true, roles: ['accounting'] },
    SYSTEM,
  );
  assert.deepEqual(a, { user_name: 'carla@simple.biz', user_role: 'accounting', trigger: 'manual' });
});

test('the scheduled run (Bearer secret, no session) is the system', () => {
  assert.deepEqual(syncRunActor(null, SYSTEM), { user_name: 'GSheets Sync', user_role: 'System', trigger: 'cron' });
});
