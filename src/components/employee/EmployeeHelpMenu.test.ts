import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  IDLE_TICKETS_BADGE,
  TICKET_DOOR_COPY,
  chatDoorHint,
  describeChatDoor,
  helpBadgeFor,
  helpLabelFor,
  ticketDoorHint,
  type SupportTicketsBadgeState,
} from './EmployeeHelpMenu';
import type { SupportChatState } from './EmployeeSupportChat';

/**
 * The HELP chooser (Kane, 2026-09-21: "Instead of Chat change that to Help
 * where they can choose between a Chat Support or a Ticket").
 *
 * Two blocks. The first pins the pure rules — how two surfaces fold into one
 * badge, what the label says, what each door says — because those are the
 * decisions, and a render only implies them. The second is a source scan in
 * the `employee-faq.test.ts` idiom over the two files this feature touches,
 * pinning the shape the header comments promise: both clusters, one component,
 * no `99+` clamp, no floating corner, no Manila formatter, and the chat button
 * this replaces no longer rendered by the dashboard.
 */

const HERE = join(process.cwd(), 'src/components/employee');
const MENU = readFileSync(join(HERE, 'EmployeeHelpMenu.tsx'), 'utf8');
const DASHBOARD = readFileSync(join(HERE, 'EmployeeDashboard.tsx'), 'utf8');

/**
 * The menu with its comments removed.
 *
 * The forbidden-token scans below run against THIS and not the raw file,
 * because the raw file's header is where the rules are written down: it names
 * `99+`, `describeSupportHours`, Manila and "fixed bottom-right control" in
 * order to forbid them. Scanning the prose would make the guard fire on its
 * own explanation, and the only way to green it would be to delete the
 * reasoning — the opposite of what the guard is for. So the scans read the
 * code, which is what they are actually about.
 */
const MENU_CODE = MENU.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/.*$/gm, '');

function chat(over: Partial<SupportChatState> = {}): SupportChatState {
  return {
    status: 'none',
    position: null,
    queueResolved: false,
    migrated: null,
    needsAttention: false,
    ...over,
  };
}

function tickets(over: Partial<SupportTicketsBadgeState> = {}): SupportTicketsBadgeState {
  return { ...IDLE_TICKETS_BADGE, ...over };
}

/* ─────────────────────────── the badge, folded ─────────────────────────── */

test('nothing on either surface draws nothing', () => {
  assert.deepEqual(helpBadgeFor(chat(), tickets()), { kind: 'none' });
  assert.deepEqual(helpBadgeFor(chat({ status: 'ended' }), tickets()), { kind: 'none' });
});

test('rule 1: an unresolved place in the line is a skeleton, never a number', () => {
  assert.deepEqual(helpBadgeFor(chat({ status: 'waiting', queueResolved: false }), tickets()), {
    kind: 'skeleton',
  });
  // Resolved but null — the route says "we cannot tell" with a resolved flag
  // and a null place. Still a skeleton; there is no path to a 0.
  assert.deepEqual(
    helpBadgeFor(chat({ status: 'waiting', queueResolved: true, position: null }), tickets()),
    { kind: 'skeleton' },
  );
});

test('rule 2: a position is rendered as-is — 100th is 100, not 99+', () => {
  assert.deepEqual(
    helpBadgeFor(chat({ status: 'waiting', queueResolved: true, position: 3 }), tickets()),
    { kind: 'position', position: 3 },
  );
  assert.deepEqual(
    helpBadgeFor(chat({ status: 'waiting', queueResolved: true, position: 100 }), tickets()),
    { kind: 'position', position: 100 },
  );
  assert.deepEqual(
    helpBadgeFor(chat({ status: 'waiting', queueResolved: true, position: 1043 }), tickets()),
    { kind: 'position', position: 1043 },
  );
});

test('a live queue position outranks a waiting ticket reply', () => {
  assert.deepEqual(
    helpBadgeFor(
      chat({ status: 'waiting', queueResolved: true, position: 2 }),
      tickets({ needsAttention: true }),
    ),
    { kind: 'position', position: 2 },
  );
});

test('somebody with them in chat is an emerald dot', () => {
  assert.deepEqual(helpBadgeFor(chat({ status: 'claimed', needsAttention: true }), tickets()), {
    kind: 'dot',
    tone: 'emerald',
  });
  assert.deepEqual(helpBadgeFor(chat({ status: 'live', needsAttention: true }), tickets()), {
    kind: 'dot',
    tone: 'emerald',
  });
});

test('a staff reply waiting on a ticket is an emerald dot, on its own', () => {
  assert.deepEqual(helpBadgeFor(chat(), tickets({ needsAttention: true })), {
    kind: 'dot',
    tone: 'emerald',
  });
});

