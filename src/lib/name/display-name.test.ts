/**
 * Confirms the TS port {@link nameLastFirstQuoted} reproduces the SQL
 * `public.name_last_first_quoted()` outputs EXACTLY (migration #87 spot-checks),
 * so the master Google Sheet "Name" matches the Onboarding "Submitted" tab.
 *
 * Run:  npx tsx --test src/lib/name/display-name.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameLastFirstQuoted, masterListDisplayName } from './display-name';

test('nameLastFirstQuoted matches the SQL migration #87 spot-checks', () => {
  const cases: Array<[string | null | undefined, string | null]> = [
    ['Jan Kane Reroma', 'Reroma, Jan Kane "Kane"'],
    ['JAN KANE REROMA', 'Reroma, Jan Kane "Kane"'], // re-cased
    ['Maria Reyes', 'Reyes, Maria "Maria"'],
    ['Kyle S. Engalan', 'Engalan, Kyle S. "Kyle"'], // skips the bare initial
    ['Juan Cruz III', 'Cruz III, Juan "Juan"'], // suffix travels with surname
    ['Juan Dela Cruz Jr', 'Cruz Jr, Juan Dela "Dela"'], // compound-surname caveat
    ['Madonna', 'Madonna'], // mononym, unchanged
    ['jan@simple.biz', 'jan@simple.biz'], // address parked in a name column
    [null, null],
    ['', null],
    ['   ', null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(nameLastFirstQuoted(input), expected, `input: ${JSON.stringify(input)}`);
  }
});

test('masterListDisplayName falls back to the trimmed original when nothing to reorder', () => {
  assert.equal(masterListDisplayName('Jan Kane Reroma'), 'Reroma, Jan Kane "Kane"');
  assert.equal(masterListDisplayName('Madonna'), 'Madonna');
  assert.equal(masterListDisplayName(null), '');
  assert.equal(masterListDisplayName('  Madonna  '), 'Madonna');
});
