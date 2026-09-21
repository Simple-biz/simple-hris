import test from 'node:test';
import assert from 'node:assert/strict';
import * as availability from './availability';
import {
  AGENT_HEARTBEAT_MS,
  AGENT_STALE_AFTER_MS,
  CHAT_AVAILABILITY_LABELS,
  CHAT_AVAILABILITY_LABELS_AGENT,
  CHAT_AVAILABILITY_TONE,
  agentHeartbeatAgeMs,
  agentsOnQueue,
  isAgentOnQueue,
  summarizeChatAvailability,
  type ChatAgentRow,
} from './availability';

const NOW = new Date('2026-09-19T14:00:00.000Z');

/** An instant `ms` before NOW, as the DB would hand it back. */
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function agent(email: string, over: Partial<ChatAgentRow> = {}): ChatAgentRow {
  return {
    agent_email: email,
    agent_name: null,
    on_queue: true,
    last_heartbeat_at: ago(5_000),
    on_queue_since: ago(3_600_000),
    ...over,
  };
}

test('available means the DECLARATION and the EVIDENCE, both', () => {
  assert.equal(isAgentOnQueue(agent('carla@simple.biz'), NOW), true);

  // Toggled off, browser wide open. Presence would call this available; the
  // whole of Q4 is that it is not.
  assert.equal(
    isAgentOnQueue(agent('carla@simple.biz', { on_queue: false, last_heartbeat_at: null }), NOW),
    false,
  );

  // Declared on with no evidence at all. The SQL CHECK
  // (employee_support_chat_agents_beat_matches_toggle, :330-331) makes this row
  // illegal, so this is the fail-closed answer to a row we do not understand.
  assert.equal(
    isAgentOnQueue(agent('carla@simple.biz', { last_heartbeat_at: null }), NOW),
    false,
  );
  assert.equal(
    isAgentOnQueue(agent('carla@simple.biz', { last_heartbeat_at: 'whenever' }), NOW),
    false,
  );
});

test('a presence-shaped row can never put somebody on the queue', () => {
  // POST /api/presence/heartbeat takes the email from the request BODY when
  // there is no session (SECURITY_AUDIT.md:245 row #50), so a presence stamp is
  // forgeable and means "a tab is open" in any case. A row carrying only a
  // fresh beat has made no declaration, and gets no availability.
  const presenceShaped = {
    agent_email: 'carla@simple.biz',
    last_heartbeat_at: ago(1_000),
  } as unknown as ChatAgentRow;

  assert.equal(isAgentOnQueue(presenceShaped, NOW), false);
  assert.deepEqual(agentsOnQueue([presenceShaped], NOW), []);
  assert.equal(
    summarizeChatAvailability({ agents: [presenceShaped], engaged: [], now: NOW }).state,
    'nobody_on',
  );
});

test('the staleness window is exclusive at the top, in one place', () => {
  assert.equal(isAgentOnQueue(agent('a@simple.biz', { last_heartbeat_at: ago(0) }), NOW), true);
  assert.equal(
    isAgentOnQueue(agent('a@simple.biz', { last_heartbeat_at: ago(AGENT_STALE_AFTER_MS - 1) }), NOW),
    true,
  );
  assert.equal(
    isAgentOnQueue(agent('a@simple.biz', { last_heartbeat_at: ago(AGENT_STALE_AFTER_MS) }), NOW),
    false,
  );
  assert.equal(
    isAgentOnQueue(agent('a@simple.biz', { last_heartbeat_at: ago(AGENT_STALE_AFTER_MS + 1) }), NOW),
    false,
  );
});

test('the heartbeat ratio tolerates two dropped beats and still goes quiet faster than presence', () => {
  // The shipped presence pair is a 60s beat in a 120s window
  // (PresenceProvider.tsx:128, api/presence/active/route.ts:9) — ratio 2, which
  // tolerates exactly one dropped request. Both numbers moved deliberately:
  // a SHORTER window because a stale queue promise costs an employee a wait,
  // and a LARGER ratio because one flaky request must not un-staff the desk.
  assert.ok(
    AGENT_STALE_AFTER_MS / AGENT_HEARTBEAT_MS >= 3,
    'an agent must miss at least two beats before being called gone',
  );
  assert.ok(AGENT_STALE_AFTER_MS < 120_000, 'quieter, sooner, than the presence window');
  assert.ok(AGENT_HEARTBEAT_MS < 60_000, 'beats faster than presence, because more rides on it');
  assert.equal(AGENT_STALE_AFTER_MS % AGENT_HEARTBEAT_MS, 0, 'whole beats fit the window');
});

