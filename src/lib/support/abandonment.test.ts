import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_STALE_AFTER_MS } from './availability';
import { SUPPORT_CONCERN_MAX } from './types';
import {
  CHAT_TICKET_CATEGORY,
  EMPLOYEE_STALE_AFTER_MS,
  SWEEP_ACTION_MAX,
  SWEEP_COMPLETE_GRACE_MS,
  SWEEP_CONVERT_MAX,
  becameTicketNotification,
  becameTicketSystemLine,
  buildChatTicket,
  buildChatTicketConcern,
  chatTicketConcernPattern,
  chatTicketMarker,
  employeeIdleMs,
  isEmployeeStale,
  planSweep,
  planSweepAction,
  type SweepSessionRow,
  type SweepTranscriptMessage,
} from './abandonment';

const NOW = new Date('2026-09-19T14:30:00.000Z');

/** One session row, defaulted to "waiting, heartbeat a second ago". */
function session(over: Partial<SweepSessionRow> = {}): SweepSessionRow {
  return {
    id: 'sess-1',
    session_no: 1043,
    status: 'waiting',
    work_email: 'rowan@simple.biz',
    filed_by_email: 'rowan@simple.biz',
    member_name: 'Rowan Diaz',
    department: 'hsl:intake_specialist',
    queued_at: '2026-09-19T14:00:00.000Z',
    last_seen_at: new Date(NOW.getTime() - 1_000).toISOString(),
    ended_at: null,
    claimed_by: null,
    became_ticket_id: null,
    ...over,
  };
}

/** A heartbeat `ms` old. */
const seenAgo = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const line = (over: Partial<SweepTranscriptMessage> = {}): SweepTranscriptMessage => ({
  author_side: 'employee',
  author_name: 'Rowan Diaz',
  body: 'I was not paid for last week.',
  created_at: '2026-09-19T14:01:00.000Z',
  ...over,
});

const noAgents = { now: NOW, freshAgents: new Set<string>() };

/* ───────────────────────────── the two windows ───────────────────────────── */

test('the employee window is much longer than the agent window, and that is the point', () => {
  // Calling an AGENT gone early costs them one offer. Calling an EMPLOYEE gone
  // early takes them out of a line they are still watching and converts their
  // conversation into a ticket. The constants must never be tidied together.
  assert.ok(EMPLOYEE_STALE_AFTER_MS > AGENT_STALE_AFTER_MS);
  assert.ok(EMPLOYEE_STALE_AFTER_MS >= AGENT_STALE_AFTER_MS * 3);

  // And it must survive the employee's SLOWEST legitimate beat: 45s with the
  // dialog shut (EmployeeSupportChat.tsx:168), throttled by the browser to
  // roughly 60s in a background tab. Three of those missed in a row is still
  // inside the window.
  assert.ok(EMPLOYEE_STALE_AFTER_MS > 60_000 * 3);
});

test('an unparseable heartbeat is "no evidence", never "infinitely old"', () => {
  const broken = session({ last_seen_at: 'not a timestamp' });
  assert.equal(employeeIdleMs(broken, NOW), null);
  // Fail closed: nothing is swept on a stamp we cannot read.
  assert.equal(isEmployeeStale(broken, NOW), false);
  assert.deepEqual(planSweepAction(broken, noAgents), {
    kind: 'keep',
    sessionId: 'sess-1',
    because: 'unreadable',
  });
});

test('the staleness boundary is one definition, inclusive at the top', () => {
  const justInside = session({ last_seen_at: seenAgo(EMPLOYEE_STALE_AFTER_MS - 1) });
  const exactly = session({ last_seen_at: seenAgo(EMPLOYEE_STALE_AFTER_MS) });

  assert.equal(isEmployeeStale(justInside, NOW), false);
  assert.equal(isEmployeeStale(exactly, NOW), true);
  // planSweepAction must agree with isEmployeeStale on the exact same instant —
  // a second comparison in the planner is how the two drift apart.
  assert.equal(planSweepAction(justInside, noAgents).kind, 'keep');
  assert.equal(planSweepAction(exactly, noAgents).kind, 'convert');
});

test('a clock-skewed future heartbeat reads as fresh, not as ancient', () => {
  const skewed = session({ last_seen_at: new Date(NOW.getTime() + 5_000).toISOString() });
  assert.equal(employeeIdleMs(skewed, NOW), -5_000);
  assert.equal(isEmployeeStale(skewed, NOW), false);
});

