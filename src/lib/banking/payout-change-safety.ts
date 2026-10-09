/**
 * Self-service payout changes: the track record of the account on file, the
 * mistakes we can recognise before they cost a payment, and the attestation an
 * employee gives when they change where they are paid.
 *
 * Kane, 2026-10-07: show employees how many times their current account has been
 * paid with no problems, warn them that a change can break their pay (card numbers
 * instead of account numbers, closed accounts, a spouse's or anyone else's account),
 * and keep a record that makes a wrong account the employee's own error rather than
 * an HRIS problem. See docs/features/update-bank-info.md § Payout change safety.
 *
 * PURE: no I/O, no React. Shared by both self-service save routes
 * (`/api/bank-update/save`, `/api/update-employee-ids`), both forms, the track
 * record reader and `scripts/measure-payout-track-record.mts`, so the browser
 * warning and the server refusal can never disagree about what they saw.
 */
import type { ProcessorId } from '@/lib/employee-payment-processors';
import {
  payoutDraftFromIdsRow,
  resolveEffectivePayoutProcessor,
  resolvePreferredAccountNumber,
} from '@/lib/employee/payout-completeness';

// ── The notice and its version ──────────────────────────────────────────────

/**
 * The version of the bank-change notice the employee must acknowledge. The save
 * routes refuse a self-service change that does not echo EXACTLY this string, so
 * a page opened before the notice changed must be reloaded and the new text read.
 * Bump it whenever a word of `PAYOUT_CHANGE_NOTICE` changes: the attestation on
 * record names the version, and a version that maps to two texts proves nothing.
 */
export const PAYOUT_CHANGE_NOTICE_VERSION = '2026-10-07';

/** The notice, word for word. Both forms render it from here. */
export const PAYOUT_CHANGE_NOTICE = {
  title: 'Changing your bank details can stop your pay',
  intro:
    'Payroll sends your pay to exactly what you enter here. If the details are wrong, the payment can bounce, be delayed, or go to someone else, and it cannot always be recovered.',
  rules: [
    'Enter your bank ACCOUNT number, not the 16-digit number printed on your ATM or debit card.',
    'Use an account that is open and active. A closed or dormant account will reject your pay.',
    'The account must be in YOUR OWN name. Do not use a spouse’s, relative’s or friend’s account. Get paid into your own account, then send money to anyone you like after you receive it.',
    'Check every digit before you save.',
  ],
  responsibility:
    'If a payment fails or goes to the wrong person because of details you entered, that is not an HRIS or payroll error, and it may delay your pay until it is sorted out.',
  acknowledgement:
    'I have checked these details. This is my own, open bank account or wallet, and I understand a mistake in them is my responsibility.',
} as const;

// ── The switch (Accounting → System Settings) ───────────────────────────────

/**
 * The `app_settings` key that turns the guardrail off. Kane, 2026-10-09: "add a
 * button in Accounting - System Settings - Where we can disable Guardrail for
 * banks". Only `'off'` turns it off. A missing row, an unreadable row and any
 * other value all mean ON, so the guardrail fails toward ASKING, never toward
 * skipping. `/api/app-settings` accepts only these two values for this key and
 * only from Admin or Accounting → System Settings edit.
 */
export const PAYOUT_GUARDRAIL_KEY = 'banking.payout_guardrail';
export const PAYOUT_GUARDRAIL_VALUES = ['on', 'off'] as const;
export type PayoutGuardrailValue = (typeof PAYOUT_GUARDRAIL_VALUES)[number];

export function isPayoutGuardrailKey(key: string): boolean {
  return key.trim().toLowerCase() === PAYOUT_GUARDRAIL_KEY;
}

/** True (ON) unless the stored value is exactly `'off'`. */
export function parsePayoutGuardrail(raw: string | null | undefined): boolean {
  return raw !== 'off';
}

