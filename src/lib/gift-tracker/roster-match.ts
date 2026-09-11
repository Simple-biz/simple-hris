/**
 * Resolve a person in an imported sheet to their master-list row.
 *
 * WHY THIS EXISTS
 * ---------------
 * The 2026-09-11 gift backfill matched on `work_email` alone. Fifteen people
 * whose sheet spelling differs from the roster, or whose master row has gone
 * stale, resolved to the wrong thing, so their gift receipts were stored under
 * an address the Gift Tracker never looks up. The tracker then showed them as
 * "Not recorded" — the state meaning *nobody has assessed this person* — so the
 * failure was invisible and read as its own opposite. `lennyt@simple.biz`
 * (roster: `lenny@simple.biz`) is the case that surfaced it.
 *
 * THE LADDER, STRONGEST KEY FIRST
 * -------------------------------
 *   1. work_email            exact
 *   2. employee_id           exact   ← the most discriminating key either side has
 *   3. alternate work email  exact
 *   4. legal name AND start date, both exact
 *
 * `employee_id` sits above the email tiers because it is unique across all 2,698
 * master rows, needs no name normalisation, and on the live data resolves every
 * stranded person on its own. It is NOT a durable cross-system key — the
 * `employee_ids` table disagrees with `global_master_list` for a handful of
 * people because it is regenerated per upload — so it is used only to match the
 * SHEET against the MASTER LIST, which are the two sources that agree on it
 * (1,211 of 1,216 resolvable rows).
 *
 * Every tier demands an EXACT match. There is no fuzzy string distance here on
 * purpose: `lenny@` vs `lennyt@` and `jo@` vs `joe@` are the same edit distance
 * apart, and one of those pairs is two different people. Similarity proposes
 * nothing; only an exact agreement on an independent field does.
 *
 * A TIER-1 HIT ON A STALE ROW IS NOT AN ANSWER
 * --------------------------------------------
 * This is the trap a work-email-only ladder cannot see, because tier 1 succeeds
 * and nothing falls through. `global_master_list` carries 216 rows that are
 * absent from `active_employees` and carry no off-board date at all — ghosts.
 * Two of them hold gift receipts for people who are sitting on the active roster
 * right now under a different address:
 *
 *   teodya@simple.biz  → Amaro, Teody        is active at james@simple.biz
 *   mat@simple.biz     → Tanjusay, Maria Fe  is active at maria@simple.biz
 *
 * So when tier 1 matches a person who is NOT on the active roster, the ladder
 * keeps going, and if a later tier finds exactly one ACTIVE row for the same
 * human at a different address, that wins and the stale key is reported. A
 * successful tier-1 match that is never questioned is the only false match this
 * module was actually producing.
 *
 * AMBIGUITY IS A REFUSAL, NEVER A PICK
 * ------------------------------------
 * If a tier produces more than one candidate the resolver stops and reports
 * `ambiguous` with every candidate listed. It does NOT fall through to a looser
 * tier and it does NOT choose. The master list genuinely contains distinct
 * people sharing a normalised name AND a start date, and 25 work emails that two
 * different humans have held. Merging two people's gift history is permanent and
 * silent; an unresolved row is visible and recoverable.
 *
 * PERSONAL EMAIL IS DELIBERATELY NOT A MATCHING KEY
 * -------------------------------------------------
 * `personal_email` is not injective on this roster — `russell@simple.biz` and
 * `johnc@simple.biz` share `corpuzmachacon@gmail.com`, which is the whole reason
 * the receipts table is keyed on work email. Matching on it would fuse exactly
 * the two people the storage key was designed to keep apart.
 *
 * NAME ALONE AND START DATE ALONE ARE BOTH REFUSED
 * ------------------------------------------------
 * A whole onboarding cohort shares a start date, and names repeat. Tier 4
 * requires BOTH, and still refuses when two rows satisfy both.
 */

/** How a match was established. Always recorded — a tier-4 match is not the
 *  same fact as a tier-1 match and must never be presented as one. */
export type RosterMatchMethod =
  | 'work_email'
  | 'employee_id'
  | 'alternate_work_email'
  | 'name_and_start_date';

export interface RosterPerson {
  name: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  alternateWorkEmails: readonly (string | null | undefined)[];
  /** Raw master-list start date, in whatever spelling the source holds. */
  startDate: string | null;
  /** `global_master_list.employee_id`, e.g. "2406-0037". */
  employeeId?: string | null;
  /** Present on `active_employees`. A false here is what makes a row a ghost. */
  isActive?: boolean;
}

