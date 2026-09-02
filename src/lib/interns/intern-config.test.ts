import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { INTERN_CONFIG_KEY, parseInternConfig, serializeInternConfig } from './intern-config';

test('the key is a single app_settings row, never a blob of amounts', () => {
  assert.equal(INTERN_CONFIG_KEY, 'orphanage.interns.config');
});

test('absent / blank / malformed → shareMode null (the gate stays CLOSED)', () => {
  assert.deepEqual(parseInternConfig(null), { shareMode: null });
  assert.deepEqual(parseInternConfig(undefined), { shareMode: null });
  assert.deepEqual(parseInternConfig(''), { shareMode: null });
  assert.deepEqual(parseInternConfig('not json'), { shareMode: null });
  assert.deepEqual(parseInternConfig('[]'), { shareMode: null });
  assert.deepEqual(parseInternConfig('{"shareMode":"auto"}'), { shareMode: null });
});

test('the two decided modes round-trip', () => {
  for (const m of ['system_split', 'intern_remits'] as const) {
    assert.deepEqual(parseInternConfig(serializeInternConfig({ shareMode: m })), { shareMode: m });
  }
  assert.deepEqual(parseInternConfig(serializeInternConfig({ shareMode: null })), { shareMode: null });
});
