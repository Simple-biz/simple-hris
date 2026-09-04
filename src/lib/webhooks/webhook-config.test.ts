import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTECTED_PAYLOAD_KEYS,
  WEBHOOK_AUTOMATIONS,
  applyRecipientOverride,
  mergePayloadOverrides,
  normalizePayloadOverrides,
  normalizeRecipientOverride,
  parseWebhookConfig,
  validateAutomationConfig,
} from './webhook-config';

/**
 * Pins the failure classes in docs/features/webhook-automations.md: an override
 * lying about the week's facts, a removed person still being mailed, a bad row
 * breaking delivery, and an unknown field surprising the URL-only resolver.
 */

const role = [
  { email: 'carla@simple.biz', name: 'Carla' },
  { email: 'claire@simple.biz', name: 'Claire' },
  { email: 'lenny@simple.biz', name: null },
];

describe('parseWebhookConfig', () => {
  test('legacy entries (no automation fields) parse with null overrides', () => {
    const [e] = parseWebhookConfig(
      JSON.stringify([{ id: 'a', slug: 'payment_cycle_complete', url: 'https://n8n/x', active: true }]),
    );
    assert.equal(e.slug, 'payment_cycle_complete');
    assert.equal(e.active, true);
    assert.equal(e.recipients, null);
    assert.equal(e.payload_overrides, null);
  });

  test('junk never throws — malformed JSON, non-arrays, non-object items all yield []', () => {
    assert.deepEqual(parseWebhookConfig('not json'), []);
    assert.deepEqual(parseWebhookConfig('{"slug":"x"}'), []);
    assert.deepEqual(parseWebhookConfig('[1,"two",null]'), []);
    assert.deepEqual(parseWebhookConfig(null), []);
  });

  test('a hand-edited row carrying a protected key loses that key on parse', () => {
    const [e] = parseWebhookConfig(
      JSON.stringify([
        {
          slug: 's',
          url: '',
          active: false,
          payload_overrides: { stats: { paid_count: 9999 }, note: 'hi' },
        },
      ]),
    );
    assert.deepEqual(e.payload_overrides, { note: 'hi' });
  });
});

describe('recipient override', () => {
  test('no override = the role list, every one tagged role', () => {
    const { effective, added, removed } = applyRecipientOverride(role, null);
    assert.deepEqual(effective.map((r) => r.email), role.map((r) => r.email));
    assert.ok(effective.every((r) => r.source === 'role'));
    assert.deepEqual(added, []);
    assert.deepEqual(removed, []);
  });

  test('role mode: Carla resigns → remove her, add her replacement', () => {
    const { effective, added, removed } = applyRecipientOverride(role, {
      mode: 'role',
      add: ['maya@simple.biz'],
      remove: ['carla@simple.biz'],
      custom: [],
    });
    assert.deepEqual(effective.map((r) => r.email), ['claire@simple.biz', 'lenny@simple.biz', 'maya@simple.biz']);
    assert.equal(effective.at(-1)?.source, 'added');
    assert.deepEqual(added, ['maya@simple.biz']);
    assert.deepEqual(removed, ['carla@simple.biz']);
  });

  test('remove wins over add — an address in both lists is never mailed', () => {
    const { effective } = applyRecipientOverride(role, {
      mode: 'role',
      add: ['carla@simple.biz'],
      remove: ['carla@simple.biz'],
      custom: [],
    });
    assert.ok(!effective.some((r) => r.email === 'carla@simple.biz'));
  });

  test('adding someone already on the role list does not duplicate them', () => {
    const { effective, added } = applyRecipientOverride(role, {
      mode: 'role',
      add: ['CLAIRE@simple.biz'],
      remove: [],
      custom: [],
    });
    assert.equal(effective.filter((r) => r.email === 'claire@simple.biz').length, 1);
    assert.deepEqual(added, []);
  });

  test('custom mode replaces the audience; names are borrowed when known', () => {
    const { effective, removed } = applyRecipientOverride(role, {
      mode: 'custom',
      add: [],
      remove: [],
      custom: ['claire@simple.biz', 'maya@simple.biz'],
    });
    assert.deepEqual(
      effective.map((r) => [r.email, r.name, r.source]),
      [
        ['claire@simple.biz', 'Claire', 'custom'],
        ['maya@simple.biz', null, 'custom'],
      ],
    );
    assert.deepEqual(removed, ['carla@simple.biz', 'lenny@simple.biz']);
  });

  test('normalizeRecipientOverride: an empty role override is no override; junk emails drop', () => {
    assert.equal(normalizeRecipientOverride({ mode: 'role', add: [], remove: [] }), null);
    assert.equal(normalizeRecipientOverride('nope'), null);
    assert.deepEqual(normalizeRecipientOverride({ mode: 'role', add: ['x@y.z', 'not-an-email', 'X@Y.Z'] }), {
      mode: 'role',
      add: ['x@y.z'],
      remove: [],
      custom: [],
    });
  });
});

