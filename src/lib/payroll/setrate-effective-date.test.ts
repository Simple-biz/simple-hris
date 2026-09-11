import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { manilaTodayIso, sundayOf, payrollNotesWeekStart } from './manila-week';

/**
 * Guards for the Readiness / Notes-Offboarded "Set rate" effective-date field
 * (shipped 2026-09-11). The dialog is a client component, so the behavioural
 * rules that can be proven in pure code are proven here and the wiring is
 * source-scanned — the same shape as `settlement-currency-surfaces.test.ts`.
 *
 * The defect being closed: `SetRateDialog` sent no `effectiveDate`, the route
 * defaulted to today, and every save therefore stacked a today-dated row. For a
 * leaver — whose final pay is in the past by definition — "effective today"
 * cannot reach the week being paid, so the save reported success and changed
 * nothing. Carla hit it twice (2026-09-01, 2026-09-08) and Alivia once
 * (2026-09-11) before anyone read the rate history.
 */

const DIALOG_SRC = fs.readFileSync(
  path.join(process.cwd(), 'src/components/accounting/PayrollWizardNotesFab.tsx'),
  'utf8',
);

// ── the date the field is anchored on ────────────────────────────────────────

test('manilaTodayIso returns a plain YYYY-MM-DD date', () => {
  assert.match(manilaTodayIso(), /^\d{4}-\d{2}-\d{2}$/);
});

test('manilaTodayIso reads Manila, not the browser — the date rolls over there first', () => {
  // 2026-09-11 13:00 UTC is still Sep 11 in New York and already Sep 11 21:00
  // in Manila; at 17:00 UTC New York is on the 11th while Manila is on the 12th.
  const crossover = new Date('2026-09-11T17:00:00Z');
  assert.equal(manilaTodayIso(crossover), '2026-09-12');
});

test('payrollNotesWeekStart still resolves the week in arrears after the refactor', () => {
  // Fri 2026-09-11 Manila: this week is Sun 09-06, the week being PAID is 08-30.
  assert.equal(payrollNotesWeekStart(new Date('2026-09-11T04:00:00Z')), '2026-08-30');
});

// ── the hint cannot disagree with how the money is priced ────────────────────

test('the effective date maps to its Sun-Sat pay week, never a snapped one', () => {
  // gracechellem@'s case: 175 saved on Tue 09-01 split the 08-30 week in two.
  assert.equal(sundayOf('2026-09-01'), '2026-08-30');
  assert.equal(sundayOf('2026-08-30'), '2026-08-30', 'a Sunday is its own week start');
  assert.equal(sundayOf('2026-09-05'), '2026-08-30', 'Saturday closes the same week');
  assert.equal(sundayOf('2026-09-06'), '2026-09-06', 'the next Sunday starts the next week');
});

// ── class 3: the Sunday snap must never come back ────────────────────────────

test('the dialog sends the typed effective date verbatim — no snapping', () => {
  assert.match(
    DIALOG_SRC,
    /body: JSON\.stringify\(\{ structure, source: READINESS_SOURCE, effectiveDate \}\)/,
    'effectiveDate must go to the route exactly as typed',
  );
  const save = DIALOG_SRC.slice(
    DIALOG_SRC.indexOf('function SetRateDialog'),
    DIALOG_SRC.indexOf('function SetRateDialog') + 6000,
  );
  assert.ok(
    !/sundayOf\(effectiveDate\)\s*[,)]?\s*$/m.test(save.replace(/effectiveWeekStart[^\n]*\n/g, '')),
    'sundayOf may compute the DISPLAY hint, never the value that is sent',
  );
  assert.ok(
    !/mondayOf\(effectiveDate\)|payWeekEffectiveDate|snapTo/.test(save),
    'the deleted snap-to-Sunday module must not reappear in any form',
  );
});

// ── class 1: a blank date must refuse, never fall back to today ──────────────

test('a blank or unparseable effective date stops the save', () => {
  assert.match(
    DIALOG_SRC,
    /if \(!effectiveOk\) \{\s*\n\s*setError\("Pick the date this rate takes effect\."\);\s*\n\s*return;/,
    'the guard must return before setSaving, not substitute a date',
  );
  assert.ok(
    !/effectiveDate \|\| todayIso|effectiveDate \?\? todayIso|effectiveDate \|\| manilaTodayIso/.test(
      DIALOG_SRC,
    ),
    'no silent fallback to today — that IS the defect',
  );
});

test('the ISO shape test accepts only a full date', () => {
  const ok = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  assert.equal(ok('2026-08-30'), true);
  assert.equal(ok(''), false, 'a cleared date input reads as empty string');
  assert.equal(ok('2026-08'), false);
  assert.equal(ok('08/30/2026'), false);
});

// ── class 4: the copy must not still promise "effective immediately" ─────────

test('no surface still claims the rate is effective immediately', () => {
  assert.ok(
    !/effective immediately/i.test(DIALOG_SRC),
    'the dialog said "effective immediately" while writing a date the clerk chose',
  );
  const doc = fs.readFileSync(
    path.join(process.cwd(), 'docs/features/payroll-readiness.md'),
    'utf8',
  );
  assert.ok(
    !/effective immediately/i.test(doc),
    'payroll-readiness.md must not describe the old behaviour either',
  );
});

// ── the default is today, and that is load-bearing ───────────────────────────

test('the field defaults to today so an untouched save behaves exactly as before', () => {
  assert.match(
    DIALOG_SRC,
    /useState\(\(\) => manilaTodayIso\(\)\)/,
    'defaulting backwards to the week being paid would silently re-price every No Pay Rate save',
  );
});

// ── class 5: a back-date has to be re-locked to move money ───────────────────

test('a back-dated date warns that the week needs re-locking', () => {
  assert.match(DIALOG_SRC, /const isBackdated = effectiveOk && effectiveDate < todayIso/);
  assert.match(DIALOG_SRC, /re-lock that week afterwards or the disbursement keeps the old amount/);
});