/**
 * Read the switch off an API payload (`payout_guardrail` / `payoutGuardrail`).
 * Only a literal `false` turns it off: an older server that does not send it,
 * or anything malformed, shows the notice.
 */
export function guardrailFromPayload(raw: unknown): boolean {
  return raw !== false;
}

/**
 * What System Settings says the guardrail does, beside the switch. It lives here,
 * next to the notice and the gate, so the description cannot drift from the code
 * it describes. The notice's own four rules are rendered from
 * `PAYOUT_CHANGE_NOTICE.rules`, not restated.
 */
export const PAYOUT_GUARDRAIL_EXPLAINER = {
  summary:
    'A safety check on employees changing where they are paid. Before a new bank account or wallet is saved, the employee reads a warning about the mistakes that stop pay and confirms the details are their own. A wrong account is then on record as the employee’s error, not an HRIS or payroll one.',
  where: [
    'The public Update Bank Info page (/update-bank-info), reached with a code mailed to the work email.',
    'Employee Dashboard → Profile → Compensation → Payout.',
    'Only employees changing their OWN details. Staff fixing someone else’s row (People tab, Payroll Wizard Readiness) are never asked.',
  ],
  whileOn: [
    'Shows the bank-change notice under the form, with the four rules below.',
    'Save stays disabled until the employee ticks the acknowledgement, and the server refuses a save without it, not just the button.',
    'A new account number that looks like a debit or credit card number (15–19 digits, a card-network prefix, a valid check digit) needs a second tick. The employee confirms; the save is never blocked.',
    'An account holder name without both the employee’s first name and surname (a spouse’s or relative’s account looks like this) needs a tick saying the account is their own. Married names and short forms pass by confirming.',
    'What they confirmed is recorded on the bank change (People → Bank changes → View), and a flagged change carries a Check account chip.',
  ],
  whileOff: [
    'No notice and no tick boxes: the employee saves straight away.',
    'A card-shaped number or a holder-name mismatch is still flagged to Accounting (alert and Check account chip), marked as not confirmed.',
    'The record shows the guardrail was off, so nothing is claimed as acknowledged.',
    'Unchanged: the “Paid N times to this account” line, Accounting’s alert on every change, and the payroll lock (no bank changes while payroll is being processed).',
  ],
  timing:
    'Takes effect on the next save. A page opened while the guardrail was off asks for the tick if it is turned back on before that page saves.',
} as const;

/** What the holder-name confirmation says, word for word (both forms). */
export const HOLDER_CONFIRM_TEXT =
  'This account is in my own name (for example under my married name or a short form of my name). It is not my spouse’s, a relative’s or anyone else’s account.';

// ── Card-shaped numbers ─────────────────────────────────────────────────────

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** The card-network prefixes (IIN ranges) of the cards people actually carry. */
function hasCardNetworkPrefix(digits: string): boolean {
  const p2 = Number(digits.slice(0, 2));
  const p3 = Number(digits.slice(0, 3));
  const p4 = Number(digits.slice(0, 4));
  if (digits.length === 15) return p2 === 34 || p2 === 37; // Amex
  if (digits[0] === '4') return true; // Visa
  if (p2 >= 51 && p2 <= 55) return true; // Mastercard
  if (p4 >= 2221 && p4 <= 2720) return true; // Mastercard 2-series
  if (p4 >= 3528 && p4 <= 3589) return true; // JCB
  if (p4 === 6011 || p2 === 65 || (p3 >= 644 && p3 <= 649)) return true; // Discover
  if (p2 === 62) return true; // UnionPay
  return false;
}

/**
 * Whether a value typed as an ACCOUNT number has the shape of a payment-card
 * number: only digits (spaces and dashes allowed between them), 15 to 19 digits,
 * a card-network prefix, and a valid Luhn check digit. A random account number
 * passes all three about one time in a hundred, so this is a strong signal and
 * still not proof; `scripts/measure-payout-track-record.mts` measured how often a
 * card-shaped number on file was nevertheless paid successfully.
 *
 * 13-digit Visa is deliberately out: Metrobank and Security Bank account numbers
 * are 13 digits, and that legacy card length is no longer issued.
 */
