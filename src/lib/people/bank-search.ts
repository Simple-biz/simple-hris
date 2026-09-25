/**
 * People → Search Bar: the ranked person lookup behind the bank search tab.
 *
 * Matches on **name and work email only** (Kane, 2026-09-25). Personal and
 * alternate emails, employee ID and department are deliberately NOT searched:
 * the tab answers "whose bank details are these", and a hit on someone's
 * personal address or department would put a stranger's name beside the query.
 *
 * Ranking mirrors Payment Catalog → Search (BonusCatalog.tsx `SearchTab`):
 * name prefix, then a word prefix, then anywhere in the name, then the work
 * email. Words split on anything that is not a letter or digit, because
 * roster names are surname-first with punctuation (`Cargo, James Adrian
 * "James"`), and a whitespace split would miss `"James"` for "james".
 *
 * **Nothing is capped here.** The catalog trims to 30. This tab pages instead,
 * so a common first name never silently drops the 31st match: a filter never
 * hides a row (people-rail-mix-kpi-band, dispatch-log-department-filter).
 */

/**
 * Does this roster row belong on the "Missing bank info" list? The ONE rule,
 * read by that KPI card and by the Search Bar's amber flag, so the two can
 * never disagree. `hasBanking` is `isPayoutComplete` (people-roster.ts), and US
 * employees (department "USEE") are an accepted exception: they are paid
 * through a separate channel, so no bank on file is not a gap for them.
 */
export function isMissingBankInfo(row: { hasBanking: boolean; department: string | null }): boolean {
  return !row.hasBanking && (row.department ?? '').trim().toUpperCase() !== 'USEE';
}

export interface BankSearchable {
  name: string | null;
  work_email: string | null;
}

/** Lower rank wins. Exported for the tests only. */
export const MATCH_RANK = {
  namePrefix: 0,
  wordPrefix: 1,
  nameContains: 2,
  workEmail: 3,
} as const;

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

/** The rank `row` earns for an already-trimmed, lowercased `q`, or null for no match. */
export function matchRank(row: BankSearchable, q: string): number | null {
  if (!q) return null;
  const name = (row.name ?? '').trim().toLowerCase();
  if (name) {
    if (name.startsWith(q)) return MATCH_RANK.namePrefix;
    if (name.split(WORD_SPLIT).some((w) => w && w.startsWith(q))) return MATCH_RANK.wordPrefix;
    if (name.includes(q)) return MATCH_RANK.nameContains;
  }
  const email = (row.work_email ?? '').trim().toLowerCase();
  if (email && email.includes(q)) return MATCH_RANK.workEmail;
  return null;
}

/**
 * Every row matching `query`, best match first; ties A→Z by name
 * (case-insensitive), so the order is stable while the user types. An empty
 * or whitespace-only query returns [], so an idle bar lists nobody.
 */
export function searchPeopleByNameOrEmail<T extends BankSearchable>(rows: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { row: T; rank: number }[] = [];
  for (const row of rows) {
    const rank = matchRank(row, q);
    if (rank != null) scored.push({ row, rank });
  }
  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.row.name ?? '').localeCompare(b.row.name ?? '', undefined, { sensitivity: 'base' }),
  );
  return scored.map((s) => s.row);
}
