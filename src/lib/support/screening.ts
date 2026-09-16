/**
 * Language screening for Employee Support.
 *
 * Carla's Decision 4 (2026-09-15): "We should also prescreen any
 * hateful/hurtful language. Unprofessional behavior should be flagged."
 *
 * A FLAG NEVER BLOCKS. THIS IS THE WHOLE DESIGN.
 * ---------------------------------------------------------------------------
 * "Prescreen" can be read as refuse-before-send. It is not implemented that way,
 * and the reason is not squeamishness about the feature: a blocking screen
 * turns every false positive into an employee who cannot report a problem, on
 * the one channel the company built for reporting problems. Someone describing
 * harassment will use the words that were used on them. Someone furious about
 * being underpaid for eleven weeks will not be polite about it. Both of those
 * are the system working.
 *
 * So: screening runs, records what it saw, the ticket is filed either way, and
 * a human on the support side sees the flag next to the text and decides. That
 * is what "flagged" means here — a flag is a note to a reader, never a verdict.
 *
 * Turning a flag into a refusal is a policy change, not a configuration change.
 * It belongs in the plan, with a ruling, before any code.
 *
 * THIS IS A BLUNT INSTRUMENT AND IS MEANT TO BE
 * ---------------------------------------------------------------------------
 * There is no classifier here, and no dictionary of slurs — a repo is a bad
 * place to keep one, and a keyword list is a poor detector regardless: it misses
 * everything phrased politely and fires on quotes, reports, and anger that is
 * entirely warranted. What this does instead is notice a few coarse SIGNALS
 * that a message may need a careful reader, and hand them over as such.
 *
 * Because the output is only ever "a person should look at this", being wrong
 * is cheap in both directions: a false positive costs a reviewer five seconds,
 * and a false negative costs nothing that reading the ticket would not catch.
 * If Carla wants screening that actually judges content, that is a model call
 * on a separate path, with its own decision about what happens on failure — and
 * it would still land here, returning a verdict, never blocking.
 *
 * FAILS OPEN, ALWAYS
 * ---------------------------------------------------------------------------
 * Every path returns a verdict. A bug in screening must never be able to lose a
 * complaint, so the caller treats a throw as "not flagged" and files the ticket.
 */

export type ScreeningSignal =
  | 'strong_language'
  | 'directed_hostility'
  | 'threat'
  | 'shouting';

export type ScreeningVerdict = {
  /** True when a human should read this with attention. Never a reason to refuse. */
  flagged: boolean;
  signals: ScreeningSignal[];
  /** Short, human, stored on the row. Null when nothing fired. */
  reason: string | null;
};

const CLEAN: ScreeningVerdict = { flagged: false, signals: [], reason: null };

/**
 * Coarse profanity. Deliberately generic and deliberately short: this exists to
 * notice heat, not to catalogue offence, and every entry here is a word that is
 * as likely to appear in a legitimately furious message as an abusive one —
 * which is exactly why it flags for a reader instead of refusing.
 */
const STRONG_WORDS = [
  'fuck',
  'shit',
  'bitch',
  'bastard',
  'asshole',
  'dumbass',
];

/** Hostility aimed at a person rather than a situation. */
const DIRECTED_PATTERNS: RegExp[] = [
  /\byou(?:'re| are)\s+(?:an?\s+)?(?:idiot|stupid|useless|incompetent|worthless|liar)\b/i,
  /\b(?:shut up|screw you)\b/i,
  /\byou people\b/i,
];

/** Language that reads as a threat and should reach a human quickly. */
const THREAT_PATTERNS: RegExp[] = [
  /\bi(?:'ll| will| am going to|'m going to)\s+(?:hurt|kill|destroy|report you to|come after)\b/i,
  /\byou(?:'ll| will)\s+(?:regret|pay for)\b/i,
  /\bwatch your back\b/i,
];

function hasStrongWord(text: string): boolean {
  const lower = text.toLowerCase();
  return STRONG_WORDS.some((w) => new RegExp(`\\b${w}\\w*\\b`).test(lower));
}

/**
 * Sustained capitals. Short shouty fragments ("URGENT", "ASAP") are normal and
 * do not count, so this only fires on a long run of upper-case letters.
 */
function isShouting(text: string): boolean {
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length < 40) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length > 0.75;
}

/**
 * Look at one piece of text — a concern or a reply — and say whether a person
 * should read it with attention.
 *
 * Never throws. A caller that somehow reaches a throw should still file.
 */
export function screenText(text: string | null | undefined): ScreeningVerdict {
  try {
    if (typeof text !== 'string') return CLEAN;
    const trimmed = text.trim();
    if (!trimmed) return CLEAN;

    const signals: ScreeningSignal[] = [];
    if (THREAT_PATTERNS.some((p) => p.test(trimmed))) signals.push('threat');
    if (DIRECTED_PATTERNS.some((p) => p.test(trimmed))) signals.push('directed_hostility');
    if (hasStrongWord(trimmed)) signals.push('strong_language');
    if (isShouting(trimmed)) signals.push('shouting');

    if (signals.length === 0) return CLEAN;
    return { flagged: true, signals, reason: describeSignals(signals) };
  } catch {
    // Fails open by construction — see the header. A screening bug must not be
    // able to swallow a complaint.
    return CLEAN;
  }
}

const SIGNAL_WORDS: Record<ScreeningSignal, string> = {
  threat: 'language that reads as a threat',
  directed_hostility: 'hostility aimed at a person',
  strong_language: 'strong language',
  shouting: 'sustained capitals',
};

/**
 * Written for the support staffer who sees it, and phrased so it never reads as
 * a judgement of the person: it says what the text contains, and says outright
 * that it may be justified.
 */
export function describeSignals(signals: ScreeningSignal[]): string {
  const parts = signals.map((s) => SIGNAL_WORDS[s]);
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Contains ${list}. Read it before replying — this may be entirely warranted.`;
}