export interface RosterQuery {
  workEmail: string | null;
  name: string | null;
  /** Raw start date from the source being imported. */
  startDate: string | null;
  /** The source sheet's own employee id, when it carries one. */
  employeeId?: string | null;
}

export type RosterMatchResult =
  | {
      status: 'matched';
      person: RosterPerson;
      key: string;
      method: RosterMatchMethod;
      /**
       * Set when tier 1 matched a NON-ACTIVE row and a later tier found the same
       * human active at a different address. The value is the stale key that was
       * abandoned. Callers must surface it — it means the roster holds a ghost.
       */
      supersededStaleKey?: string;
    }
  | { status: 'ambiguous'; method: RosterMatchMethod; candidates: RosterPerson[] }
  | { status: 'unmatched' };

export function normEmail(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase();
}

/**
 * Is this actually an address, rather than a note somebody typed into the
 * column?
 *
 * `global_master_list` really holds `"waiting on ppwk"` and
 * `"issues with automation"` as Work Email values. Without this check the
 * resolver would happily store a person's gift history under the key
 * `issues with automation`, which is the same stranding this module exists to
 * prevent, wearing a funnier hat.
 */
export function isEmailShaped(raw: string | null | undefined): boolean {
  const v = normEmail(raw);
  if (!v || /\s/.test(v)) return false;
  const at = v.indexOf('@');
  return at > 0 && at < v.length - 1 && v.indexOf('@', at + 1) === -1;
}

/**
 * Reduce a display name to something comparable across sources.
 *
 * `Tesalona, Maria Linda "Lenny"` → `linda maria tesalona`.
 *
 * The quoted go-by nickname is DROPPED: the sheet and the master list disagree
 * about it constantly, and it is the least stable part of a name. Punctuation
 * goes, case goes, and the remaining tokens are SORTED so `Surname, First` and
 * `First Surname` compare equal.
 *
 * Sorting is the deliberate trade: it makes the comparison order-insensitive at
 * the cost of treating a genuine first/last-name swap between two different
 * people as equal. That residue is what tier 4's start-date requirement and the
 * ambiguity refusal exist to catch.
 */