/* ──────────────────────────── Kane's Q1, the rule ────────────────────────── */

test("an UNANSWERED chat becomes a ticket; an answered one just ends", () => {
  const gone = seenAgo(EMPLOYEE_STALE_AFTER_MS + 1_000);

  // Nobody ever picked it up.
  assert.equal(planSweepAction(session({ status: 'waiting', last_seen_at: gone }), noAgents).kind, 'convert');
  // An agent took it and never said a word — the first agent message is what
  // moves a session to 'live', so 'claimed' means still unanswered.
  assert.equal(
    planSweepAction(
      session({ status: 'claimed', claimed_by: 'carla@simple.biz', last_seen_at: gone }),
      noAgents,
    ).kind,
    'convert',
  );
  // A conversation demonstrably happened. No ES- number is owed.
  assert.equal(
    planSweepAction(
      session({ status: 'live', claimed_by: 'carla@simple.biz', last_seen_at: gone }),
      noAgents,
    ).kind,
    'end',
  );
});

test('an abandoned CLAIM is not an abandoned SESSION: the employee keeps their place', () => {
  // The agent vanished; the EMPLOYEE is still beating. Plan :93-94 — "the
  // employee never pays for an agent's disconnect."
  const row = session({ status: 'claimed', claimed_by: 'Carla@Simple.biz', last_seen_at: seenAgo(2_000) });

  assert.deepEqual(planSweepAction(row, { now: NOW, freshAgents: new Set() }), {
    kind: 'release',
    sessionId: 'sess-1',
    heldBy: 'carla@simple.biz',
  });

  // Still here -> nothing happens.
  assert.equal(
    planSweepAction(row, { now: NOW, freshAgents: new Set(['carla@simple.biz']) }).kind,
    'keep',
  );

  // A release is NOT a conversion: it must never appear in the ticket groups.
  const plan = planSweep([row], { now: NOW, freshAgents: new Set() });
  assert.equal(plan.releases.length, 1);
  assert.equal(plan.converts.length, 0);
  assert.equal(plan.completes.length, 0);
});

test('an unreadable agents table releases NOTHING — unknown is not "gone"', () => {
  const row = session({ status: 'claimed', claimed_by: 'carla@simple.biz', last_seen_at: seenAgo(2_000) });
  assert.deepEqual(planSweepAction(row, { now: NOW, freshAgents: null }), {
    kind: 'keep',
    sessionId: 'sess-1',
    because: 'agents_unknown',
  });
  // Empty is a FACT (we looked, nobody is on); null is an absence of one.
  assert.equal(planSweepAction(row, { now: NOW, freshAgents: new Set() }).kind, 'release');
});

test('a LIVE chat is never yanked back into the line by the sweep', () => {
  // The handoff is a compare-and-set on the CURRENT holder and a deliberate
  // act. Restarting a half-finished conversation with a stranger is not one.
  const row = session({ status: 'live', claimed_by: 'carla@simple.biz', last_seen_at: seenAgo(2_000) });
  assert.equal(planSweepAction(row, { now: NOW, freshAgents: new Set() }).kind, 'keep');
});

test("a 'claimed' row naming no holder is unreleasable, not releasable-to-nobody", () => {
  // Illegal per SQL :160-162, but this module is also handed JSON. There is
  // nothing to compare-and-set against, so nothing is written.
  const row = session({ status: 'claimed', claimed_by: null, last_seen_at: seenAgo(2_000) });
  assert.deepEqual(planSweepAction(row, noAgents), {
    kind: 'keep',
    sessionId: 'sess-1',
    because: 'unreadable',
  });
});

/* ───────────────────────────── idempotence ───────────────────────────────── */

test('SWEEPING TWICE MINTS ONE TICKET: a stamped session is settled forever', () => {
  const gone = seenAgo(EMPLOYEE_STALE_AFTER_MS + 60_000);

  // First read: the flip is owed.
  const before = session({ status: 'waiting', last_seen_at: gone });
  assert.equal(planSweepAction(before, noAgents).kind, 'convert');

  // The caller flips (guarded, status IN ('waiting','claimed')), mints, stamps.
  const after = session({ status: 'abandoned', last_seen_at: gone, became_ticket_id: 'tkt-1' });

  // Second read, third read, a week of reads: nothing more to do.
  for (const ctx of [noAgents, { now: new Date(NOW.getTime() + 7 * 86_400_000), freshAgents: null }]) {
    assert.deepEqual(planSweepAction(after, ctx), {
      kind: 'keep',
      sessionId: 'sess-1',
      because: 'settled',
    });
  }
  assert.deepEqual(planSweep([after], noAgents).converts, []);
});

