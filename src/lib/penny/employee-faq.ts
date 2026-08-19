/**
 * The FAQ Penny offers an employee unprompted — and the rule that keeps it honest.
 *
 * Kane, 2026-08-19: five seconds after the employee dashboard loads, the chat
 * bubble asks whether it can help, offering *"at least 5 unique messages that
 * Penny can achieve"*.
 *
 * That last clause is the whole constraint. A proactive greeting is a promise:
 * unlike a typed question, Penny CHOSE to raise it. Offering "How much leave do I
 * have left?" — which this HRIS cannot answer, because it tracks no balance —
 * would burn one of the employee's ten prompts to say "I can't". So every entry
 * here names the tool that answers it, and a test asserts that tool exists in
 * `EMPLOYEE_TOOLS`. A question with no tool behind it cannot be added.
 *
 * Ordering is deliberate: the questions people actually ask come first, because
 * the greeting balloon only has room for a few.
 */

export interface PennyFaq {
  /** The exact text sent as the employee's message when they tap it. */
  question: string;
  /** Short label for the compact greeting balloon. */
  short: string;
  /** The tool that answers it — pinned against EMPLOYEE_TOOLS by a test. */
  tool: string;
}

export const EMPLOYEE_FAQS: PennyFaq[] = [
  {
    question: 'When is the PAB and how do I get it?',
    short: 'When is the PAB?',
    tool: 'get_my_bonus_status',
  },
  {
    question: 'When do I get paid?',
    short: 'When do I get paid?',
    tool: 'get_my_pay_schedule',
  },
  {
    question: 'What was my last pay?',
    short: 'What was my last pay?',
    tool: 'get_my_pay',
  },
  {
    question: 'How do I request a Certificate of Engagement?',
    short: 'How do I get a COE?',
    tool: 'get_company_how_to_guides',
  },
  {
    question: 'How do I file a leave request, and how much notice do I need?',
    short: 'How do I file a leave?',
    tool: 'get_company_how_to_guides',
  },
  {
    question: 'When do I receive my tech bonus?',
    short: 'When is my tech bonus?',
    tool: 'get_my_bonus_status',
  },
  {
    question: 'Where do I download my pay stubs?',
    short: 'Where are my pay stubs?',
    tool: 'get_company_how_to_guides',
  },
  {
    question: 'What holidays are coming up?',
    short: 'Upcoming holidays?',
    tool: 'get_company_benefits',
  },
];

/**
 * How many the greeting balloon offers. Three fits the 380px panel width without
 * the balloon becoming a menu — the rest stay available in the panel's own empty
 * state, so nothing is lost by keeping the interruption small.
 */
export const GREETING_FAQ_COUNT = 3;

/** Delay before the greeting appears, per Kane's spec. */
export const GREETING_DELAY_MS = 5_000;

/**
 * How long the balloon stays before retreating on its own. A proactive bubble
 * that never leaves stops being an offer and becomes furniture sitting on top of
 * the dashboard.
 */
export const GREETING_AUTOHIDE_MS = 22_000;

export const GREETING_TEXT = 'Hi 👋 Anything I can help you with?';

/** The subset shown in the balloon. */
export function greetingFaqs(count = GREETING_FAQ_COUNT): PennyFaq[] {
  return EMPLOYEE_FAQS.slice(0, Math.max(0, count));
}

/** Every question, for the panel's empty state. */
export function allFaqQuestions(): string[] {
  return EMPLOYEE_FAQS.map((f) => f.question);
}

/* ── When the balloon may be on screen ────────────────────────────────────── */

export interface GreetingVisibilityInput {
  /** The delay has elapsed and nothing has cancelled it yet. */
  armed: boolean;
  /** The chat panel is open. */
  panelOpen: boolean;
  /** The daily allowance is spent. */
  quotaExhausted: boolean;
  /** The shell has hidden the whole widget (e.g. the full Penny tab is open). */
  widgetHidden: boolean;
  /** Messages already in the transcript. */
  messageCount: number;
}

/**
 * Every reason NOT to speak, in one pure predicate.
 *
 * This lives here, away from the component, because it is the part that must not
 * rot: the timer effects in `CeoChatBubble` cannot be gated reliably (a five-second
 * fuse outlives any state they could close over), so this render-time check is the
 * only real gate. Keeping it pure means it is also the only part that can be
 * tested — and the exhausted-allowance case in particular is one nobody would
 * think to click through by hand.
 *
 * **Add new suppression reasons here, not to a timer.**
 */
export function shouldShowGreeting(input: GreetingVisibilityInput): boolean {
  if (!input.armed) return false;
  // Already talking to Penny — an offer to help is noise on top of a conversation.
  if (input.panelOpen) return false;
  if (input.messageCount > 0) return false;
  // Out of prompts: inviting a question they cannot ask is worse than silence.
  if (input.quotaExhausted) return false;
  if (input.widgetHidden) return false;
  return true;
}
