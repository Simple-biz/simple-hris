/** [TERMINATION-DOCS]
 * The generate route's ORDERED decisions, extracted as pure functions.
 *
 * WHY THIS MODULE EXISTS. `npm test` is
 * `node --import tsx --test "src/**\/*.test.ts"` (package.json:13), so nothing
 * under `app/api/**` is ever executed by the suite. Every branch of
 * `POST /api/accounting/documents/termination` whose ORDER *is* the guard was
 * therefore unpinnable where it lived:
 *
 *   · G9 — the signature ladder. `error` FIRST (a null row carrying
 *     'Supabase not configured' is a config failure, a 500), then "no row",
 *     then "row disabled". Reordered to `if (!signature || sigErr)` — the
 *     natural "simplification" — a service-role outage answers 412 'No saved
 *     signature', and the panel force-opens the signature dialog so the rep
 *     re-draws a signature they already have while the real fault stays silent.
 *   · G2 layer 3 — a rep-supplied reason re-validated against the departure
 *     allowlist, under the type system and over the DB CHECK.
 *   · G4 — the re-check against the MERGED dates, restated in the DDL as
 *     `check (start_date is null or termination_date > start_date)`.
 *   · The blanks admission — a `filled` key the server's own resolution did not
 *     report blank is a 400, which is what stops a client overwriting a fact
 *     that exists in the record.
 *   · G5 — a rep-typed date is a PRINTED date, so it passes the same gate every
 *     resolved date passes. The route ran `sanitizeOffboardDay(
 *     normalizeMasterDate(v))` and nothing else, which is strictly weaker than
 *     the panel's own pre-submit check: a crafted POST carrying `"Aug-24"`
 *     printed "August 24, 2001" on a signed letter.
 *   · Risk 4 — a rep-filled rate keeps the currency the record holds. The route
 *     used to hardcode `currency: 'PHP'`, which printed a USD/COP salary as
 *     pesos on a signed letter.
 *
 * PURE and CLIENT-SAFE: no `server-only`, no Supabase, no Node builtin, no
 * `next/*`. It imports types, predicates and `explicitMasterDay` — itself pure
 * — so the route calls it and the test drives the same code the route runs.
 *
 * Every message here is the message the route returns. The panel matches two of
 * them by substring ('No saved signature', 'switched off'), so they are
 * exported constants rather than inline strings — a reword in one place cannot
 * desynchronise the catch-block mapping from the UI's steer.
 */
import { explicitMasterDay } from './termination-arbitration';
import {
  isTerminationCurrency,
  isTerminationDepartureReason,
  type TerminationBlankField,
  type TerminationBlockedReason,
  type TerminationCurrency,
  type TerminationDepartureReason,
  type TerminationGenerateRequest,
} from './types';

/** One refusal, in the shape the route's `generateFailure(message, status, blocked)`
 *  takes. `blocked` is non-null only when the refusal is a GUARD the panel
 *  renders as a refusal pane, not a bad field. */
export interface TerminationRouteRejection {
  status: 400 | 409 | 412 | 500;
  message: string;
  blocked: TerminationBlockedReason | null;
}

type Admitted<T> = { ok: true; value: T } | { ok: false; rejection: TerminationRouteRejection };

function refuse(
  status: TerminationRouteRejection['status'],
  message: string,
  blocked: TerminationBlockedReason | null = null,
): { ok: false; rejection: TerminationRouteRejection } {
  return { ok: false, rejection: { status, message, blocked } };
}

// ─── G9 · the signature is the generating rep's OWN and LIVE ─────────────────

/** Matched by substring in the route's catch block and by the panel, which
 *  force-opens the signature-capture dialog on a 412. */
export const TERMINATION_SIGNATURE_MISSING_MESSAGE =
  'No saved signature — draw and save your signature in the Documents tab first';

export const TERMINATION_SIGNATURE_DISABLED_MESSAGE =
  'Your signature is switched off — turn it back on to sign documents';

/** Said when the signature read failed but reported no message of its own. A
 *  blank error must still be a 500: '' is falsy, and `if (err)` would fall
 *  through to "no signature" and tell the rep to re-draw. */