test('a chat that became a ticket is amber only when that is the sole news', () => {
  assert.deepEqual(helpBadgeFor(chat({ status: 'abandoned', needsAttention: true }), tickets()), {
    kind: 'dot',
    tone: 'amber',
  });
  // A staff reply waiting alongside it wins the tone: it is the more actionable thing.
  assert.deepEqual(
    helpBadgeFor(chat({ status: 'abandoned', needsAttention: true }), tickets({ needsAttention: true })),
    { kind: 'dot', tone: 'emerald' },
  );
  // Abandoned without the ES- number yet: the chat dialog does not flag it, so neither do we.
  assert.deepEqual(helpBadgeFor(chat({ status: 'abandoned', needsAttention: false }), tickets()), {
    kind: 'none',
  });
});

test('migrated:false on its own draws no badge — that is a sentence for the dialog, not a dot', () => {
  assert.deepEqual(helpBadgeFor(chat({ migrated: false }), tickets({ migrated: false })), {
    kind: 'none',
  });
});

/* ─────────────────────────────── the label ─────────────────────────────── */

test('the idle label names both doors and nothing else', () => {
  assert.equal(helpLabelFor(chat(), tickets()), 'Help — chat with Employee Support or raise a ticket');
});

test('the label says every true thing, chat first, and never clamps the place', () => {
  assert.equal(
    helpLabelFor(chat({ status: 'waiting', queueResolved: true, position: 3 }), tickets()),
    'Help — you are 3rd in the chat line',
  );
  assert.equal(
    helpLabelFor(chat({ status: 'waiting', queueResolved: true, position: 111 }), tickets()),
    'Help — you are 111th in the chat line',
  );
  assert.equal(
    helpLabelFor(chat({ status: 'waiting', queueResolved: false }), tickets()),
    'Help — working out your place in the chat line',
  );
  assert.equal(
    helpLabelFor(chat({ status: 'claimed', needsAttention: true }), tickets({ needsAttention: true })),
    'Help — someone is with you in chat; a reply is waiting on a ticket',
  );
  assert.equal(
    helpLabelFor(chat({ status: 'abandoned', needsAttention: true }), tickets()),
    'Help — your chat became a support ticket',
  );
  assert.equal(helpLabelFor(chat(), tickets({ needsAttention: true })), 'Help — a reply is waiting on a ticket');
});

/* ─────────────────────────────── the doors ─────────────────────────────── */

// Wednesday 2026-09-23. 15:00Z is 11 AM EDT (open); 02:00Z is 10 PM EDT the
// evening before (closed). Saturday 2026-09-26 15:00Z is closed by weekday.
const OPEN_INSTANT = new Date('2026-09-23T15:00:00Z');
const CLOSED_EVENING = new Date('2026-09-23T02:00:00Z');
const CLOSED_SATURDAY = new Date('2026-09-26T15:00:00Z');

test('the chat door says open or closed, Eastern only, and that an unanswered chat becomes a ticket', () => {
  const open = describeChatDoor(OPEN_INSTANT);
  assert.match(open, /^Open now, 9 AM – 5 PM Eastern, Mon–Fri\./);
  assert.match(open, /becomes a ticket\.$/);

  for (const at of [CLOSED_EVENING, CLOSED_SATURDAY]) {
    const closed = describeChatDoor(at);
    assert.match(closed, /^Closed right now — 9 AM – 5 PM Eastern, Mon–Fri\./);
    assert.match(closed, /Nobody is likely to join/);
    assert.match(closed, /becomes a ticket\.$/);
  }

  // Kane, 2026-09-19: every employee is on EST. No second zone on this surface.
  for (const at of [OPEN_INSTANT, CLOSED_EVENING]) {
    assert.doesNotMatch(describeChatDoor(at), /Manila/);
  }
  // A live queue never promises a pickup — that sentence belongs to the ticket form.
  assert.doesNotMatch(describeChatDoor(CLOSED_EVENING), /picks it up when they are back/);
});

test('the ticket door states the number and the one-working-day promise', () => {
  assert.equal(TICKET_DOOR_COPY, 'Ask in writing. You get a ticket number and an answer within one working day.');
});