test('a flip whose stamp never landed is COMPLETED, never re-converted', () => {
  // The crash window: status flipped, ticket id missing. That employee is
  // already owed a number. Re-minting is the one unrecoverable mistake.
  const orphan = session({
    status: 'abandoned',
    became_ticket_id: null,
    last_seen_at: seenAgo(10_000),
    ended_at: seenAgo(SWEEP_COMPLETE_GRACE_MS + 1_000),
  });
  assert.deepEqual(planSweepAction(orphan, noAgents), { kind: 'complete', sessionId: 'sess-1' });

  const plan = planSweep([orphan], noAgents);
  assert.equal(plan.completes.length, 1);
  assert.equal(plan.converts.length, 0);
});

test('a JUST-flipped session is left to the reader that won the flip', () => {
  // The flip is a compare-and-set, so one reader is already minting. A second
  // reader that finished the job inside this window could mint a duplicate —
  // the single outcome the whole design exists to prevent.
  const inFlight = session({
    status: 'abandoned',
    became_ticket_id: null,
    last_seen_at: seenAgo(10_000),
    ended_at: seenAgo(SWEEP_COMPLETE_GRACE_MS - 1_000),
  });
  assert.deepEqual(planSweepAction(inFlight, noAgents), {
    kind: 'keep',
    sessionId: 'sess-1',
    because: 'in_flight',
  });
  assert.deepEqual(planSweep([inFlight], noAgents).completes, []);
});

test('an abandoned session with no readable flip stamp is never acted on', () => {
  // `..._ended_has_stamp` (SQL :168-169) makes this row impossible, so one that
  // reaches here is a row we do not understand — and every act available is
  // destructive.
  for (const stamp of [null, 'not a timestamp']) {
    const broken = session({ status: 'abandoned', became_ticket_id: null, ended_at: stamp });
    assert.deepEqual(planSweepAction(broken, noAgents), {
      kind: 'keep',
      sessionId: 'sess-1',
      because: 'unreadable',
    });
  }
});

test('an ended session is never reopened by a later read', () => {
  const ended = session({ status: 'ended', last_seen_at: seenAgo(86_400_000) });
  assert.deepEqual(planSweepAction(ended, noAgents), {
    kind: 'keep',
    sessionId: 'sess-1',
    because: 'settled',
  });
});

test("the concern marker is a usable natural key: ESC-104 cannot adopt ESC-1043's ticket", () => {
  assert.equal(chatTicketMarker(1043), '[ESC-1043]');
  assert.equal(chatTicketConcernPattern(1043), '[ESC-1043]%');

  const concern = buildChatTicketConcern({
    sessionNo: 1043,
    queuedAt: '2026-09-19T14:00:00.000Z',
    messages: [line()],
  });

  // What the builder writes is what the recovery lookup finds. `%` is a
  // trailing wildcard, so simulating ILIKE is a case-insensitive startsWith.
  const matches = (pattern: string, text: string) =>
    text.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase());

  assert.ok(matches(chatTicketConcernPattern(1043), concern));
  // The closing bracket is what makes it unambiguous.
  assert.equal(matches(chatTicketConcernPattern(104), concern), false);
  assert.equal(matches(chatTicketConcernPattern(10430), concern), false);
});

/* ─────────────────────── the ticket the chat becomes ─────────────────────── */

test('the concern is NEVER empty, even when the employee typed nothing', () => {
  // `employee_support_tickets_concern_present` (length(btrim(concern)) > 0) is
  // a CHECK, and an employee who queued and waited in silence is a real case.
  const concern = buildChatTicketConcern({
    sessionNo: 7,
    queuedAt: '2026-09-19T14:00:00.000Z',
    messages: [],
  });
  assert.ok(concern.trim().length > 0);
  assert.ok(concern.startsWith('[ESC-7]'));
});

test('the concern is NEVER over the 4000-char CHECK, however long the chat ran', () => {
  const many = Array.from({ length: 400 }, (_, i) =>
    line({ body: `message ${i} — ${'x'.repeat(80)}` }),
  );
  const concern = buildChatTicketConcern({
    sessionNo: 1043,
    queuedAt: '2026-09-19T14:00:00.000Z',
    messages: many,
  });

  assert.ok(concern.length <= SUPPORT_CONCERN_MAX, `concern was ${concern.length}`);
  assert.ok(concern.startsWith('[ESC-1043]'));
  // Whatever was dropped, the reader is told where the whole thing lives —
  // Kane's Q2: the full transcript persists on the chat session.
  assert.ok(concern.includes('the full transcript is kept on chat ESC-1043'));
});

