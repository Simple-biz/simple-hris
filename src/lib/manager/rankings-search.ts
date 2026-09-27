/**
 * Search for every My Team Rankings view — SP (`RankingsPane`), the appointment and
 * KPI leaderboards (`AppointmentLeaderboardPane`). Kane, 2026-09-27: *"For all the
 * rankings tab lets add a search bar so we can search names and work emails"*.
 *
 * PURE, so `node:test` pins the two rules that matter:
 *
 * - **Names and WORK emails only — never a personal address.** That is what Kane
 *   asked for, and it is the team tab's standing lesson (`employee-team-directory.md`):
 *   a search that matches a field the board does not show makes the redaction
 *   cosmetic. So the haystack is the name the row DISPLAYS plus the roster row's work
 *   email and its two alternates. A personal email is only ever a lookup KEY
 *   ({@link workEmailIndex}), never matched.
 * - **Filtering never re-ranks.** The views keep each row's real position; the search
 *   only hides the others (and the podium, whose slots would otherwise hold #7).
 */
import { normEmail } from '@/lib/email/norm-email';

/** Trim, lower-case, collapse whitespace. */
export function normalizeRankingQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Name punctuation ("Dacara, Ramil \"Ram\"") never blocks a match. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/["'“”‘’,()]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * True when EVERY word of the (normalized) query appears in the row's name or one of
 * its work emails — so "ram dacara" finds `Dacara, Ramil "Ram"` and "jeff@" finds
 * `jeff@simple.biz`. An empty query matches everything.
 */
export function rankingRowMatches(
  normalizedQuery: string,
  fields: { name: string | null | undefined; workEmails: readonly (string | null | undefined)[] },
): boolean {
  if (!normalizedQuery) return true;
  const haystack = [
    normalizeName(fields.name ?? ''),
    ...fields.workEmails.map((e) => normEmail(e ?? null)).filter((e): e is string => !!e),
  ].join(' ');
  return normalizedQuery.split(' ').every((token) => haystack.includes(token));
}

export interface WorkEmailFields {
  work_email?: string | null;
  alternate_work_email?: string | null;
  alternate_work_email_2?: string | null;
}

/** A roster row's WORK addresses: the work email and both alternates. Never the personal email. */
export function workEmailsOf(m: WorkEmailFields): string[] {
  return [m.work_email, m.alternate_work_email, m.alternate_work_email_2]
    .map((e) => normEmail(e ?? null))
    .filter((e): e is string => !!e);
}

/**
 * Every address a roster row carries → that row's WORK addresses.
 *
 * SP ranking rows are keyed by the applied row's email, which is personal-first
 * (`bonus_catalog_applied`), so the SP view finds a person's work email through this
 * map. The personal address is a KEY here and is never part of what is matched.
 */
export function workEmailIndex(
  members: readonly (WorkEmailFields & { personal_email?: string | null })[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of members) {
    const work = workEmailsOf(m);
    if (work.length === 0) continue;
    for (const key of [m.personal_email, m.work_email, m.alternate_work_email, m.alternate_work_email_2]) {
      const k = normEmail(key ?? null);
      if (k && !out.has(k)) out.set(k, work);
    }
  }
  return out;
}