export function looksLikeCardNumber(value: string | null | undefined): boolean {
  const raw = String(value ?? '').trim();
  if (!raw || !/^[\d\s-]+$/.test(raw)) return false;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 15 || digits.length > 19) return false;
  return hasCardNetworkPrefix(digits) && luhnValid(digits);
}

// ── Account holder vs the employee ──────────────────────────────────────────

/** Surname particles. They are shared by unrelated families, so they prove nothing. */
const PARTICLES = new Set([
  'de', 'del', 'dela', 'della', 'delos', 'las', 'los', 'la', 'le', 'van', 'von', 'da', 'dos', 'das', 'di',
  'san', 'santa', 'sta', 'y', 'e', 'jr', 'sr', 'ii', 'iii', 'iv', 'mr', 'mrs', 'ms', 'miss',
]);

function nameTokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !PARTICLES.has(t));
}

/** "Last, First Middle" splits at the comma; "First Middle Last" takes the last token as the surname. */
function splitOwnName(name: string): { given: string[]; surname: string[] } | null {
  const comma = name.indexOf(',');
  if (comma >= 0) {
    const surname = nameTokens(name.slice(0, comma));
    const given = nameTokens(name.slice(comma + 1));
    return surname.length && given.length ? { given, surname } : null;
  }
  const tokens = nameTokens(name);
  if (tokens.length < 2) return null;
  return { given: tokens.slice(0, -1), surname: tokens.slice(-1) };
}

export type HolderNameVerdict = 'match' | 'mismatch' | 'unknown';

/**
 * Whether an account holder name reads as the employee's own name. `match` needs
 * BOTH a given name AND a surname of one of `ownNames` in the holder name (a
 * one-letter initial counts for a given name). A shared surname alone is exactly
 * what a spouse's account looks like, so it is a `mismatch`; surname particles
 * ("dela", "de los", "san") never count, because two unrelated families share them.
 *
 * `unknown` when the holder is blank or no own name splits into given + surname.
 * This is a prompt for the employee to CONFIRM, never a refusal on its own: a
 * married name, a short form or a roster typo all read as `mismatch`.
 */
export function holderNameVerdict(
  holder: string | null | undefined,
  ownNames: ReadonlyArray<string | null | undefined>,
): HolderNameVerdict {
  const held = nameTokens(String(holder ?? ''));
  if (held.length === 0) return 'unknown';
  const heldSet = new Set(held);
  const initials = new Set(held.filter((t) => t.length === 1));
  let judged = false;
  for (const own of ownNames) {
    const parts = splitOwnName(String(own ?? ''));
    if (!parts) continue;
    judged = true;
    const givenHit = parts.given.some((g) => heldSet.has(g) || initials.has(g[0]));
    const surnameHit = parts.surname.some((s) => s.length > 1 && heldSet.has(s));
    if (givenHit && surnameHit) return 'match';
  }
  return judged ? 'mismatch' : 'unknown';
}

// ── Where the money goes ────────────────────────────────────────────────────

/**
 * A payout destination as the payment log can recognise it: an account's DIGITS,
 * or a wallet address lowercased. `payment_dispatches.recipient_account_number`
 * holds either one (Mark Paid snapshots the account number on a bank rail and the
 * wallet email on a wallet rail — `resolveMarkPaidDefaults`).
 */
export type DestinationKey = { kind: 'account' | 'wallet'; value: string };

/** Normalise one dispatch snapshot. Null when it holds nothing comparable. */
export function snapshotDestinationKey(snapshot: string | null | undefined): DestinationKey | null {
  const raw = String(snapshot ?? '').trim();
  if (!raw) return null;
  if (raw.includes('@')) return { kind: 'wallet', value: raw.toLowerCase() };
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 4 ? { kind: 'account', value: digits } : null;
}