export const TERMINATION_SIGNATURE_READ_FAILED_MESSAGE = 'The signature could not be read';

/**
 * G9, whole. Takes `getDocumentSignature`'s result verbatim and returns the
 * outcome: ok, 500 (the read failed — including 'Supabase not configured'),
 * 412 (no row), 412 (row present, revoke switch off).
 *
 * The `error` arm is FIRST and is tested with `!== null`, not truthiness: a
 * config failure is not a revoked signer, and reading it as one steers the rep
 * into re-drawing a signature they already have.
 */
export function decideTerminationSignatureGate(loaded: {
  row: { enabled: boolean } | null;
  error: string | null;
}): { ok: true } | { ok: false; rejection: TerminationRouteRejection } {
  if (loaded.error !== null && loaded.error !== undefined) {
    return refuse(500, loaded.error.trim() || TERMINATION_SIGNATURE_READ_FAILED_MESSAGE);
  }
  if (!loaded.row) return refuse(412, TERMINATION_SIGNATURE_MISSING_MESSAGE);
  if (!loaded.row.enabled) return refuse(412, TERMINATION_SIGNATURE_DISABLED_MESSAGE);
  return { ok: true };
}

/** The route's catch block maps a message thrown from deeper in the stack to the
 *  same status the ladder above would have returned. Kept beside the constants
 *  so the two substrings can be pinned against them. */
export function terminationThrownStatus(message: string): 412 | 500 {
  return message.includes('No saved signature') || message.includes('switched off') ? 412 : 500;
}

// ─── The rep's values, admitted only into holes the SERVER found ─────────────

/** Request key → the blank field it fills. Written out rather than derived so a
 *  rename on either side is a type error instead of a silently ignored value. */
export const TERMINATION_FILLED_KEY_TO_BLANK = {
  termination_date: 'termination_date',
  reason: 'reason',
  ending_department: 'ending_department',
  start_date: 'start_date',
  starting_rate: 'starting_rate',
  ending_rate: 'ending_rate',
} as const;

/** Currency keys MODIFY a rate fill; they are not fills of their own. Each one
 *  names the rate blank it belongs to, and is refused unless that rate is being
 *  filled in the same request. */
export const TERMINATION_FILLED_CURRENCY_KEY_TO_RATE = {
  starting_rate_currency: 'starting_rate',
  ending_rate_currency: 'ending_rate',
} as const;

/**
 * Compile-time exhaustiveness: every key of `TerminationGenerateRequest['filled']`
 * is either a blank it fills or the currency of one. A key added to the type
 * with no home here is a TYPE ERROR rather than a value the route ignores.
 */
const FILLED_KEY_HOMES: Record<
  keyof TerminationGenerateRequest['filled'],
  TerminationBlankField
> = {
  ...TERMINATION_FILLED_KEY_TO_BLANK,
  ...TERMINATION_FILLED_CURRENCY_KEY_TO_RATE,
};

/** DDL columns that are NOT NULL. Anything still blank here after the merge is a
 *  400, not a database CHECK violation arriving after the PDF was rendered. */
export const TERMINATION_REQUIRED_FACTS: readonly TerminationBlankField[] = [
  'termination_date',
  'reason',
  'ending_department',
];

/** A value the rep did not actually supply. `''` counts as absent — an empty
 *  input is not a fill. `0` does NOT: a zero rate is refused later, by name. */
