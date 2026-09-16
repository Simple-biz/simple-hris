/**
 * Employee Support — the one vocabulary module.
 *
 * Every category, status and label this feature uses is declared here and
 * nowhere else, the way profile-tabs.ts is the single vocabulary for the
 * employee Profile tabs. The employee form, the staff section, the routing rule
 * and the CHECK constraint in
 * references/sql/create/2026-09-16_employee_support.sql must all agree; the way
 * they are kept agreeing is that three of them read this file and the fourth is
 * pinned to it by a test.
 *
 * Approved by Carla 2026-09-15. Plan:
 * docs/superpowers/plans/2026-09-14-employee-support.md
 */

/** Ticket lifecycle. Mirrors the status CHECK on employee_support_tickets. */
export const SUPPORT_STATUSES = ['open', 'claimed', 'answered', 'closed'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

/**
 * Carla's Decision 4 list, in the order the form offers them.
 *
 * Note what is NOT here: schedules and time-off. She ruled those "a manager
 * question", so there is deliberately no category to file them under — see
 * STEERED_SUBJECTS below, which is how the form says so.
 */
export const SUPPORT_CATEGORIES = [
  'pay_payslip',
  'bonus_pab',
  'hours_time_adjustment',
  'bank_payout',
  'documents_certificates',
  'gmail',
  'hubstaff',
  'roboform',
  'other',
] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const SUPPORT_CATEGORY_LABELS: Record<SupportCategory, string> = {
  pay_payslip: 'Pay or payslip',
  bonus_pab: 'Bonus or PAB',
  hours_time_adjustment: 'Hours or time adjustment',
  bank_payout: 'Bank or payout details',
  documents_certificates: 'Documents and certificates',
  gmail: 'Gmail issue',
  hubstaff: 'Hubstaff issue',
  roboform: 'Roboform issue',
  other: 'Something else',
};

/**
 * Status label and chip tone kept as two parallel Records rather than one
 * object, matching TimeAdjustmentDialog's habit: the wording and the colour are
 * edited by different people at different times and must not be able to drift
 * into disagreeing about what a status means.
 */
export const SUPPORT_STATUS_LABELS: Record<SupportStatus, string> = {
  open: 'Waiting',
  claimed: 'Being looked at',
  answered: 'Answered',
  closed: 'Closed',
};

/**
 * 'waiting' deliberately reads amber and not red. A question nobody has picked
 * up yet inside the promised day is the system working, not a failure.
 */
export const SUPPORT_STATUS_TONE: Record<SupportStatus, 'waiting' | 'active' | 'good' | 'neutral'> = {
  open: 'waiting',
  claimed: 'active',
  answered: 'good',
  closed: 'neutral',
};

/** Which side of the conversation wrote a message. Never derived from a live grant. */
export const SUPPORT_AUTHOR_SIDES = ['employee', 'staff'] as const;
export type SupportAuthorSide = (typeof SUPPORT_AUTHOR_SIDES)[number];

/**
 * The five people Carla named on 2026-09-15 answer these. They are listed here
 * for documentation only — authorization is the `employee_support` feature
 * grant, read live, never this array. A name here grants nothing and a name
 * missing from here denies nothing; if the two ever disagree, the grant wins
 * and this comment is what is out of date.
 */
export const SUPPORT_ANSWERERS_AS_APPROVED = [
  'Carla',
  'Claire',
  'Ainsley',
  'Grace',
  'Alivia',
] as const;

/** Carla's Decision 5, shown to the employee when they file. Displayed, not enforced. */
export const SUPPORT_REPLY_PROMISE = 'within one working day';

/** The DB backstop is 4000; the form stops here so the refusal is a message, not a 500. */
export const SUPPORT_CONCERN_MAX = 4000;

export function isSupportCategory(value: unknown): value is SupportCategory {
  return typeof value === 'string' && (SUPPORT_CATEGORIES as readonly string[]).includes(value);
}

export function isSupportStatus(value: unknown): value is SupportStatus {
  return typeof value === 'string' && (SUPPORT_STATUSES as readonly string[]).includes(value);
}

/** `ES-1043`. One formatter, so the employee's copy and the staff row cannot differ. */
export function formatSupportTicketNo(ticketNo: number | null | undefined): string {
  if (typeof ticketNo !== 'number' || !Number.isFinite(ticketNo)) return 'ES-—';
  return `ES-${Math.trunc(ticketNo)}`;
}

/**
 * A ticket is waiting on US when it has had no staff reply yet, whatever its
 * status says. Used for the staff section's default filter and for the
 * employee's unread badge, so "needs a reply" means one thing in both places.
 */
export function needsStaffReply(t: { status: SupportStatus; first_response_at: string | null }): boolean {
  if (t.status === 'closed') return false;
  return t.first_response_at === null;
}