/**
 * The destination Payment Dispatch pays this person on, keyed the way
 * `resolveMarkPaidDefaults` snapshots it: wallet rails by their wallet email, the
 * bank rails by the PAID slot's account (`resolvePreferredAccountNumber`, the same
 * cross-slot rule PD uses), Wise by its bank account when wire details exist and
 * its handle otherwise, Jeeves by its account and then its phone.
 */
export function payoutDestinationKey(
  row: Record<string, unknown> | null | undefined,
  rail: ProcessorId | null,
): DestinationKey | null {
  if (!row || !rail) return null;
  const { payout } = payoutDraftFromIdsRow(row);
  const account = resolvePreferredAccountNumber(row);
  switch (rail) {
    case 'hurupay':
      return snapshotDestinationKey(payout.hurupayEmail);
    case 'wepay':
      return snapshotDestinationKey(payout.wepayEmail);
    case 'higlobe':
      return snapshotDestinationKey(payout.higlobeEmail);
    case 'wise': {
      const hasWire = !!(payout.bankName || payout.altBankName) && !!account;
      return hasWire ? snapshotDestinationKey(account) : snapshotDestinationKey(payout.wiseEmail || payout.wiseTag);
    }
    case 'jeeves':
      return snapshotDestinationKey(account || payout.phoneNumber);
    case 'wires':
      return snapshotDestinationKey(account);
  }
}

export function sameDestination(a: DestinationKey | null, b: DestinationKey | null): boolean {
  return !!a && !!b && a.kind === b.kind && a.value === b.value;
}

// ── The track record of an account ──────────────────────────────────────────

/** One `payment_dispatches` row, as much of it as the track record reads. */
export type TrackDispatchRow = {
  recipient_account_number: string | null;
  status: string | null;
  sent_date: string | null;
  payee_type?: string | null;
};

/**
 * How the account on file has done. `unavailable` means the payment log could
 * not be read and is NEVER rendered as "no payments": a failed read is not a
 * fact about the account. `destination: 'none'` means nothing on file names an
 * account or wallet payroll could pay.
 */
export type PayoutTrackRecord =
  | {
      status: 'ok';
      destination: 'account' | 'wallet' | 'none';
      /** `paid` dispatch rows whose recorded destination is THIS account. */
      paidCount: number;
      /** `problem` rows to this account still on record (a cleared problem is deleted, so this can undercount). */
      problemCount: number;
      firstPaidOn: string | null;
      lastPaidOn: string | null;
      lastProblemOn: string | null;
    }
  | { status: 'unavailable' };

/**
 * Fold one person's dispatch rows into the record of ONE destination. Rows with no
 * recorded account (2,498 of 13,792 paid rows on 2026-10-07, mostly before the
 * snapshot existed) cannot be attributed and are not counted, so the count is
 * "on record", a floor. Contractor rows pay invoices, not this account.
 */
export function foldPayoutTrackRecord(
  rows: ReadonlyArray<TrackDispatchRow>,
  destination: DestinationKey | null,
): PayoutTrackRecord {
  if (!destination) {
    return {
      status: 'ok', destination: 'none', paidCount: 0, problemCount: 0,
      firstPaidOn: null, lastPaidOn: null, lastProblemOn: null,
    };
  }
  let paidCount = 0;
  let problemCount = 0;
  let firstPaidOn: string | null = null;
  let lastPaidOn: string | null = null;
  let lastProblemOn: string | null = null;
  for (const r of rows) {
    if (r.payee_type === 'contractor') continue;
    if (!sameDestination(snapshotDestinationKey(r.recipient_account_number), destination)) continue;
    const day = r.sent_date ? String(r.sent_date).slice(0, 10) : null;
    if (r.status === 'paid') {
      paidCount += 1;
      if (day && (!firstPaidOn || day < firstPaidOn)) firstPaidOn = day;
      if (day && (!lastPaidOn || day > lastPaidOn)) lastPaidOn = day;
    } else if (r.status === 'problem') {
      problemCount += 1;
      if (day && (!lastProblemOn || day > lastProblemOn)) lastProblemOn = day;
    }
  }
  return {
    status: 'ok', destination: destination.kind, paidCount, problemCount,
    firstPaidOn, lastPaidOn, lastProblemOn,
  };
}

