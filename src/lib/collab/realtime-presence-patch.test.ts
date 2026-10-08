import test from 'node:test';
import assert from 'node:assert/strict';
// The adapter every `channel.presenceState()` in the app reads through.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PresenceAdapter = require('@supabase/realtime-js/dist/main/phoenix/presenceAdapter').default;

/**
 * Pins patches/@supabase+realtime-js+2.101.1.patch.
 *
 * Unpatched, the adapter's join/leave callbacks deleted `phx_ref` from the
 * LIVE presence state, so a later leave could never match that entry. A
 * long-lived viewer kept every section a person had visited, and the collab
 * rail named the first one (Lenny 2026-10-08: rail said Payroll Wizard, his
 * screen and the server said Payment Dispatch). If `npm install` ever runs
 * without the patch, or a bump drops the fix, these fail.
 */

type Handler = (payload: unknown) => void;

function fakeChannel() {
  const handlers = new Map<string, Handler>();
  const phoenix = {
    on: (event: string, cb: Handler) => {
      handlers.set(event, cb);
    },
    joinRef: () => 'join-1',
    trigger: () => {},
  };
  return {
    adapterHost: { getChannel: () => phoenix },
    state: (p: unknown) => handlers.get('presence_state')!(p),
    diff: (d: unknown) => handlers.get('presence_diff')!(d),
  };
}

const meta = (ref: string, section: string, prev?: string) => ({
  phx_ref: ref,
  ...(prev ? { phx_ref_prev: prev } : {}),
  email: 'lenny@simple.biz',
  section,
});

function sections(adapter: { state: Record<string, { section: string }[]> }): string[] {
  return (adapter.state['lenny@simple.biz'] ?? []).map((m) => m.section);
}

test('THE BUG: a section change (one tab re-tracking) replaces the entry, never stacks beside it', () => {
  const ch = fakeChannel();
  const adapter = new PresenceAdapter(ch.adapterHost);
  ch.state({ 'lenny@simple.biz': { metas: [meta('r1', 'payroll-wizard')] } });
  assert.deepEqual(sections(adapter), ['payroll-wizard']);

  // What Realtime sends when the same tab tracks again: join new, leave old.
  ch.diff({
    joins: { 'lenny@simple.biz': { metas: [meta('r2', 'payment-dispatch', 'r1')] } },
    leaves: { 'lenny@simple.biz': { metas: [meta('r1', 'payroll-wizard')] } },
  });
  assert.deepEqual(sections(adapter), ['payment-dispatch']);

  // And again: the entry the previous diff added must also be removable.
  ch.diff({
    joins: { 'lenny@simple.biz': { metas: [meta('r3', 'overview', 'r2')] } },
    leaves: { 'lenny@simple.biz': { metas: [meta('r2', 'payment-dispatch', 'r1')] } },
  });
  assert.deepEqual(sections(adapter), ['overview']);
});

test('a second tab opening, then the first closing, leaves only the second', () => {
  const ch = fakeChannel();
  const adapter = new PresenceAdapter(ch.adapterHost);
  ch.state({ 'lenny@simple.biz': { metas: [meta('t1', 'payroll-wizard')] } });
  ch.diff({ joins: { 'lenny@simple.biz': { metas: [meta('t2', 'payment-dispatch')] } }, leaves: {} });
  assert.deepEqual(sections(adapter), ['payroll-wizard', 'payment-dispatch']);
  ch.diff({ joins: {}, leaves: { 'lenny@simple.biz': { metas: [meta('t1', 'payroll-wizard')] } } });
  assert.deepEqual(sections(adapter), ['payment-dispatch']);
});

test('a person who changed section and then left is gone from the roster, not a ghost', () => {
  const ch = fakeChannel();
  const adapter = new PresenceAdapter(ch.adapterHost);
  ch.state({ 'lenny@simple.biz': { metas: [meta('r1', 'payroll-wizard')] } });
  ch.diff({
    joins: { 'lenny@simple.biz': { metas: [meta('r2', 'payment-dispatch', 'r1')] } },
    leaves: { 'lenny@simple.biz': { metas: [meta('r1', 'payroll-wizard')] } },
  });
  ch.diff({ joins: {}, leaves: { 'lenny@simple.biz': { metas: [meta('r2', 'payment-dispatch', 'r1')] } } });
  assert.equal(adapter.state['lenny@simple.biz'], undefined);
});

test('reads still expose presence_ref and hide phx_ref', () => {
  const ch = fakeChannel();
  const adapter = new PresenceAdapter(ch.adapterHost);
  ch.state({ 'lenny@simple.biz': { metas: [meta('r1', 'payroll-wizard')] } });
  const [entry] = adapter.state['lenny@simple.biz'];
  assert.equal(entry.presence_ref, 'r1');
  assert.equal('phx_ref' in entry, false);
});