export function normName(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw)
    .replace(/"[^"]*"/g, ' ')
    .replace(/[^A-Za-z\s]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;

/**
 * Normalise a start date to `YYYY-MM-DD` for COMPARISON ONLY.
 *
 * THIS DOES NOT GO THROUGH `Date`, AND THAT IS THE POINT.
 *
 * `parseStartDate` reads a date-only ISO string (`2023-04-10`) as UTC midnight
 * but an `M/D/YY` string (`4/10/23`) as LOCAL midnight. Anywhere west of UTC
 * those two spellings of the same day normalise to two different keys — the
 * master list holds `4/10/23` and a sheet may hold `2023-04-10`, and the tier-4
 * match would silently fail on a person whose dates actually agree. That is the
 * same class of silent stranding this whole module exists to close, so the
 * comparison key is built from the string's own digits and never enters a
 * timezone.
 *
 * This is NOT a second milestone-date rule and must never become one: nothing
 * here computes a milestone, a due-ness, or a gift date. Milestone math stays
 * exclusively in `gift-milestones.ts`.
 *
 * Only the two spellings this roster actually holds are accepted. **Anything
 * else is REFUSED (`null`)**, which costs a match rather than inventing one. A
 * two-digit year maps to `20YY`; every start date on this roster is 2022 or
 * later, and a wrong century fails to match rather than mis-matching.
 */
export function normStartDate(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;

  const pad = (v: string) => v.padStart(2, '0');
  const valid = (y: number, m: number, d: number) =>
    m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2999;

  const iso = ISO_DATE.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    if (!valid(Number(y), Number(m), Number(d))) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  const us = US_DATE.exec(s);
  if (us) {
    const [, m, d, rawYear] = us;
    const y = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
    if (!valid(y, Number(m), Number(d))) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  return null;
}

function normId(raw: string | null | undefined): string {
  return (raw ?? '').trim().toUpperCase();
}

/**
 * Two master rows that are the SAME row duplicated — same person, same
 * destination — rather than two candidates.
 *
 * All three must agree: the work email (so both would store to the same key),
 * the normalised name, and the start date.
 *
 * The work-email half is what keeps this safe. `teodya@simple.biz` has two
 * master rows agreeing on all three (one person imported twice under different
 * employee ids) — collapsing them is required, or the resolver refuses a person
 * it could have placed. But `tinag@`/`tina@` (Garces, Cristina — same name, same
 * start date, two ACTIVE addresses) and `josephr@` (Robles then Ramos — one
 * address, two humans) must both stay separate: the first because the two rows
 * disagree about where to store, the second because they are different people.
 * Collapsing on name+date alone would silently pick one of those, which is the
 * exact irreversible harm this module refuses to commit.
 */
function isDuplicateRow(a: RosterPerson, b: RosterPerson): boolean {
  const ae = normEmail(a.workEmail);
  const be = normEmail(b.workEmail);
  if (!ae || ae !== be) return false;
  const an = normName(a.name);
  const bn = normName(b.name);
  if (!an || !bn || an !== bn) return false;
  const ad = normStartDate(a.startDate);
  const bd = normStartDate(b.startDate);
  return ad !== null && ad === bd;
}

export interface RosterIndex {
  byWorkEmail: Map<string, RosterPerson[]>;
  byEmployeeId: Map<string, RosterPerson[]>;
  byAlternateEmail: Map<string, RosterPerson[]>;
  byNameAndStart: Map<string, RosterPerson[]>;
  people: RosterPerson[];
}

/**
 * Build the lookup index once for the whole import.
 *
 * **Pass every master row — do not pre-collapse them into a Map first.** A
 * caller that dedupes on work email before calling this has already discarded
 * the recycled-address collisions this index exists to report, and the resolver
 * will then call an ambiguous key unambiguous.
 *
 * Every bucket is a LIST. Two rows land in one bucket only when they are
 * genuinely two people; duplicate rows for ONE human collapse to a single entry,
 * preferring the ACTIVE row so a ghost never shadows a live address.
 *
 * A person's own work email is excluded from their alternate bucket, so a row
 * whose alternate duplicates its primary cannot masquerade as corroboration —
 * `brigitte@` and `joe@` both do exactly that on the live roster.
 */
export function buildRosterIndex(people: readonly RosterPerson[]): RosterIndex {
  const byWorkEmail = new Map<string, RosterPerson[]>();
  const byEmployeeId = new Map<string, RosterPerson[]>();
  const byAlternateEmail = new Map<string, RosterPerson[]>();
  const byNameAndStart = new Map<string, RosterPerson[]>();

  const push = (map: Map<string, RosterPerson[]>, key: string, p: RosterPerson) => {
    if (!key) return;
    const arr = map.get(key);
    if (!arr) {
      map.set(key, [p]);
      return;
    }
    const dupeAt = arr.findIndex((q) => isDuplicateRow(q, p));
    if (dupeAt === -1) {
      arr.push(p);
      return;
    }
    // Same human, two rows. Keep ONE, and prefer the live address.
    if (!arr[dupeAt].isActive && p.isActive) arr[dupeAt] = p;
  };

  for (const p of people) {
    const work = normEmail(p.workEmail);
    if (isEmailShaped(work)) push(byWorkEmail, work, p);

    const id = normId(p.employeeId);
    if (id) push(byEmployeeId, id, p);

    for (const alt of p.alternateWorkEmails ?? []) {
      const a = normEmail(alt);
      // An alternate that merely repeats the primary is not a second fact.
      if (isEmailShaped(a) && a !== work) push(byAlternateEmail, a, p);
    }

    const n = normName(p.name);
    const s = normStartDate(p.startDate);
    // Both halves required — a missing one must not collapse into a wildcard
    // bucket that every dateless person shares.
    if (n && s) push(byNameAndStart, `${n}|${s}`, p);
  }

  return { byWorkEmail, byEmployeeId, byAlternateEmail, byNameAndStart, people: [...people] };
}

interface Tier {
  method: RosterMatchMethod;
  hits: RosterPerson[];
}

function tiersFor(index: RosterIndex, query: RosterQuery): Tier[] {
  const tiers: Tier[] = [];

  const work = normEmail(query.workEmail);
  if (isEmailShaped(work)) {
    tiers.push({ method: 'work_email', hits: index.byWorkEmail.get(work) ?? [] });
  }

  const id = normId(query.employeeId);
  if (id) tiers.push({ method: 'employee_id', hits: index.byEmployeeId.get(id) ?? [] });

  if (isEmailShaped(work)) {
    tiers.push({
      method: 'alternate_work_email',
      hits: index.byAlternateEmail.get(work) ?? [],
    });
  }

  const n = normName(query.name);
  const s = normStartDate(query.startDate);
  if (n && s) {
    tiers.push({
      method: 'name_and_start_date',
      hits: index.byNameAndStart.get(`${n}|${s}`) ?? [],
    });
  }

  return tiers;
}

/**
 * An ambiguous tier is not always the end.
 *
 * The ladder refuses to fall through to a LOOSER tier — a looser key cannot
 * settle what a stricter one could not. But a MORE DISCRIMINATING key can, and
 * the source sheet carries one the tier-1 address does not: `employee_id`.
 *
 * On the live roster `jamesc@simple.biz` is held by two different humans
 * (Ceballos, James Ryan and Chan, James Edward), and nine more addresses have
 * two master rows for ONE person whose name is spelled differently across them
 * (`Montano`/`Montaño`, a middle initial, a stray smart quote). Stopping at the
 * ambiguous address would import nothing for any of the thirteen, when the sheet
 * row says exactly which record it means.
 *
 * So: narrow the candidate set with an exact key, and accept ONLY if exactly one
 * survives. This never widens the set and never reaches outside it.
 */
function disambiguate(
  candidates: readonly RosterPerson[],
  query: RosterQuery,
): { person: RosterPerson; method: RosterMatchMethod } | null {
  const id = normId(query.employeeId);
  if (id) {
    const byId = candidates.filter((c) => normId(c.employeeId) === id);
    if (byId.length === 1) return { person: byId[0], method: 'employee_id' };
  }

  const n = normName(query.name);
  const d = normStartDate(query.startDate);
  if (n && d) {
    const byNameDate = candidates.filter(
      (c) => normName(c.name) === n && normStartDate(c.startDate) === d,
    );
    if (byNameDate.length === 1) {
      return { person: byNameDate[0], method: 'name_and_start_date' };
    }
  }

  return null;
}

function resolved(person: RosterPerson, method: RosterMatchMethod): RosterMatchResult {
  const key = normEmail(person.workEmail);
  // A master row with no usable work email has no storable key. Refusing is
  // correct: inventing one from the sheet is precisely the defect being fixed.
  if (!isEmailShaped(key)) return { status: 'unmatched' };
  return { status: 'matched', person, key, method };
}

/**
 * Walk the ladder. Returns the FIRST tier that produces exactly one candidate.
 *
 * A tier producing more than one candidate REFUSES outright — it does not
 * continue to a looser tier, because a looser tier cannot resolve an ambiguity a
 * stricter one could not.
 *
 * The one exception is the stale-primary rule: a tier-1 hit on a row that is not
 * on the ACTIVE roster keeps walking, and yields to exactly one active row for
 * the same human found at a later tier. See the module header.
 *
 * The returned `key` is always the matched person's MASTER-LIST work email:
 * that is the address every downstream reader looks receipts up under, and
 * storing anything else is what caused this bug in the first place.
 */
export function matchRosterPerson(
  index: RosterIndex,
  query: RosterQuery,
): RosterMatchResult {
  const tiers = tiersFor(index, query);

  for (let i = 0; i < tiers.length; i += 1) {
    const tier = tiers[i];
    if (tier.hits.length === 0) continue;
    if (tier.hits.length > 1) {
      const narrowed = disambiguate(tier.hits, query);
      if (!narrowed) {
        return { status: 'ambiguous', method: tier.method, candidates: [...tier.hits] };
      }
      return resolved(narrowed.person, narrowed.method);
    }

    const person = tier.hits[0];

    // STALE PRIMARY: tier 1 landed on a row the active roster does not carry.
    // Keep walking; a later tier may find the same human, live, elsewhere.
    if (tier.method === 'work_email' && person.isActive === false) {
      const live: RosterPerson[] = [];
      let liveMethod: RosterMatchMethod = tier.method;
      for (let j = i + 1; j < tiers.length; j += 1) {
        const actives = tiers[j].hits.filter(
          (p) => p.isActive && normEmail(p.workEmail) !== normEmail(person.workEmail),
        );
        if (actives.length === 0) continue;
        for (const a of actives) if (!live.some((q) => isDuplicateRow(q, a))) live.push(a);
        if (live.length > 0) {
          liveMethod = tiers[j].method;
          break;
        }
      }
      if (live.length > 1) {
        const narrowed = disambiguate(live, query);
        if (!narrowed) {
          return { status: 'ambiguous', method: liveMethod, candidates: live };
        }
        const out = resolved(narrowed.person, narrowed.method);
        return out.status === 'matched'
          ? { ...out, supersededStaleKey: normEmail(person.workEmail) }
          : out;
      }
      if (live.length === 1) {
        const out = resolved(live[0], liveMethod);
        if (out.status === 'matched') {
          return { ...out, supersededStaleKey: normEmail(person.workEmail) };
        }
        return out;
      }
      // Nobody live anywhere else — the stale row is genuinely all there is.
    }

    return resolved(person, tier.method);
  }

  return { status: 'unmatched' };
}