/**
 * Read a track record off an API payload. `null` when the field is absent (an
 * older server, or a caller that did not ask), so the UI renders nothing rather
 * than inventing a count; anything malformed is `unavailable`, never zero.
 */
export function parsePayoutTrack(raw: unknown): PayoutTrackRecord | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') return { status: 'unavailable' };
  const o = raw as Record<string, unknown>;
  if (o.status !== 'ok') return { status: 'unavailable' };
  const dest = o.destination;
  if (dest !== 'account' && dest !== 'wallet' && dest !== 'none') return { status: 'unavailable' };
  const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
  const day = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const paidCount = count(o.paidCount);
  const problemCount = count(o.problemCount);
  if (paidCount == null || problemCount == null) return { status: 'unavailable' };
  return {
    status: 'ok',
    destination: dest,
    paidCount,
    problemCount,
    firstPaidOn: day(o.firstPaidOn),
    lastPaidOn: day(o.lastPaidOn),
    lastProblemOn: day(o.lastProblemOn),
  };
}

// ── Assessing a self-service change ─────────────────────────────────────────

/** Every payout column a self-service save may write. Both save routes share it. */
export const SELF_SERVICE_PAYOUT_FIELDS = [
  'preferred_processor', 'preferred_bank_slot',
  'bank_name', 'account_holder_name', 'account_number', 'routing_number', 'swift_code',
  'alt_bank_name', 'alt_account_holder_name', 'alt_account_number', 'alt_routing_number',
  'hurupay_email', 'wepay_email', 'higlobe_email', 'higlobe_account_name', 'wise_email', 'wise_tag',
  'phone_number', 'full_address',
] as const;

const PRIMARY_SLOT_FIELDS = ['bank_name', 'account_holder_name', 'account_number'];
const ALT_SLOT_FIELDS = ['alt_bank_name', 'alt_account_holder_name', 'alt_account_number'];
const HIGLOBE_FIELDS = ['higlobe_email', 'higlobe_account_name'];

export type PayoutSafetyFlag = 'card_shaped_account' | 'holder_not_employee';

export type PayoutChangeAssessment = {
  /** Whether any posted payout value differs from what is stored. Re-saving identical details is not a change. */
  changed: boolean;
  /** Whether the account or wallet payroll pays moved. */
  destinationChanged: boolean;
  flags: PayoutSafetyFlag[];
};

const text = (v: unknown): string => (v == null ? '' : String(v).trim());

/**
 * What a self-service save would change, judged on the stored row and the posted
 * fields together (posted wins, absent stays as stored).
 *
 * - **card_shaped_account**: an account number that CHANGED in this save has the
 *   shape of a card number. A number already on file is not re-flagged; it is not
 *   being entered now.
 * - **holder_not_employee**: a slot whose details changed in this save (or the
 *   paid slot, when the slot switched) carries a holder name that does not read as
 *   the employee's own; HiGlobe's account name likewise.
 *
 * `before` is best-effort upstream; an unread row is `{}`, which makes everything
 * read as changed, so the requirements below fail toward ASKING, never toward
 * skipping.
 */