test('one enormous message still contributes its opening, and still fits', () => {
  const concern = buildChatTicketConcern({
    sessionNo: 1043,
    queuedAt: '2026-09-19T14:00:00.000Z',
    messages: [line({ body: `PAYSLIP PROBLEM ${'y'.repeat(6000)}` })],
  });
  // EXACTLY the cap, not merely under it: this branch fills the budget to the
  // last character, so it is the one that catches an off-by-one, and a
  // 4001-character concern is a CHECK violation rather than a rounding error.
  assert.equal(concern.length, SUPPORT_CONCERN_MAX);
  // The beginning of the question is the part that identifies it.
  assert.ok(concern.includes('PAYSLIP PROBLEM'));
  assert.ok(concern.includes('the full transcript is kept on chat ESC-1043'));
});

test('a short chat is carried whole, with no truncation notice attached', () => {
  const concern = buildChatTicketConcern({
    sessionNo: 12,
    queuedAt: '2026-09-19T14:00:00.000Z',
    messages: [line({ body: 'Where is my payslip?' }), line({ author_side: 'system', body: 'The employee left the chat.' })],
  });
  assert.ok(concern.includes('Employee: Where is my payslip?'));
  assert.ok(concern.includes('System: The employee left the chat.'));
  assert.equal(concern.includes('truncated'), false);
});

test('the ticket copies identity from the SESSION and claims nothing', () => {
  const draft = buildChatTicket({ session: session(), messages: [line()] });

  assert.equal(draft.work_email, 'rowan@simple.biz');
  assert.equal(draft.filed_by_email, 'rowan@simple.biz');
  assert.equal(draft.member_name, 'Rowan Diaz');
  // RAW master-list key, never a label (dept-label-display-sweep).
  assert.equal(draft.department, 'hsl:intake_specialist');
  assert.equal(draft.category, CHAT_TICKET_CATEGORY);
  assert.equal(draft.category, 'other');

  // Nobody picked this up — that is the entire reason it exists. A draft that
  // carried a status or a claimant would let the polling agent own it.
  assert.equal('status' in draft, false);
  assert.equal('claimed_by' in draft, false);
  assert.equal('claimed_at' in draft, false);
  assert.equal('first_response_at' in draft, false);
});

test('a screening flag follows the question onto the ticket, both halves or neither', () => {
  const clean = buildChatTicket({ session: session(), messages: [line()] });
  assert.equal(clean.flagged_at, null);
  assert.equal(clean.flag_reason, null);

  const flagged = buildChatTicket({
    session: session(),
    messages: [
      line(),
      line({ body: 'this is unacceptable', flagged_at: '2026-09-19T14:02:00.000Z', flag_reason: 'strong language' }),
    ],
  });
  // The ORIGINAL stamp — the screen ran when the message was typed, not now.
  assert.equal(flagged.flagged_at, '2026-09-19T14:02:00.000Z');
  assert.ok(flagged.flag_reason?.includes('strong language'));
  assert.ok(flagged.flag_reason?.includes('ESC-1043'));

  // employee_support_tickets_flag_both_or_neither, by construction.
  for (const draft of [clean, flagged]) {
    assert.equal(draft.flagged_at === null, draft.flag_reason === null);
  }

  // Half a flag on a message is not a flag: both columns must be present.
  const halfFlagged = buildChatTicket({
    session: session(),
    messages: [line({ flagged_at: '2026-09-19T14:02:00.000Z', flag_reason: '   ' })],
  });
  assert.equal(halfFlagged.flagged_at, null);
  assert.equal(halfFlagged.flag_reason, null);
});

/* ─────────────────────────── what the employee reads ─────────────────────── */

test('the employee is never told they were "abandoned"', () => {
  const copy = [
    becameTicketSystemLine(1043),
    becameTicketNotification({ sessionNo: 12, ticketNo: 1043 }).title,
    becameTicketNotification({ sessionNo: 12, ticketNo: 1043 }).message,
  ].join(' ');

  // Nobody abandoned them. The queue closed and their question became a ticket,
  // which is a promise being kept (chat-types.ts:56-59).
  for (const word of ['abandon', 'expired', 'failed', 'timed out']) {
    assert.equal(copy.toLowerCase().includes(word), false, `copy said "${word}"`);
  }
  // It leads with the number and the promise, which is the whole message.
  assert.ok(copy.includes('ES-1043'));
  assert.ok(copy.includes('within one working day'));
});

