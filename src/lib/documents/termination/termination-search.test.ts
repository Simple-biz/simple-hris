/** [TERMINATION-DOCS]
 * The person search — the tab's FRONT DOOR — pinned at the source level.
 *
 * `termination-search.ts` opens with `import 'server-only'`, which does not
 * resolve under `node --import tsx --test`, so it cannot be imported here (the
 * same split that put the arbitration in its own module). What CAN be pinned is
 * the shape of its queries, and that is exactly where this search has already
 * been wrong once: it matched only exact, whole email addresses while the panel
 * promised name search in four places, so a rep holding a reference request for
 * someone who left in 2023 could not find them at all.
 *
 * Nothing here touches a database. `.env.local` holds PRODUCTION service-role
 * credentials, so reading the source off disk is the only acceptable shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  TERMINATION_SEARCH_CANDIDATE_CAP,
  TERMINATION_SEARCH_MIN_QUERY,
} from './types';

const DIR = path.join(process.cwd(), 'src', 'lib', 'documents', 'termination');
const SEARCH_SRC = fs.readFileSync(path.join(DIR, 'termination-search.ts'), 'utf8');
const TYPES_SRC = fs.readFileSync(path.join(DIR, 'types.ts'), 'utf8');
const ROUTE_SRC = fs.readFileSync(
  path.join(process.cwd(), 'app', 'api', 'accounting', 'documents', 'termination', 'search', 'route.ts'),
  'utf8',
);
const PANEL_SRC = fs.readFileSync(
  path.join(
    process.cwd(),
    'src',
    'components',
    'accounting',
    'termination-docs',
    'TerminationDocsPanel.tsx',
  ),
  'utf8',
);

/** Source with comments removed. Every assertion below is about CODE: the file
 *  header discusses `.or()` and `%` in prose, and a prose mention must never
 *  satisfy — or trip — a guard. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

const SEARCH_CODE = codeOnly(SEARCH_SRC);

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ─── The front door actually opens ───────────────────────────────────────────

test('the search filters on every NAME and EMAIL column of all three carriers', () => {
  // A rep with a reference request has a name. These are the columns that make
  // "find someone who left years ago" true; dropping one silently narrows the
  // front door back to "paste the exact address or give up".
  const required = [
    // global_master_list — the four email columns share one templated pass.
    "'Work Email',",
    "'Personal Email',",
    "'Alternate Work Email',",
    "'Alternate Work Email 2',",
    '.ilike(`"${col}"`, pat)',
    '.ilike(\'"Name"\', p)',
    // offboarded_sheet
    ".ilike('work_email', pat)",
    ".ilike('personal_email', pat)",
    ".ilike('name', p)",
    // offboarding_queue
    ".ilike('employee_personal_email', pat)",
    ".ilike('employee_email', pat)",
    ".ilike('employee_work_email', pat)",
    ".ilike('employee_name', p)",
  ];
  for (const needle of required) {
    assert.ok(
      SEARCH_CODE.includes(needle),
      `termination-search.ts must filter on ${needle} — the panel promises name AND email search`,
    );
  }
});

test('every ilike pattern is LIKE-escaped and %-wrapped', () => {
  // Two failure classes in one assertion. Unwrapped: only a whole, exact value
  // matches, and the search is unusable. Unescaped: `_` is an ILIKE single-char
  // wildcard, so `a_b@x.com` matches `axb@x.com` — a DIFFERENT PERSON — and a
  // `%` typed by the rep matches the table.
  assert.ok(
    /function containsPattern\(value: string\): string \{\s*return `%\$\{escapeLikePattern\(value\)\}%`;/.test(
      SEARCH_SRC,
    ),
    'containsPattern must be `%` + escapeLikePattern(value) + `%`',
  );
  assert.equal(
    count(SEARCH_CODE, '%${'),
    1,
    'exactly ONE place builds a LIKE pattern (containsPattern) — a second one is a second chance to forget the escape',
  );

  // Nine call sites, twelve columns: the four master email columns share one
  // templated pass over MASTER_EMAIL_COLUMNS.
  const args = [...SEARCH_CODE.matchAll(/\.ilike\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(args.length >= 9, 'the ilike passes must actually have been found');
  for (const arg of args) {
    assert.match(
      arg,
      /,\s*(pat|p)$/,
      `every .ilike must be fed a containsPattern value; got .ilike(${arg})`,
    );
  }
});

test('no .or() on an email value, anywhere in the search', () => {
  // PostgREST parses a logical filter as `column.op.value`; our values contain
  // dots, so the parser mis-splits and reports a bogus "column does not exist"
  // (global-master-list-db.ts:1359-1373). One .ilike per column instead.
  assert.equal(count(SEARCH_CODE, '.or('), 0);
});

test('every carrier read is paged', () => {
  // PostgREST truncates at db.max-rows (1000) EVEN WITH .range(), and the
  // offboarded ledger is past 4,000 rows. A truncated candidate set is
  // indistinguishable from "this person does not exist".
  const paged = count(SEARCH_CODE, 'selectAllPaged<Row>(');
  assert.ok(paged >= 9, `expected at least 9 paged passes, found ${paged}`);
  assert.equal(
    count(SEARCH_CODE, '.range(from, to)'),
    paged,
    'every selectAllPaged closure must apply the range it is handed',
  );
  assert.equal(
    count(SEARCH_CODE, ".order('id', { ascending: true })"),
    paged,
    'an unordered multi-page scan can shear under concurrent writes and drop a row',
  );
});

// ─── The two limits SPEAK ────────────────────────────────────────────────────

test('the candidate cap and the minimum query are real numbers, not decoration', () => {
  assert.ok(TERMINATION_SEARCH_CANDIDATE_CAP > 0);
  assert.ok(
    TERMINATION_SEARCH_MIN_QUERY >= 2,
    'a one-character `%a%` search is a table dump, not a result',
  );
});

test('a capped list is reported as capped, never silently truncated', () => {
  assert.ok(SEARCH_CODE.includes('TERMINATION_SEARCH_CANDIDATE_CAP'));
  assert.ok(
    /const truncated = all\.length > TERMINATION_SEARCH_CANDIDATE_CAP;/.test(SEARCH_CODE),
    'the cap must set `truncated` from the FULL match count, before slicing',
  );
  assert.ok(
    /matched: all\.length/.test(SEARCH_CODE),
    '`matched` must be the count BEFORE the cap — that is the number the rep needs',
  );
  // The response type carries both, non-optionally: a caller that forgets them
  // cannot compile, so the panel can never quietly hide a partial list.
  const block = TYPES_SRC.slice(
    TYPES_SRC.indexOf('export interface TerminationSearchResponse'),
  ).slice(0, 900);
  assert.ok(block.includes('truncated: boolean;'), 'truncated must be required on the response');
  assert.ok(block.includes('tooShort: boolean;'), 'tooShort must be required on the response');
  for (const needle of ['truncated', 'tooShort', 'matched']) {
    assert.ok(
      ROUTE_SRC.includes(needle),
      `the search route must pass ${needle} through to the panel`,
    );
  }
});

test('a too-short query runs NO read and says so', () => {
  assert.ok(
    /if \(q\.length < TERMINATION_SEARCH_MIN_QUERY\) \{[\s\S]{0,200}tooShort: true/.test(SEARCH_CODE),
    'a fragment under the minimum must return tooShort BEFORE any client is built',
  );
  const guardAt = SEARCH_CODE.indexOf('TERMINATION_SEARCH_MIN_QUERY');
  const clientAt = SEARCH_CODE.indexOf('createSupabaseServiceRoleClient()');
  assert.ok(guardAt > 0 && clientAt > guardAt, 'the length guard must precede the read');
});

// ─── The panel tells the truth about all of it ───────────────────────────────

test('the panel renders the too-short and capped states, and promises name search', () => {
  assert.ok(
    PANEL_SRC.includes('TERMINATION_SEARCH_MIN_QUERY'),
    'the panel must state the minimum it enforces, not leave the rep guessing',
  );
  assert.ok(PANEL_SRC.includes('searchTooShort'), 'the too-short state needs its own pane');
  assert.ok(PANEL_SRC.includes('searchTruncated'), 'a capped list must be announced');
  assert.ok(PANEL_SRC.includes('This list is capped'));
  // The four places that promise name search are now backed by a name pass.
  assert.ok(PANEL_SRC.includes('Search a name, a surname, a work email or a personal email'));
});

// ─── G1 at the source level: a name/personal match IDENTIFIES nothing ────────

test('G1: only a WORK email column ever becomes the identity', () => {
  // The master passes read the identity off the row's own "Work Email" column —
  // never off the column the query happened to match — and a queue row without
  // employee_work_email is skipped rather than identified by its personal inbox.
  assert.ok(SEARCH_CODE.includes("workEmail: normEmail(str(r['Work Email']))"));
  assert.ok(SEARCH_CODE.includes("workEmail: normEmail(str(r['work_email']))"));
  assert.ok(SEARCH_CODE.includes("const work = normEmail(str(r['employee_work_email']));"));
  assert.match(
    SEARCH_CODE.slice(SEARCH_CODE.indexOf("const work = normEmail(str(r['employee_work_email']));")),
    /if \(!work\) continue;/,
    'a queue row with no work email cannot name a person this feature may document',
  );
  // And the resolver is still keyed on the work email alone.
  assert.ok(
    /searchTerminationCandidates\(\s*query: string,\s*\)/.test(SEARCH_SRC),
    'search takes the rep query; facts take a work email — the two are never the same argument',
  );
});