test('a clock-skewed future stamp reads fresh, and keeps its sign', () => {
  const skewed = agent('a@simple.biz', { last_heartbeat_at: new Date(NOW.getTime() + 2_000).toISOString() });
  assert.equal(agentHeartbeatAgeMs(skewed, NOW), -2_000);
  assert.equal(isAgentOnQueue(skewed, NOW), true);
  // No stamp is UNKNOWN, not infinitely old — the caller must not coalesce it.
  assert.equal(agentHeartbeatAgeMs(agent('a@simple.biz', { last_heartbeat_at: null }), NOW), null);
});

test('expiry is LAZY: the same row goes stale with nothing written', () => {
  const row = agent('carla@simple.biz', { last_heartbeat_at: ago(0) });
  const snapshot = JSON.parse(JSON.stringify(row)) as ChatAgentRow;

  assert.equal(isAgentOnQueue(row, NOW), true);
  const later = new Date(NOW.getTime() + AGENT_STALE_AFTER_MS);
  assert.equal(isAgentOnQueue(row, later), false);

  // Nothing swept, nothing flipped, no cron to run (docs/features/INDEX.md:42).
  // The row is untouched and the comparison simply stopped passing.
  assert.deepEqual(row, snapshot);
  assert.equal(row.on_queue, true);
});

test('FOUR states, not two — nobody_on and unknown never coincide', () => {
  const free = summarizeChatAvailability({
    agents: [agent('carla@simple.biz'), agent('grace@simple.biz')],
    engaged: ['carla@simple.biz'],
    now: NOW,
  });
  assert.deepEqual(free, { state: 'agents_free', onQueue: 2, free: 1 });

  const busy = summarizeChatAvailability({
    agents: [agent('carla@simple.biz'), agent('grace@simple.biz')],
    engaged: ['carla@simple.biz', 'grace@simple.biz'],
    now: NOW,
  });
  assert.deepEqual(busy, { state: 'agents_busy', onQueue: 2, free: 0 });

  const nobody = summarizeChatAvailability({
    agents: [agent('carla@simple.biz', { on_queue: false, last_heartbeat_at: null })],
    engaged: [],
    now: NOW,
  });
  assert.deepEqual(nobody, { state: 'nobody_on', onQueue: 0, free: 0 });

  const unknown = summarizeChatAvailability({ agents: null, engaged: null, now: NOW });
  assert.deepEqual(unknown, { state: 'unknown', onQueue: null, free: null });

  // The pair this feature is not allowed to collapse: a counted zero and an
  // absent count, in state, in number, in label and in colour.
  assert.notEqual(nobody.state, unknown.state);
  assert.notEqual(nobody.onQueue, unknown.onQueue);
  assert.notEqual(CHAT_AVAILABILITY_LABELS[nobody.state], CHAT_AVAILABILITY_LABELS[unknown.state]);
  assert.notEqual(CHAT_AVAILABILITY_TONE[nobody.state], CHAT_AVAILABILITY_TONE[unknown.state]);
});

test('there is no boolean that would collapse the four into two', () => {
  // A helper returning true/false would force every caller to throw two states
  // away, and the pair that always gets thrown away is nobody_on with unknown.
  assert.equal('isAnyoneAvailable' in availability, false);
  assert.equal('isChatAvailable' in availability, false);
});

test('agents on the queue with the engaged read missing is UNKNOWN, with the count kept', () => {
  // We know how many are on; we do not know whether any of them is free.
  // Guessing either way would be a promise we cannot keep.
  const state = summarizeChatAvailability({
    agents: [agent('carla@simple.biz'), agent('grace@simple.biz')],
    engaged: null,
    now: NOW,
  });
  assert.equal(state.state, 'unknown');
  assert.equal(state.onQueue, 2);
  assert.equal(state.free, null);
});