describe('payload overrides', () => {
  const base = {
    event: 'payment_cycle.completed',
    stats: { paid_count: 1023, unpaid_count: 19 },
    recipients: [{ email: 'a@b.c', name: null }],
  };

  test('non-protected keys merge; protected keys are rejected and the facts survive', () => {
    const { payload, rejected } = mergePayloadOverrides(base, {
      note: 'Great week',
      cc: ['boss@simple.biz'],
      stats: { paid_count: 999999, unpaid_count: 0 },
      recipients: [],
      event: 'something_else',
    });
    assert.deepEqual(rejected.sort(), ['event', 'recipients', 'stats']);
    assert.equal(payload.note, 'Great week');
    assert.deepEqual(payload.cc, ['boss@simple.biz']);
    assert.deepEqual(payload.stats, base.stats);
    assert.deepEqual(payload.recipients, base.recipients);
    assert.equal(payload.event, 'payment_cycle.completed');
  });

  test('every honesty + envelope field is protected', () => {
    for (const k of ['event', 'trigger', 'celebrate', 'cycle', 'stats', 'recipients', 'attachments', 'attachments_error', 'sent_by', 'test']) {
      assert.ok(PROTECTED_PAYLOAD_KEYS.includes(k), `${k} must be protected`);
    }
  });

  test('normalizePayloadOverrides drops protected keys and returns null when nothing is left', () => {
    assert.equal(normalizePayloadOverrides({ stats: {} }), null);
    assert.equal(normalizePayloadOverrides([1, 2]), null);
    assert.deepEqual(normalizePayloadOverrides({ a: 1, cycle: {} }), { a: 1 });
  });
});

describe('validateAutomationConfig (strict, for the editor)', () => {
  test('a clean config validates and empty role overrides collapse to null', () => {
    const r = validateAutomationConfig({ recipients: { mode: 'role', add: [], remove: [] }, payload_overrides: {} });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.config.recipients, null);
      assert.equal(r.config.payload_overrides, null);
    }
  });

  test('a protected key is REFUSED on save, by name', () => {
    const r = validateAutomationConfig({ payload_overrides: { stats: {}, note: 'x' } });
    assert.ok(!r.ok);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes('"stats"') && e.includes('protected')));
  });

  test('invalid emails, add∩remove, empty custom list are all named', () => {
    const r = validateAutomationConfig({
      recipients: { mode: 'custom', add: ['a@b.c'], remove: ['a@b.c'], custom: ['nope'] },
    });
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.ok(r.errors.some((e) => e.includes('"nope"')));
      assert.ok(r.errors.some((e) => e.includes('both add and remove')));
      assert.ok(r.errors.some((e) => e.includes('custom mode needs at least one')));
    }
  });

  test('payload_overrides must be an object', () => {
    const r = validateAutomationConfig({ payload_overrides: ['x'] });
    assert.ok(!r.ok);
  });
});

describe('automation descriptors', () => {
  test('payment_cycle_complete is the only automation, and it names its single trigger', () => {
    assert.deepEqual(Object.keys(WEBHOOK_AUTOMATIONS), ['payment_cycle_complete']);
    const d = WEBHOOK_AUTOMATIONS.payment_cycle_complete;
    assert.match(d.trigger, /Close the pay cycle/);
    assert.match(d.trigger, /Nothing else can fire it/);
    assert.equal(d.attachments.length, 3);
  });
});