test('a ticket number that never resolved still produces readable copy', () => {
  // The ES- number is looked up separately and that read can fail. The copy
  // must degrade, not render "ES-null".
  const { title, message } = becameTicketNotification({ sessionNo: 12, ticketNo: null });
  assert.equal(title.includes('null'), false);
  assert.equal(message.includes('undefined'), false);
  assert.ok(title.includes('ES-'));
  assert.equal(becameTicketSystemLine(null).includes('null'), false);
});

/* ────────────────────────────── the budget ───────────────────────────────── */

test('the caps bound one read and DEFER the rest — nothing is dropped', () => {
  const gone = EMPLOYEE_STALE_AFTER_MS + 60_000;
  const rows: SweepSessionRow[] = [
    ...Array.from({ length: 25 }, (_, i) =>
      session({ id: `conv-${i}`, status: 'waiting', last_seen_at: seenAgo(gone + i) }),
    ),
    ...Array.from({ length: 70 }, (_, i) =>
      session({
        id: `rel-${i}`,
        status: 'claimed',
        claimed_by: 'ghost@simple.biz',
        last_seen_at: seenAgo(2_000),
      }),
    ),
  ];

  const plan = planSweep(rows, { now: NOW, freshAgents: new Set() });

  assert.equal(plan.converts.length, SWEEP_CONVERT_MAX);
  assert.equal(plan.releases.length, SWEEP_ACTION_MAX);
  assert.equal(plan.deferred, 25 - SWEEP_CONVERT_MAX + (70 - SWEEP_ACTION_MAX));
  // The backlog is stated, not silent: a caller can say so out loud.
  assert.ok(plan.deferred > 0);
});

test('the budget is spent longest-gone first, and completes outrank converts', () => {
  const rows: SweepSessionRow[] = [
    session({ id: 'recent', status: 'waiting', last_seen_at: seenAgo(EMPLOYEE_STALE_AFTER_MS + 1_000) }),
    session({ id: 'ancient', status: 'waiting', last_seen_at: seenAgo(EMPLOYEE_STALE_AFTER_MS + 900_000) }),
    session({
      id: 'orphan',
      status: 'abandoned',
      became_ticket_id: null,
      last_seen_at: seenAgo(1_000),
      ended_at: seenAgo(SWEEP_COMPLETE_GRACE_MS + 1_000),
    }),
  ];

  const plan = planSweep(rows, noAgents);
  // The orphan is an employee ALREADY owed a number, despite the freshest stamp.
  assert.deepEqual(plan.completes.map((a) => a.sessionId), ['orphan']);
  assert.deepEqual(plan.converts.map((a) => a.sessionId), ['ancient', 'recent']);
});

test('planning the same set twice plans it identically', () => {
  const rows = Array.from({ length: 40 }, (_, i) =>
    session({
      id: `s-${String(i).padStart(3, '0')}`,
      status: 'waiting',
      // Deliberately tied stamps, so only the id tiebreak separates them.
      last_seen_at: seenAgo(EMPLOYEE_STALE_AFTER_MS + 5_000),
    }),
  );
  const a = planSweep(rows, noAgents);
  const b = planSweep([...rows].reverse(), noAgents);

  // Two agents polling at the same instant must race over the SAME rows, not
  // scatter guarded UPDATEs across forty of them.
  assert.deepEqual(
    a.converts.map((x) => x.sessionId),
    b.converts.map((x) => x.sessionId),
  );
});

test('planSweep never mutates the array it was handed', () => {
  const rows = [
    session({ id: 'b', last_seen_at: seenAgo(10_000) }),
    session({ id: 'a', last_seen_at: seenAgo(20_000) }),
  ];
  const order = rows.map((r) => r.id);
  planSweep(rows, noAgents);
  assert.deepEqual(rows.map((r) => r.id), order);
});

test('a quiet queue plans nothing at all', () => {
  const plan = planSweep(
    [session(), session({ id: 'x', status: 'live', claimed_by: 'carla@simple.biz' })],
    { now: NOW, freshAgents: new Set(['carla@simple.biz']) },
  );
  assert.deepEqual(plan, { completes: [], converts: [], releases: [], ends: [], deferred: 0 });
});