test('nobody_on wins over a missing engaged read, because free is moot at zero', () => {
  const state = summarizeChatAvailability({ agents: [], engaged: null, now: NOW });
  assert.deepEqual(state, { state: 'nobody_on', onQueue: 0, free: 0 });
});

test('a stale agent is not on the queue, however loudly they declared it', () => {
  const agents = [
    agent('carla@simple.biz', { last_heartbeat_at: ago(10_000) }),
    agent('grace@simple.biz', { last_heartbeat_at: ago(AGENT_STALE_AFTER_MS + 1) }),
  ];
  assert.deepEqual(
    agentsOnQueue(agents, NOW)?.map((a) => a.agent_email),
    ['carla@simple.biz'],
  );
  assert.deepEqual(summarizeChatAvailability({ agents, engaged: [], now: NOW }), {
    state: 'agents_free',
    onQueue: 1,
    free: 1,
  });
});

test('an unread agents table is not an empty one', () => {
  assert.equal(agentsOnQueue(null, NOW), null);
  assert.deepEqual(agentsOnQueue([], NOW), []);
});

test('busy matching survives casing and padding on either side', () => {
  // Both columns are lowercased by trigger (SQL :373, :412), so this is the
  // second belt under that: an address differing only in case would otherwise
  // count a busy agent as free and promise the employee an idle person.
  const state = summarizeChatAvailability({
    agents: [agent('Carla@Simple.biz')],
    engaged: ['  CARLA@simple.BIZ  '],
    now: NOW,
  });
  assert.deepEqual(state, { state: 'agents_busy', onQueue: 1, free: 0 });
});

test('nulls in the engaged list are ignored, not matched', () => {
  // `claimed_by` is nullable, and a NULL that matched an agent with no address
  // would mark a real person busy for a session nobody holds.
  const state = summarizeChatAvailability({
    agents: [agent('carla@simple.biz')],
    engaged: [null, undefined, '', '   '],
    now: NOW,
  });
  assert.deepEqual(state, { state: 'agents_free', onQueue: 1, free: 1 });
});

test('an agent row with no usable address is never counted free', () => {
  // We cannot match it against the busy set, so we cannot promise it is idle.
  const state = summarizeChatAvailability({
    agents: [agent('   ')],
    engaged: [],
    now: NOW,
  });
  assert.equal(state.onQueue, 1);
  assert.equal(state.free, 0);
  assert.equal(state.state, 'agents_busy');
});

test('every state has employee copy, agent copy and a tone, and they are distinct', () => {
  const states = ['agents_free', 'agents_busy', 'nobody_on', 'unknown'] as const;
  for (const s of states) {
    assert.ok(CHAT_AVAILABILITY_LABELS[s].length > 0, s);
    assert.ok(CHAT_AVAILABILITY_LABELS_AGENT[s].length > 0, s);
    assert.ok(CHAT_AVAILABILITY_TONE[s].length > 0, s);
  }
  assert.equal(new Set(states.map((s) => CHAT_AVAILABILITY_LABELS[s])).size, 4);
  assert.equal(new Set(states.map((s) => CHAT_AVAILABILITY_LABELS_AGENT[s])).size, 4);
  // The employee's unknown copy reads as work in progress, never as an answer.
  assert.doesNotMatch(CHAT_AVAILABILITY_LABELS.unknown, /nobody/i);
});

test('the copy names people, never a clock — hours.ts owns the window', () => {
  // "Is the desk open" and "is anybody at it" are different questions and both
  // are shown. Availability copy that said "closed" or named a timezone would
  // be answering the other one, twelve hours wrong for half its readers.
  for (const copy of [
    ...Object.values(CHAT_AVAILABILITY_LABELS),
    ...Object.values(CHAT_AVAILABILITY_LABELS_AGENT),
  ]) {
    assert.doesNotMatch(copy, /eastern|manila|\bEST\b|\bEDT\b|closed|open until|9 AM|5 PM/i);
  }
});
