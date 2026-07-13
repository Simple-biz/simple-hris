/**
 * CallTools username minting — the Lead Gen dialer-username rule, including
 * HR's canonical example: James Thomas going by "Mikey" is "Mikey J. T."; a
 * second identical hire lengthens the surname slice to "Mikey J. TH.".
 *
 * Run:  npx tsx --test src/lib/hr/calltools-username.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calltoolsUsernameCandidates,
  firstNameInitial,
  formatCallToolsUsername,
  isLeadGenDepartment,
  suggestCallToolsUsername,
} from './calltools-username';

test('isLeadGenDepartment matches both HR labels, case/whitespace-insensitively', () => {
  assert.equal(isLeadGenDepartment('Lead Gen'), true);
  assert.equal(isLeadGenDepartment('  lead generation '), true);
  assert.equal(isLeadGenDepartment('LEAD GEN'), true);
  assert.equal(isLeadGenDepartment('Callback Team'), false);
  assert.equal(isLeadGenDepartment(''), false);
  assert.equal(isLeadGenDepartment(null), false);
});

test('firstNameInitial uses the first token only and folds accents', () => {
  assert.equal(firstNameInitial('James'), 'J');
  assert.equal(firstNameInitial('Mary Grace'), 'M');
  assert.equal(firstNameInitial('Álvaro'), 'A');
  assert.equal(firstNameInitial('  '), '');
  assert.equal(firstNameInitial(null), '');
});

test('formatCallToolsUsername assembles "<Nick> <F>. <SLICE>." with clean spacing', () => {
  assert.equal(formatCallToolsUsername('Mikey', 'J', 'T'), 'Mikey J. T.');
  assert.equal(formatCallToolsUsername('Mikey', 'j', 'th'), 'Mikey J. TH.');
  assert.equal(formatCallToolsUsername('  Mikey  Boy ', 'J', 'T'), 'Mikey Boy J. T.');
  // No surname letters -> no dangling period.
  assert.equal(formatCallToolsUsername('Mikey', 'J', ''), 'Mikey J.');
});

test('candidates walk progressive surname slices, most-preferred first', () => {
  assert.deepEqual(calltoolsUsernameCandidates('Mikey', 'James', 'Thomas'), [
    'Mikey J. T.',
    'Mikey J. TH.',
    'Mikey J. THO.',
    'Mikey J. THOM.',
    'Mikey J. THOMA.',
    'Mikey J. THOMAS.',
  ]);
  // Compound surname slices across the normalized whole ("Dela Cruz" -> DELACRUZ).
  assert.deepEqual(calltoolsUsernameCandidates('Kai', 'Jane', 'Dela Cruz').slice(0, 3), [
    'Kai J. D.',
    'Kai J. DE.',
    'Kai J. DEL.',
  ]);
  // Missing nickname or first name -> nothing to mint.
  assert.deepEqual(calltoolsUsernameCandidates('', 'James', 'Thomas'), []);
  assert.deepEqual(calltoolsUsernameCandidates('Mikey', '', 'Thomas'), []);
});

test('HR example: first Mikey J. T. is free; the second lengthens to TH.', () => {
  const taken = new Set<string>();
  const first = suggestCallToolsUsername('Mikey', 'James', 'Thomas', taken);
  assert.equal(first, 'Mikey J. T.');

  taken.add(first!);
  const second = suggestCallToolsUsername('Mikey', 'Jordan', 'Thackeray', taken);
  assert.equal(second, 'Mikey J. TH.');
});

test('taken comparison is case-insensitive', () => {
  const taken = new Set(['mikey j. t.']);
  assert.equal(
    suggestCallToolsUsername('Mikey', 'James', 'Thomas', taken),
    'Mikey J. TH.',
  );
});

test('exhausted surname falls back to the longest slice — never a numeric suffix', () => {
  const taken = new Set([
    'Mikey J. T.', 'Mikey J. TH.', 'Mikey J. THO.',
    'Mikey J. THOM.', 'Mikey J. THOMA.', 'Mikey J. THOMAS.',
  ]);
  assert.equal(
    suggestCallToolsUsername('Mikey', 'James', 'Thomas', taken),
    'Mikey J. THOMAS.',
  );
});

test('different nickname or initial is its own namespace — no false collisions', () => {
  const taken = new Set(['Mikey J. T.']);
  assert.equal(suggestCallToolsUsername('Mike', 'James', 'Thomas', taken), 'Mike J. T.');
  assert.equal(suggestCallToolsUsername('Mikey', 'Karl', 'Thomas', taken), 'Mikey K. T.');
});

test('no surname -> single nickname+initial candidate', () => {
  assert.equal(suggestCallToolsUsername('Mikey', 'James', '', new Set()), 'Mikey J.');
});