export function assessPayoutChange(
  before: Record<string, unknown>,
  update: Record<string, unknown>,
  ownNames: ReadonlyArray<string | null | undefined>,
): PayoutChangeAssessment {
  const changedKeys = new Set(
    Object.keys(update).filter((k) => text(update[k]) !== text(before[k])),
  );
  const after: Record<string, unknown> = { ...before };
  for (const [k, v] of Object.entries(update)) after[k] = v;

  const flags = new Set<PayoutSafetyFlag>();
  for (const col of ['account_number', 'alt_account_number']) {
    if (changedKeys.has(col) && looksLikeCardNumber(text(after[col]))) flags.add('card_shaped_account');
  }

  const holderMismatch = (holder: unknown) => holderNameVerdict(text(holder), ownNames) === 'mismatch';
  const slotSwitched = changedKeys.has('preferred_bank_slot');
  const altPaid = text(after.preferred_bank_slot) === 'alternative';
  if (
    (PRIMARY_SLOT_FIELDS.some((f) => changedKeys.has(f)) || (slotSwitched && !altPaid)) &&
    holderMismatch(after.account_holder_name)
  ) {
    flags.add('holder_not_employee');
  }
  if (
    (ALT_SLOT_FIELDS.some((f) => changedKeys.has(f)) || (slotSwitched && altPaid)) &&
    holderMismatch(after.alt_account_holder_name)
  ) {
    flags.add('holder_not_employee');
  }
  if (HIGLOBE_FIELDS.some((f) => changedKeys.has(f)) && holderMismatch(after.higlobe_account_name)) {
    flags.add('holder_not_employee');
  }

  // The rail PD pays on (Bank Preferred, then the Disbursement pick), before and
  // after: picking Kolan over a bank account moves the money as surely as a new
  // account number does.
  const destinationChanged = !sameDestinationOrBothEmpty(
    payoutDestinationKey(before, resolveEffectivePayoutProcessor(before)),
    payoutDestinationKey(after, resolveEffectivePayoutProcessor(after)),
  );

  return { changed: changedKeys.size > 0, destinationChanged, flags: [...flags] };
}

function sameDestinationOrBothEmpty(a: DestinationKey | null, b: DestinationKey | null): boolean {
  if (!a && !b) return true;
  return sameDestination(a, b);
}

/** What the client posts with a self-service save. Anything else is "not given". */
export type PayoutSafetyAnswers = {
  /** Must equal PAYOUT_CHANGE_NOTICE_VERSION. */
  payout_notice_ack?: unknown;
  /** Must be literally `true` when the change carries `holder_not_employee`. */
  confirm_holder_is_self?: unknown;
  /** Must be literally `true` when the change carries `card_shaped_account`. */
  confirm_not_card_number?: unknown;
};

export type PayoutSafetyRefusalCode =
  | 'payout_notice_ack_required'
  | 'holder_confirm_required'
  | 'card_confirm_required';

export type PayoutSafetyVerdict =
  | { ok: true; assessment: PayoutChangeAssessment }
  | { ok: false; code: PayoutSafetyRefusalCode; error: string; assessment: PayoutChangeAssessment };

/**
 * The server gate for a SELF-SERVICE payout change. A change with no acknowledged
 * notice, or a flagged change without its confirmation, is refused with a 400 and
 * a code the form uses to show the box it was missing. Strict equality only: a
 * stale page posting an older notice version, or a truthy string instead of
 * `true`, is a refusal. A save that changes nothing needs no acknowledgement.
 *
 * `guardrail: false` (switched off in System Settings) lets every change through;
 * the assessment still rides along, so its flags still reach Accounting. The
 * default is ON: a caller that does not say is gated.
 */
export function judgePayoutChange(
  assessment: PayoutChangeAssessment,
  answers: PayoutSafetyAnswers,
  opts: { guardrail: boolean } = { guardrail: true },
): PayoutSafetyVerdict {
  if (!assessment.changed) return { ok: true, assessment };
  if (opts.guardrail === false) return { ok: true, assessment };
  if (answers.payout_notice_ack !== PAYOUT_CHANGE_NOTICE_VERSION) {
    return {
      ok: false,
      code: 'payout_notice_ack_required',
      error:
        'Please read the bank-change notice and tick the box to confirm before saving. If you do not see it, reload the page.',
      assessment,
    };
  }
  if (assessment.flags.includes('card_shaped_account') && answers.confirm_not_card_number !== true) {
    return {
      ok: false,
      code: 'card_confirm_required',
      error:
        'That account number looks like a card number. Check it against your bank, then confirm it is your account number (not the number on your card) before saving.',
      assessment,
    };
  }
  if (assessment.flags.includes('holder_not_employee') && answers.confirm_holder_is_self !== true) {
    return {
      ok: false,
      code: 'holder_confirm_required',
      error:
        'The account holder name does not match your name on file. Payroll pays only accounts in your own name. Confirm the account is yours before saving.',
      assessment,
    };
  }
  return { ok: true, assessment };
}

