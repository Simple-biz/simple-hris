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
  {
    question: 'What is my hourly rate?',
    short: "What's my rate?",
    tool: 'get_my_profile',
  },
  {
    question: 'What is the overtime policy?',
    short: 'Overtime policy?',
    tool: 'get_company_policies',
  },
  {
    question: 'Who is my manager?',
    short: 'Who is my manager?',
    tool: 'get_my_contacts',
  },
  {
    question: 'Has my leave request been approved?',
    short: 'Is my leave approved?',
    tool: 'get_my_leave_requests',
  },
];

/** How many the greeting balloon offers (Kane, 2026-08-19: five). */
export const GREETING_FAQ_COUNT = 5;

/** Where the previous load's picks are remembered, so the next one can differ. */
export const GREETING_LAST_SHOWN_KEY = 'penny_faq_last_shown';

/** Delay before the greeting appears, per Kane's spec. */
export const GREETING_DELAY_MS = 5_000;

/**
 * How long the balloon stays before retreating on its own. A proactive bubble
 * that never leaves stops being an offer and becomes furniture sitting on top of
 * the dashboard.
 */
export const GREETING_AUTOHIDE_MS = 22_000;

export const GREETING_TEXT = 'Hi 👋 Anything I can help you with?';

/**
 * The subset shown in the balloon — deterministic. Kept for the panel's empty
 * state and as the SSR-stable default; the balloon itself uses {@link pickFaqs}.
 */
export function greetingFaqs(count = GREETING_FAQ_COUNT): PennyFaq[] {
  return EMPLOYEE_FAQS.slice(0, Math.max(0, count));
}

/**
 * Pick `count` FAQs that share nothing with `exclude` — the previous page load's
 * picks (Kane, 2026-08-19: *"each time refresh should be different"*).
 *
 * Excluding rather than merely shuffling makes "different" a **guarantee** and not
 * a probability: random selection can repeat, and a repeat is exactly what would
 * read as broken. With a pool of 12 and 5 shown there are always 7 unexcluded
 * entries left, so a full fresh set is always available.
 *
 * The exclusion is best-effort by design — if the pool ever shrinks below
 * `count + exclude.length`, it tops up from the excluded ones rather than
 * returning a short list. A greeting with three chips because the maths ran out
 * would be a worse bug than a repeated chip.
 *
 * `rng` is injectable so the behaviour is testable; production passes none.
 */
export function pickFaqs(
  count = GREETING_FAQ_COUNT,
  exclude: readonly string[] = [],
  rng: () => number = Math.random,
): PennyFaq[] {
  const want = Math.max(0, Math.min(count, EMPLOYEE_FAQS.length));
  if (want === 0) return [];

  const blocked = new Set(exclude);
  const fresh = shuffle(
    EMPLOYEE_FAQS.filter((f) => !blocked.has(f.question)),
    rng,
  );
  const picked = fresh.slice(0, want);

  if (picked.length < want) {
    // Pool too small to avoid every previous pick — top up from the rest rather
    // than showing fewer chips than asked for.
    const used = new Set(picked.map((f) => f.question));
    const leftovers = shuffle(
      EMPLOYEE_FAQS.filter((f) => !used.has(f.question)),
      rng,
    );
    picked.push(...leftovers.slice(0, want - picked.length));
  }
  return picked;
}

/** Fisher–Yates, on a copy. */
function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Read the previous load's picks. Returns [] on anything unexpected. */
export function readLastShown(storage: Pick<Storage, 'getItem'> | null): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(GREETING_LAST_SHOWN_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

/** Remember this load's picks so the next one can avoid them. */
export function writeLastShown(
  storage: Pick<Storage, 'setItem'> | null,
  faqs: readonly PennyFaq[],
): void {
  if (!storage) return;
  try {
    storage.setItem(GREETING_LAST_SHOWN_KEY, JSON.stringify(faqs.map((f) => f.question)));
  } catch {
    /* private mode — rotation degrades to "random each load", which is fine */
  }
}

/**
 * Every question in the pool.
 *
 * NOT what any surface renders. The panel's empty state used to list all of them
 * and at twelve entries that was a scrolling wall of buttons (Kane, 2026-08-19:
 * *"There is a lot in here"*) — both the balloon and the panel now show the same
 * five from {@link pickFaqs}. Kept for the pool-integrity tests, and because
 * "what could Penny be asked?" is a question worth being able to answer in one call.
 */
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