function absent(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

/**
 * Which blanks the rep filled — in the order this module declares, never the
 * order the JSON happened to arrive in, so the refusal message is deterministic.
 *
 * ORDER IS THE GUARD, twice over:
 *   1. an unrecognised key is refused before any value is read, so a typo'd or
 *      hostile key can never be half-applied;
 *   2. a recognised key is refused unless the SERVER's own resolution reported
 *      that field blank — the check that stops a client overwriting a fact that
 *      exists in the record.
 */
export function admitFilledFields(
  supplied: Record<string, unknown>,
  blanks: readonly TerminationBlankField[],
): Admitted<TerminationBlankField[]> {
  for (const key of Object.keys(supplied)) {
    if (!(key in FILLED_KEY_HOMES)) {
      return refuse(400, `'${key}' is not a fillable field`);
    }
  }

  const blankSet = new Set<TerminationBlankField>(blanks);
  const fields: TerminationBlankField[] = [];
  for (const [key, field] of Object.entries(TERMINATION_FILLED_KEY_TO_BLANK) as Array<
    [keyof typeof TERMINATION_FILLED_KEY_TO_BLANK, TerminationBlankField]
  >) {
    if (absent(supplied[key])) continue;
    if (!blankSet.has(field)) {
      return refuse(400, `${field} was resolved from the record and cannot be supplied by hand`);
    }
    fields.push(field);
  }

  for (const [key, rateField] of Object.entries(TERMINATION_FILLED_CURRENCY_KEY_TO_RATE) as Array<
    [keyof typeof TERMINATION_FILLED_CURRENCY_KEY_TO_RATE, TerminationBlankField]
  >) {
    if (absent(supplied[key])) continue;
    if (!fields.includes(rateField)) {
      // A currency with no amount cannot be applied to anything, and silently
      // dropping it would let a rep believe they had set one.
      return refuse(400, `'${key}' cannot be supplied without ${rateField}`);
    }
  }

  return { ok: true, value: fields };
}

// ─── G5 · a rep-typed date is a PRINTED date ──────────────────────────

/** `YYYY-MM-DD`, exactly. The panel's DatePicker emits nothing else and the
 *  panel refuses anything else before submit (TerminationDocsPanel.tsx:283), so
 *  requiring it here costs a real rep nothing and removes every shape whose
 *  parts a parser would have to invent. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Admit one rep-supplied day, or refuse it.
 *
 * THE HOLE THIS CLOSES. The route ran `sanitizeOffboardDay(normalizeMasterDate(
 * String(v)))` and nothing else — the contract's G5 ordering, which is NECESSARY
 * BUT NOT SUFFICIENT. `normalizeMasterDate`'s `new Date(s)` fallback
 * (master-date.ts:46) FABRICATES whichever parts the value omits, and the
 * fabricated result is a well-formed PAST day that no sanitizer can tell from a
 * real one. A crafted POST from a rep who holds `accounting/documents` edit
 * therefore printed a date the record never stated onto a signed letter, while
 * the route's own rejection string claimed the value "must be a real calendar
 * day":
 *
 *   "Aug-24" → 2001-08-24   ·  "0" → 2000-01-01   ·  "2026" → 2026-01-01
 *   "2/30/2026" → 2026-02-30 (a legal-looking day that does not exist, which
 *                              then rolls over to March 2 when rendered, or
 *                              blows up on the DATE column AFTER the storage
 *                              object was uploaded)
 *
 * Two checks, in this order, and the SANITISED day is what comes back — never
 * the rep's raw string:
 *   1. `ISO_DAY` — the panel's own shape, so a fabricating value never reaches a
 *      parser;
 *   2. `explicitMasterDay` — the SAME gate every resolved date passes: the real
 *      calendar-day round-trip, the requirement that the raw value independently
 *      state year, month and day, and `sanitizeOffboardDay`'s future bound.
 *
 * A rep-typed date is not a lesser fact than a resolved one. It is printed in
 * the same leader row of the same signed page, so it passes the same gate.
 */
export function admitFilledDay(params: {
  /** 'Termination date' | 'Start date' — as it reads in the refusal message. */
  label: string;
  raw: unknown;
  /** Injected clock, so `sanitizeOffboardDay`'s future bound is testable. */
  now: Date;
}): Admitted<string> {
  const raw = String(params.raw ?? '').trim();
  if (!ISO_DAY.test(raw)) {
    return refuse(400, `${params.label} must be a calendar day written as YYYY-MM-DD`);
  }
  const day = explicitMasterDay(raw, params.now);
  if (!day) {
    return refuse(400, `${params.label} must be a real calendar day, not in the future`);
  }
  return { ok: true, value: day };
}

/** G2 layer 3: a rep-supplied reason, re-validated against the departure
 *  allowlist (VALID_OFFBOARD_REASONS minus `temporary_pause`). Under the type
 *  system, over the DB CHECK. */
export function admitFilledReason(raw: unknown): Admitted<TerminationDepartureReason> {
  const reason = String(raw);
  if (!isTerminationDepartureReason(reason)) {
    return refuse(400, `'${reason}' is not a termination reason`);
  }
  return { ok: true, value: reason };
}

/**
 * Risk 4 — the native currency, carried end to end.
 *
 * The rate the rep typed is priced in the currency the panel showed beside the
 * input, which is the currency the SERVER resolved from the carrier. So:
 *   · nothing supplied ⇒ the record's currency. Never a hardcoded 'PHP': that
 *     printed a COP salary as `₱320,000.00` on a signed letter and stored
 *     'PHP' beside it.
 *   · nothing supplied AND the record states no currency (`resolved === null`,
 *     i.e. the Payment Catalog read failed) ⇒ 400. Money with no unit is not a
 *     fact: `numeric` says nothing about denomination, so a figure admitted here
 *     without one would print unlabelled and store a null currency beside a
 *     non-null rate, which the DDL's
 *     `termination_documents_currency_present_with_rate` CHECK refuses anyway.
 *   · something supplied ⇒ it must be one of the three the document can state,
 *     AND it must be the currency the record still holds. A mismatch means the
 *     rep priced the figure against a stale facts sheet, which is a 400 and a
 *     reload — never a silent re-denomination of a number a human will sign.
 *     When the record states NO currency there is nothing to disagree with, and
 *     the rep's explicit choice — validated against the union — is the answer.
 */
export function resolveFilledRateCurrency(params: {
  /** 'Starting rate' | 'Ending rate' — as it reads in the refusal message. */
  label: string;
  supplied: unknown;
  /** The currency the facts sheet showed. `null` when nothing could state one. */
  resolved: TerminationCurrency | null;
}): Admitted<TerminationCurrency> {
  if (absent(params.supplied)) {
    if (!params.resolved) {
      return refuse(
        400,
        `${params.label} needs a currency: the record does not state one, so the amount cannot be printed until a currency is chosen with it`,
      );
    }
    return { ok: true, value: params.resolved };
  }
  if (!isTerminationCurrency(params.supplied)) {
    return refuse(
      400,
      `'${String(params.supplied)}' is not a currency this document can state`,
    );
  }
  if (params.resolved !== null && params.supplied !== params.resolved) {
    return refuse(
      400,
      `${params.label} was confirmed in ${params.supplied} but the record now says ${params.resolved} — reload the facts sheet before generating`,
    );
  }
  return { ok: true, value: params.supplied };
}

/** The NOT NULL facts that are still blank after the merge, as one refusal. */
export function describeMissingRequiredFacts(
  remaining: readonly TerminationBlankField[],
): TerminationRouteRejection | null {
  const missing = TERMINATION_REQUIRED_FACTS.filter((f) => remaining.includes(f));
  if (missing.length === 0) return null;
  return { status: 400, message: `Fill in ${missing.join(', ')} before generating`, blocked: null };
}

/** G4's message, on the route's own re-check. Reproduced in `blocked.message`
 *  so the panel's refusal pane and the 409 body say the same thing. */
export const TERMINATION_REHIRE_MESSAGE =
  'The termination date is on or before the start date — that is a re-hire, not a departure';

/**
 * G4 again, against the MERGED dates — the rep can only have made this true by
 * filling one of them. `<=` is the contract's rule and the DDL's
 * `check (start_date is null or termination_date > start_date)`; comparing
 * 'YYYY-MM-DD' strings is a calendar comparison with no Date parsing.
 */
export function checkMergedTerminationDates(
  terminationDate: string | null,
  startDate: string | null,
): TerminationRouteRejection | null {
  if (!terminationDate || !startDate) return null;
  if (terminationDate > startDate) return null;
  return {
    status: 409,
    message: TERMINATION_REHIRE_MESSAGE,
    blocked: {
      code: 'rehire_after_offboard',
      message: TERMINATION_REHIRE_MESSAGE,
      offDate: terminationDate,
      startDate,
    },
  };
}
