/**
 * Tests for the human-name sanitizer.
 *
 * Run:  npx tsx --test src/lib/text/sanitize-name.test.ts
 *   (or `npm test`, which globs src/**\/*.test.ts)
 *
 * Focus: toTitleCaseName() — re-casing SHOUTED / all-lowercase names into Title
 * Case while leaving intentionally mixed-case names, emails parked in a name
 * column, and non-cased strings untouched. The corpus mirrors real onboarding
 * data (Filipino + US names) plus the documented edge cases.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName, toTitleCaseName, toTitleCaseNameOrNull } from './sanitize-name';

// input -> expected, grouped by category for readable failures.
const CASES: Array<{ input: string; expected: string; category: string }> = [
  // all-caps (the common Submitted-column case)
  { input: 'ANGEL OCAMPO', expected: 'Angel Ocampo', category: 'all-caps' },
  { input: 'KC LYN ROPAL', expected: 'Kc Lyn Ropal', category: 'all-caps (no initial detection)' },
  { input: 'KYLE S. ENGALAN', expected: 'Kyle S. Engalan', category: 'middle initial w/ period' },
  { input: 'WILMAR LOUIE SORIANO LAGUYO', expected: 'Wilmar Louie Soriano Laguyo', category: 'all-caps multi-word' },
  { input: 'MIGUEL DIEN MAYOR', expected: 'Miguel Dien Mayor', category: 'all-caps' },
  { input: 'MARGIELINE GABO', expected: 'Margieline Gabo', category: 'all-caps' },
  { input: 'ADELSON MANANQUIL', expected: 'Adelson Mananquil', category: 'all-caps' },
  { input: 'CLAYTON COLLADO GABAN', expected: 'Clayton Collado Gaban', category: 'all-caps' },

  // all-lowercase
  { input: 'juan dela cruz', expected: 'Juan Dela Cruz', category: 'all-lower' },
  { input: 'angel ocampo', expected: 'Angel Ocampo', category: 'all-lower' },
  { input: 'maria', expected: 'Maria', category: 'all-lower single word' },

  // already mixed-case -> UNCHANGED (intentional casing)
  { input: 'McDonald', expected: 'McDonald', category: 'mixed-case unchanged' },
  { input: 'de la Cruz', expected: 'de la Cruz', category: 'mixed-case unchanged' },
  { input: 'DeShawn', expected: 'DeShawn', category: 'mixed-case unchanged' },
  { input: "O'Brien", expected: "O'Brien", category: 'mixed-case unchanged' },
  { input: 'MacArthur', expected: 'MacArthur', category: 'mixed-case unchanged' },
  { input: 'van der Berg', expected: 'van der Berg', category: 'mixed-case unchanged' },
  { input: 'de la Cruz III', expected: 'de la Cruz III', category: 'mixed-case unchanged' },
  { input: 'Jose Rizal', expected: 'Jose Rizal', category: 'mixed-case unchanged' },
  { input: "d'Artagnan", expected: "d'Artagnan", category: 'mixed-case unchanged' },

  // hyphenated
  { input: 'ANNE-MARIE', expected: 'Anne-Marie', category: 'hyphen all-caps' },
  { input: 'anne-marie', expected: 'Anne-Marie', category: 'hyphen all-lower' },
  { input: 'MARY-JANE WATSON-PARKER', expected: 'Mary-Jane Watson-Parker', category: 'hyphen multi-word' },

  // apostrophe
  { input: "O'BRIEN", expected: "O'Brien", category: 'apostrophe all-caps' },
  { input: "D'ANGELO", expected: "D'Angelo", category: 'apostrophe all-caps' },
  { input: "o'brien", expected: "O'Brien", category: 'apostrophe all-lower' },

  // generational suffix (ii/iii/iv only)
  { input: 'DELA CRUZ JR.', expected: 'Dela Cruz Jr.', category: 'suffix non-matching' },
  { input: 'JUAN DELA CRUZ III', expected: 'Juan Dela Cruz III', category: 'suffix III' },
  { input: 'JUAN DELA CRUZ II', expected: 'Juan Dela Cruz II', category: 'suffix II' },
  { input: 'JUAN DELA CRUZ IV', expected: 'Juan Dela Cruz IV', category: 'suffix IV' },
  { input: 'juan dela cruz iii', expected: 'Juan Dela Cruz III', category: 'suffix (lower input)' },
  { input: 'HENRY GMV V', expected: 'Henry Gmv V', category: 'suffix NOT handled (V)' },
  { input: 'LOUIS XIV', expected: 'Louis Xiv', category: 'suffix NOT handled (XIV)' },
  { input: 'POPE VI', expected: 'Pope Vi', category: 'suffix NOT handled (VI)' },
  { input: 'III', expected: 'III', category: 'suffix-only' },
  { input: 'VI', expected: 'Vi', category: 'numeral-looking name guard' },
  { input: 'IX', expected: 'Ix', category: 'numeral-looking name guard' },

  // Mc handling (Mc only, not Mac)
  { input: 'MCDONALD', expected: 'McDonald', category: 'Mc all-caps' },
  { input: 'MCKAY', expected: 'McKay', category: 'Mc all-caps' },
  { input: 'mcdonald', expected: 'McDonald', category: 'Mc all-lower' },
  { input: 'MACARTHUR', expected: 'Macarthur', category: 'Mac NOT Mc-fixed' },
  { input: 'MCAULAY MCBRIDE', expected: 'McAulay McBride', category: 'multiple Mc' },

  // short surnames (gmail-surname-shaped values, though that column is excluded)
  { input: 'M', expected: 'M', category: 'single letter' },
  { input: 'TI', expected: 'Ti', category: '2-letter' },
  { input: 'CO', expected: 'Co', category: '2-letter' },
  { input: 'BO', expected: 'Bo', category: '2-letter' },
  { input: 'AN', expected: 'An', category: '2-letter' },

  // email parked in a name column -> UNCHANGED
  { input: 'jan@simple.biz', expected: 'jan@simple.biz', category: 'email unchanged' },
  { input: 'ABIGAILV@SIMPLE.BIZ', expected: 'ABIGAILV@SIMPLE.BIZ', category: 'email all-caps unchanged' },
  { input: 'Kc.Lyn@simple.biz', expected: 'Kc.Lyn@simple.biz', category: 'email mixed unchanged' },

  // accents preserved
  { input: 'JOSÉ', expected: 'José', category: 'accented all-caps' },
  { input: 'José', expected: 'José', category: 'accented mixed unchanged' },
  { input: 'josé garcía', expected: 'José García', category: 'accented all-lower' },
  { input: 'MARÍA NIÑO', expected: 'María Niño', category: 'accented all-caps multi-word' },

  // whitespace / empty
  { input: '  ANGEL   OCAMPO  ', expected: 'Angel Ocampo', category: 'extra spaces' },
  { input: ' mary-jane ', expected: 'Mary-Jane', category: 'spaces + hyphen' },
  { input: '   ', expected: '', category: 'whitespace only' },
  { input: '', expected: '', category: 'empty' },

  // non-cased
  { input: '123', expected: '123', category: 'no cased letters unchanged' },

  // combined
  { input: "O'BRIEN-MCKAY III", expected: "O'Brien-McKay III", category: 'apostrophe+hyphen+Mc+suffix' },
  { input: 'DELA-CRUZ, JUAN', expected: 'Dela-Cruz, Juan', category: 'comma + hyphen' },
  { input: 'jose mcdonald iv', expected: 'Jose McDonald IV', category: 'all-lower Mc + suffix' },
];

for (const { input, expected, category } of CASES) {
  test(`[${category}] ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
    assert.equal(toTitleCaseName(input), expected);
  });
}

test('toTitleCaseName is idempotent on its own output', () => {
  for (const { input } of CASES) {
    const once = toTitleCaseName(input);
    assert.equal(toTitleCaseName(once), once, `not idempotent for ${JSON.stringify(input)}`);
  }
});

test('toTitleCaseNameOrNull returns null for empty/whitespace, preserves null', () => {
  assert.equal(toTitleCaseNameOrNull(null), null);
  assert.equal(toTitleCaseNameOrNull(undefined), null);
  assert.equal(toTitleCaseNameOrNull(''), null);
  assert.equal(toTitleCaseNameOrNull('   '), null);
  assert.equal(toTitleCaseNameOrNull('ANGEL OCAMPO'), 'Angel Ocampo');
});

test('toTitleCaseName composes with sanitizeName (Unicode fold still applies)', () => {
  // A math-italic "K" (U+1D40A) folds to ASCII "K" via NFKC, then title-cases.
  const styled = '\u{1D40A}\u{1D427}\u{1D420}\u{1D41E}\u{1D425}'; // styled "Kngel"-ish glyphs
  const out = toTitleCaseName(styled);
  assert.equal(sanitizeName(out), out, 'output should be plain ASCII after folding');
  assert.ok(!/[^\x00-\x7F]/.test(out), 'no non-ASCII should survive');
});
