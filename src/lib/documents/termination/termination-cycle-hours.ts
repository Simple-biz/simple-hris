/** [TERMINATION-DOCS]
 * The current cycle's timesheet, read as a REFUSAL-ONLY signal — and the three
 * states it can be in.
 *
 * WHY THIS MODULE EXISTS. `loadCycleHoursIndex` reports failure two different
 * ways and only one of them is visible: `EMPTY(msg)` sets `error`, but a read
 * that returned NO ROWS (the `is_current` upload has none yet, or a swallowed
 * inner failure) comes back with empty sets and `error: null`. The old caller
 * collapsed both into `hours.error ? null : personWorkedCycle(...)`, so the
 * second shape became a CONFIDENT `false` — "nobody worked this cycle" — for
 * every person on the roster. That is the round-2 blocker: an absent signal
 * masquerading as a negative one.
 *
 * So the signal is a THREE-STATE union, and `worked` is structurally
 * unreachable unless the index was actually readable AND had rows in it:
 *
 *   · `unreadable`  — the loader reported an error. The caller BLOCKS
 *                     (`evidence_read_failed`); an absolute refusal may never
 *                     rest on a read that did not happen.
 *   · `unavailable` — the loader succeeded and the index is EMPTY overall. This
 *                     is NOT "nobody worked". It is "the timesheet cannot answer
 *                     the question", it is recorded as a degraded note the rep
 *                     sees, and the refusal ladder falls back on the departure
 *                     record (T2) and the re-engagement check (T3).
 *   · `ready`       — the index has rows. A HIT refuses the letter; a MISS is
 *                     genuine information.
 *
 * WHY AN ABSENT SIGNAL IS NOT A FAIL-OPEN. Cycle hours are only ever used to
 * REFUSE. A positive hit blocks a document; an absent or unreadable hours signal
 * must therefore never, on its own, PERMIT one — and it does not, because the
 * case hours was there to catch is a RE-HIRE (someone with an old departure
 * record who is working again), and the re-engagement test catches that from the
 * master rows alone, without Hubstaff.
 *
 * WHY THE MATCH IS WIDER THAN THE MASTER ROW'S OWN COLUMNS. A working person's
 * Hubstaff login is routinely an address `global_master_list` does not carry —
 * the timesheet is exported from a third-party tool people sign into with
 * whatever address was handy. Matching only the four master email columns plus
 * an exact name-token key therefore MISSES real hours, and a missed hit is the
 * only direction that costs anything here: a false positive costs a letter that
 * is issued after a master-row repair, a false negative prints a termination
 * letter for someone who worked this week. So the match is deliberately the
 * widest reasonable one — every known address, the local part of every known
 * address, the exact name-token key, and a token-SUBSET name comparison (the
 * widening `nameTokens` is exported for, name-tokens.ts:16-18).
 */

import { normEmail } from '@/lib/email/norm-email';
import { nameTokens } from '@/lib/name/name-tokens';

/** The structural half of `CycleHoursIndex` this module needs. Declared here so
 *  a PURE module never imports the `server-only` loader, not even for a type. */
export interface TerminationHoursIndexView {
  emails: ReadonlySet<string>;
  nameTokenKeys: ReadonlySet<string>;
  error: string | null;
}

/** Every address and every name the subject is known by, from any source. */
export interface TerminationHoursIdentity {
  emails: Array<string | null | undefined>;
  names: Array<string | null | undefined>;
}

/**
 * The timesheet's answer. `worked` exists ONLY on `ready`: there is no way to
 * spell "the index could not answer" as `false`, which is the whole point.
 */
export type TerminationCycleHoursSignal =
  | { state: 'unreadable'; error: string }
  | { state: 'unavailable' }
  | { state: 'ready'; worked: boolean; matchedBy: string | null };

/** Minimum shared tokens for a SUBSET name match. One token is a first name and
 *  first names repeat across a 1,300-person roster; two is a person. */
const MIN_SHARED_NAME_TOKENS = 2;

/** Minimum local-part length for a cross-domain address match. `jm@` and `hr@`
 *  are role addresses on several domains; a 3+ character local part typed the
 *  same way on two domains is the same human often enough to be worth a
 *  refusal. */
const MIN_LOCAL_PART = 3;

function localPart(email: string): string | null {
  const at = email.indexOf('@');
  if (at <= 0) return null;
  const local = email.slice(0, at);
  return local.length >= MIN_LOCAL_PART ? local : null;
}

function isSubsetOrSuperset(a: string[], b: string[]): boolean {
  const shared = a.filter((t) => b.includes(t));
  if (shared.length < MIN_SHARED_NAME_TOKENS) return false;
  return shared.length === a.length || shared.length === b.length;
}

/**
 * Read the cycle timesheet for ONE identity.
 *
 * Never throws, never guesses. The caller decides what each state means; this
 * only refuses to let `unavailable` be spelled as `worked: false`.
 */
export function readCycleHoursSignal(
  index: TerminationHoursIndexView,
  identity: TerminationHoursIdentity,
): TerminationCycleHoursSignal {
  if (index.error) return { state: 'unreadable', error: index.error };
  if (index.emails.size === 0 && index.nameTokenKeys.size === 0) return { state: 'unavailable' };

  const known = new Set<string>();
  for (const e of identity.emails) {
    const n = normEmail(e ?? '');
    if (n) known.add(n);
  }

  // 1. The address, exactly.
  for (const e of known) {
    if (index.emails.has(e)) return { state: 'ready', worked: true, matchedBy: `the address ${e}` };
  }

  // 2. The address's LOCAL PART on any domain — a Hubstaff login the master row
  //    never carried is most often the same local part at a different domain.
  const locals = new Set<string>();
  for (const e of known) {
    const l = localPart(e);
    if (l) locals.add(l);
  }
  if (locals.size > 0) {
    for (const indexed of index.emails) {
      const l = localPart(indexed);
      if (l && locals.has(l)) {
        return { state: 'ready', worked: true, matchedBy: `the timesheet address ${indexed}` };
      }
    }
  }

  // 3. The name — the exact token key first (what `personWorkedCycle` does),
  //    then a token-subset comparison so "Jan Kane Reroma" on the master row and
  //    "Kane Reroma" in the timesheet are one person.
  const nameSets = identity.names
    .map((n) => (n ? nameTokens(n) : []))
    .filter((t) => t.length > 0);
  for (const tokens of nameSets) {
    const key = tokens.join(' ');
    if (index.nameTokenKeys.has(key)) {
      return { state: 'ready', worked: true, matchedBy: `the name "${key}"` };
    }
  }
  for (const tokens of nameSets) {
    for (const indexed of index.nameTokenKeys) {
      if (isSubsetOrSuperset(tokens, indexed.split(' ').filter(Boolean))) {
        return { state: 'ready', worked: true, matchedBy: `the timesheet name "${indexed}"` };
      }
    }
  }

  return { state: 'ready', worked: false, matchedBy: null };
}
