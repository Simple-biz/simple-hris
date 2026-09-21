/**
 * Employee Support LIVE CHAT — the one vocabulary module.
 *
 * Every status, author side and label the chat surface uses is declared here and
 * nowhere else, exactly as `types.ts` does it for the ticket side. The employee
 * dialog, the agent tab, the routes and the CHECK constraints in
 * references/sql/create/2026-09-19_employee_support_chat.sql must all agree; the
 * way they are kept agreeing is that three of them read this file and the fourth
 * is pinned to it by a test.
 *
 * Plan: docs/superpowers/plans/2026-09-19-employee-support-chat.md (task 7).
 * Kane approved the four rulings 2026-09-19; the chat is being built ahead of the
 * ticket side by his override of Carla's signed Decision 2 — see the plan header.
 */

/**
 * Session lifecycle. Mirrors `employee_support_chat_sessions_status_valid`
 * (SQL :113-115).
 *
 * `ended` and `abandoned` BOTH carry an `ended_at`, and the difference between
 * them is not derivable from the stamps — only `status` says which happened. An
 * `abandoned` session is the one that becomes a ticket (Kane's Q1); an `ended`
 * one was a real conversation that finished.
 */
export const CHAT_SESSION_STATUSES = ['waiting', 'claimed', 'live', 'ended', 'abandoned'] as const;
export type ChatSessionStatus = (typeof CHAT_SESSION_STATUSES)[number];

/**
 * The three statuses in which a session still occupies the queue or an agent.
 * The SQL's partial indexes are built on exactly this set (SQL :198, :222) — if
 * this list and those indexes ever disagree, the reads stop using the index and
 * nothing tells you.
 */
export const CHAT_OPEN_STATUSES = ['waiting', 'claimed', 'live'] as const;

export function isOpenChatSession(status: ChatSessionStatus): boolean {
  return (CHAT_OPEN_STATUSES as readonly string[]).includes(status);
}

/**
 * Who wrote a message. Mirrors SQL :244.
 *
 * `system` exists so the transcript can carry "this chat was converted to ticket
 * ES-1043" as part of the conversation rather than as chrome around it — the
 * employee reads one thread, not a thread plus a banner. A `system` row has a
 * NULL author_email and the SQL enforces that both-or-neither (SQL :267).
 */
export const CHAT_AUTHOR_SIDES = ['employee', 'agent', 'system'] as const;
export type ChatAuthorSide = (typeof CHAT_AUTHOR_SIDES)[number];

/**
 * What the EMPLOYEE reads. These are Kane's track-map stops (his 2026-09-18
 * ruling: "a track map on what is the status of their tickets depending on the
 * status in Kanban"), and they are deliberately written in the employee's
 * language rather than the schema's.
 *
 * `abandoned` does not say "abandoned" to the person who waited. Nobody
 * abandoned them — the queue closed and their question became a ticket, which is
 * a promise being kept, not a failure.
 */
export const CHAT_SESSION_STATUS_LABELS: Record<ChatSessionStatus, string> = {
  waiting: 'Waiting in line',
  claimed: 'An agent is joining',
  live: 'In conversation',
  ended: 'Finished',
  abandoned: 'Became a ticket',
};

/** What the AGENT reads on the queue. The same row, the other side of the desk. */
export const CHAT_SESSION_STATUS_LABELS_AGENT: Record<ChatSessionStatus, string> = {
  waiting: 'Waiting',
  claimed: 'Claimed',
  live: 'Live',
  ended: 'Ended',
  abandoned: 'Converted to ticket',
};

/**
 * Tone and label are two parallel Records rather than one object, matching
 * `types.ts:58-72` and `TimeAdjustmentDialog`'s habit: the wording and the colour
 * are edited by different people at different times and must not be able to
 * drift into disagreeing about what a status means.
 *
 * `waiting` reads amber and not red. Somebody in the queue inside the support
 * window is the system working.
 */
export const CHAT_SESSION_STATUS_TONE: Record<
  ChatSessionStatus,
  'waiting' | 'active' | 'good' | 'neutral'
> = {
  waiting: 'waiting',
  claimed: 'active',
  live: 'active',
  ended: 'neutral',
  abandoned: 'good',
};

/**
 * The DB backstop is 4000 (SQL :276); the composer stops here so the refusal is a
 * message the employee can act on rather than a 500 they cannot.
 */
export const CHAT_MESSAGE_MAX = 4000;

/**
 * `ESC-1043`. Deliberately NOT the ticket side's `ES-` prefix.
 *
 * A chat session and the ticket it may become are two different objects with two
 * different identity series, and they will be discussed in the same sentence by
 * the same five people. One prefix for both would make "did you see 1043?"
 * ambiguous in exactly the conversation where it matters — see
 * `formatSupportTicketNo` in `types.ts:110-113` for the sibling, and the SQL
 * header for why the series are separate.
 */
export function formatChatSessionNo(sessionNo: number | null | undefined): string {
  if (typeof sessionNo !== 'number' || !Number.isFinite(sessionNo)) return 'ESC-—';
  return `ESC-${Math.trunc(sessionNo)}`;
}

export function isChatSessionStatus(value: unknown): value is ChatSessionStatus {
  return typeof value === 'string' && (CHAT_SESSION_STATUSES as readonly string[]).includes(value);
}

export function isChatAuthorSide(value: unknown): value is ChatAuthorSide {
  return typeof value === 'string' && (CHAT_AUTHOR_SIDES as readonly string[]).includes(value);
}

/**
 * Whether this session still needs an AGENT to arrive, as opposed to one already
 * being here. Used by the queue count and by the employee's own copy, so "still
 * waiting" means one thing in both places — the same job `needsStaffReply` does
 * on the ticket side (`types.ts:115-123`).
 */
export function needsAnAgent(status: ChatSessionStatus): boolean {
  return status === 'waiting';
}