/**
 * The record kept of what the employee attested, written to the audit row, the
 * non-clearable `bank_update_history.safety` column and Accounting's alert. No
 * value is in it, only flags and counts (update-bank-info.md rule 22).
 *
 * With the guardrail OFF nothing was shown and nothing was acknowledged, so the
 * record says so: `guardrail: 'off'`, `notice_version: null`, both confirmations
 * false. The flags are still judged, so Accounting still sees a card-shaped
 * number or a holder who is not the employee. Rows written before 2026-10-09
 * carry no `guardrail`; they were all written with it on.
 */
export type PayoutChangeAttestation = {
  guardrail: 'on' | 'off';
  /** The notice version acknowledged; null when the guardrail was off and none was shown. */
  notice_version: string | null;
  /** When the change was saved (and, with the guardrail on, attested). */
  attested_at: string;
  destination_changed: boolean;
  flags: PayoutSafetyFlag[];
  holder_confirmed: boolean;
  card_confirmed: boolean;
  /** How the account being LEFT had done. Null when it was not read or nothing moved. */
  previous_account: { paid_count: number; problem_count: number; last_paid_on: string | null } | null;
};

export function buildPayoutAttestation(
  assessment: PayoutChangeAssessment,
  answers: PayoutSafetyAnswers,
  previous: PayoutTrackRecord | null,
  now: Date = new Date(),
  opts: { guardrail: boolean } = { guardrail: true },
): PayoutChangeAttestation {
  const on = opts.guardrail !== false;
  return {
    guardrail: on ? 'on' : 'off',
    notice_version: on ? PAYOUT_CHANGE_NOTICE_VERSION : null,
    attested_at: now.toISOString(),
    destination_changed: assessment.destinationChanged,
    flags: assessment.flags,
    // Off: no box was shown, so nothing posted can count as a confirmation.
    holder_confirmed: on && answers.confirm_holder_is_self === true,
    card_confirmed: on && answers.confirm_not_card_number === true,
    previous_account:
      previous && previous.status === 'ok' && previous.destination !== 'none'
        ? { paid_count: previous.paidCount, problem_count: previous.problemCount, last_paid_on: previous.lastPaidOn }
        : null,
  };
}

/** The sentences Accounting's alert appends for a flagged or account-moving change. Field names and counts only. */
export function attestationAlertSentences(a: PayoutChangeAttestation): string[] {
  const out: string[] = [];
  const unconfirmed =
    a.guardrail === 'off'
      ? 'the employee was not asked to confirm it (bank guardrail off).'
      : 'the employee did not confirm it.';
  if (a.flags.includes('card_shaped_account')) {
    out.push(
      `The new account number looks like a card number; ${
        a.card_confirmed ? 'the employee confirmed it is an account number.' : unconfirmed
      }`,
    );
  }
  if (a.flags.includes('holder_not_employee')) {
    out.push(
      `The account holder name does not match the employee’s name; ${
        a.holder_confirmed ? 'the employee confirmed the account is their own.' : unconfirmed
      }`,
    );
  }
  if (a.destination_changed && a.previous_account && a.previous_account.paid_count > 0) {
    const n = a.previous_account.paid_count;
    out.push(`They moved off an account with ${n} successful payment${n === 1 ? '' : 's'} on record.`);
  }
  return out;
}
