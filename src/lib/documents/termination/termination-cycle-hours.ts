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
// The CANONICAL `YYYY-MM-DD_to_YYYY-MM-DD` reader. Imported rather than
// re-regexed: the same pattern is already open-coded in `ceo-tools.ts:1286` and
// `overview-kpis.ts:126`, and a FOURTH copy is how one of them silently stops
// agreeing with the others. It is a pure module with zero imports, so it loads
// under `node --test` like the rest of this file.
import { parseDateRangeFromFilename } from '@/lib/hubstaff/calendar-column-dedupe';

/** The structural half of `CycleHoursIndex` this module needs. Declared here so
 *  a PURE module never imports the `server-only` loader, not even for a type. */
export interface TerminationHoursIndexView {
  emails: ReadonlySet<string>;
  nameTokenKeys: ReadonlySet<string>;
  /** The file the index was built from — `CycleHoursIndex.sourceFile`. Carried
   *  so a REFUSAL can name the week it is refusing on. A refusal that cannot say
   *  WHICH timesheet caught the person is the dead end this feature is forbidden
   *  to ship (`TerminationDocsPanel.tsx:140-144`), and it was how the first
   *  version told a rep "still on the clock" about someone who had left days
   *  earlier: the hit was real, the week behind it was the PREVIOUS one, and the
   *  message had no way to say so. */
  sourceFile: string | null;
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
  | {
      state: 'ready';
      worked: boolean;
      matchedBy: string | null;
      /** The week the index covers, when the filename states one. `null` is an
       *  UNLABELLED file, never a guessed range — same discipline as G5's dates:
       *  a week that cannot be read is a week the message does not name. */
      week: TerminationHoursWeek | null;
    };

/** A Hubstaff file's week, as ISO STRINGS. Strings, not `Date`s, because every
 *  date in this feature is compared as `YYYY-MM-DD` text (G5) and the one thing
 *  that reliably breaks that discipline is a `Date` round-trip. */
export interface TerminationHoursWeek {
  startIso: string;
  endIso: string;
  /** "Sep 6 – 12, 2026" — for the rep, never for a comparison. */
  label: string;
}

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


const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] as const;

/** `Date` built by parts at LOCAL midnight → `YYYY-MM-DD`, by parts. Never
 *  `toISOString()`, which shifts the day for every timezone west of UTC. */
function isoFromLocalDate(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** "2026-09-06" + "2026-09-12" → "Sep 6 – 12, 2026". Built from the STRING
 *  parts, so no locale and no timezone can reach it. */
function weekLabel(startIso: string, endIso: string): string {
  const [sy, sm, sd] = startIso.split('-');
  const [ey, em, ed] = endIso.split('-');
  const sMon = MONTHS[Number(sm) - 1] ?? sm;
  const eMon = MONTHS[Number(em) - 1] ?? em;
  if (sy !== ey) return `${sMon} ${Number(sd)}, ${sy} – ${eMon} ${Number(ed)}, ${ey}`;
  if (sm !== em) return `${sMon} ${Number(sd)} – ${eMon} ${Number(ed)}, ${ey}`;
  return `${sMon} ${Number(sd)} – ${Number(ed)}, ${ey}`;
}

/**
 * The week a Hubstaff filename states — or `null` when it states none.
 *
 * `null` is NOT a fallback to "probably this week". An unlabelled file means the
 * refusal message names the FILE instead of a week it cannot prove, which is the
 * same rule G5 applies to every printed date: a value that failed to parse is a
 * blank, never a guess.
 */
export function readCycleWeek(sourceFile: string | null): TerminationHoursWeek | null {
  if (!sourceFile) return null;
  const range = parseDateRangeFromFilename(sourceFile);
  if (!range) return null;
  const startIso = isoFromLocalDate(range.start);
  const endIso = isoFromLocalDate(range.end);
  if (endIso < startIso) return null;
  return { startIso, endIso, label: weekLabel(startIso, endIso) };
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

  // Read ONCE, attached to every `ready` return — including the miss, so the
  // facts sheet can say which week was actually asked.
  const week = readCycleWeek(index.sourceFile);

  const known = new Set<string>();
  for (const e of identity.emails) {
    const n = normEmail(e ?? '');
    if (n) known.add(n);
  }

  // 1. The address, exactly.
  for (const e of known) {
    if (index.emails.has(e)) return { state: 'ready', worked: true, matchedBy: `the address ${e}`, week };
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
        return { state: 'ready', worked: true, matchedBy: `the timesheet address ${indexed}`, week };
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
      return { state: 'ready', worked: true, matchedBy: `the name "${key}"`, week };
    }
  }
  for (const tokens of nameSets) {
    for (const indexed of index.nameTokenKeys) {
      if (isSubsetOrSuperset(tokens, indexed.split(' ').filter(Boolean))) {
        return { state: 'ready', worked: true, matchedBy: `the timesheet name "${indexed}"`, week };
      }
    }
  }

  return { state: 'ready', worked: false, matchedBy: null, week };
}