test('door hints: the chat door reflects the line, the ticket door reflects a waiting reply', () => {
  assert.equal(chatDoorHint(chat()), null);
  assert.deepEqual(chatDoorHint(chat({ status: 'waiting', queueResolved: true, position: 2 })), {
    text: 'You are 2nd in line. Your place is kept.',
    tone: 'waiting',
  });
  assert.equal(chatDoorHint(chat({ status: 'waiting', queueResolved: false }))?.tone, 'waiting');
  assert.deepEqual(chatDoorHint(chat({ status: 'live', needsAttention: true })), {
    text: 'Someone is with you now.',
    tone: 'good',
  });
  assert.deepEqual(chatDoorHint(chat({ status: 'abandoned', needsAttention: true })), {
    text: 'Your last chat became a support ticket.',
    tone: 'waiting',
  });
  // Not switched on is a hint, never a lock — the door stays a door.
  assert.deepEqual(chatDoorHint(chat({ migrated: false })), { text: 'Not switched on yet.', tone: 'muted' });

  assert.equal(ticketDoorHint(tickets()), null);
  assert.deepEqual(ticketDoorHint(tickets({ needsAttention: true })), {
    text: 'A reply is waiting for you.',
    tone: 'good',
  });
  assert.deepEqual(ticketDoorHint(tickets({ migrated: false })), { text: 'Not switched on yet.', tone: 'muted' });
  // A waiting reply outranks the migration hint (and cannot coexist with it in practice).
  assert.equal(ticketDoorHint(tickets({ needsAttention: true, migrated: false }))?.tone, 'good');
});

/* ───────────────────────────── source scans ────────────────────────────── */

test('the menu never clamps a position and never reaches for the dual-zone or ticket-promise formatters', () => {
  // Rule 2: 100th in line is the number that tells somebody to raise a ticket instead.
  assert.doesNotMatch(MENU_CODE, /99\+/);
  // Kane, 2026-09-19: every employee is on EST. And a live queue never borrows
  // the ticket form's "someone picks it up when they are back".
  assert.doesNotMatch(
    MENU_CODE,
    /describeSupportHours|describeSupportAvailability|SUPPORT_VIEWER_ZONE|hourInViewerZone|Manila/,
  );
  // The two primitives it IS allowed, so the guard above cannot be satisfied by
  // dropping the hours line altogether.
  assert.match(MENU_CODE, /isSupportOpen/);
  assert.match(MENU_CODE, /SUPPORT_OPEN_HOUR[\s\S]*SUPPORT_CLOSE_HOUR|SUPPORT_CLOSE_HOUR[\s\S]*SUPPORT_OPEN_HOUR/);
});

test('the menu is not a floating launcher — nothing in it is pinned to the viewport', () => {
  // The measured guard behind docs/features/employee-penny-ai.md:143-146: Penny
  // owns the one fixed bottom-right control on the employee side.
  assert.doesNotMatch(MENU_CODE, /\bfixed\b/);
  assert.doesNotMatch(MENU_CODE, /\bsticky\b/);
  // It is anchored to the header button instead, which is what a Popover is.
  assert.match(MENU_CODE, /<PopoverTrigger/);
});

test('the menu offers exactly two doors: Chat Support and Raise a ticket', () => {
  const doors = MENU.match(/<HelpDoor\b/g) ?? [];
  assert.equal(doors.length, 2);
  assert.match(MENU, /title="Chat Support"/);
  assert.match(MENU, /title="Raise a ticket"/);
});

test('the dashboard renders Help in BOTH header clusters, once per variant, and no longer renders the chat-only button', () => {
  const mounts = DASHBOARD.match(/<EmployeeHelpMenu\b/g) ?? [];
  assert.equal(mounts.length, 2, 'one per header cluster');
  assert.match(DASHBOARD, /<EmployeeHelpMenu[\s\S]{0,200}?variant="icon"/);
  assert.match(DASHBOARD, /<EmployeeHelpMenu[\s\S]{0,200}?variant="labelled"/);
  assert.doesNotMatch(DASHBOARD, /SupportChatButton/);
});

test('the dashboard mounts both doors at the root, each fed the same email and each reporting back to the badge', () => {
  assert.match(
    DASHBOARD,
    /<EmployeeSupportChat\s+email=\{email\}\s+dialogOpen=\{supportChatOpen\}\s+onDialogOpenChange=\{setSupportChatOpen\}\s+onStateChange=\{setSupportChatState\}/,
  );
  assert.match(
    DASHBOARD,
    /<EmployeeSupportTickets\s+email=\{email\}\s+dialogOpen=\{supportTicketsOpen\}\s+onDialogOpenChange=\{setSupportTicketsOpen\}\s+onStateChange=\{setSupportTicketsState\}/,
  );
  // Both clusters flip the same two flags, so the doors and the dialogs cannot disagree.
  assert.equal((DASHBOARD.match(/onOpenChat=\{\(\) => setSupportChatOpen\(true\)\}/g) ?? []).length, 2);
  assert.equal((DASHBOARD.match(/onOpenTickets=\{\(\) => setSupportTicketsOpen\(true\)\}/g) ?? []).length, 2);
});
