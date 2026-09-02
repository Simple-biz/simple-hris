import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { internDaysFromRow, internWeekFromFilename, parseInternHoursCsv, weekDays } from './intern-hours-csv';

const FILE = 'interns_weekly_2026-08-30_to_2026-09-05.csv';

const CSV = [
  'Member,Email,Job type,Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Total worked',
  'Maria Intern,maria@pathway.ph,Intern,,1:00:00,1:30:00,,2:00:00,,,4:30:00',
  'Kane Reroma,kaner@simple.biz,Accounting,,8:00:00,8:00:00,8:00:00,8:00:00,8:00:00,,40:00:00',
  'Juan Intern,JUAN@Pathway.PH,Intern,,,,,,,,0:00:00',
  ',,,,,,,,,,',
].join('\n');

test('the filename addresses one Sunday-to-Saturday week', () => {
  assert.deepEqual(internWeekFromFilename(FILE), { ok: true, weekStart: '2026-08-30', weekEnd: '2026-09-05' });
  assert.equal(internWeekFromFilename('interns.csv').ok, false);
  // Monday start
  assert.equal(internWeekFromFilename('x_2026-08-31_to_2026-09-06.csv').ok, false);
  // 8-day Sun→Sun
  assert.equal(internWeekFromFilename('x_2026-08-30_to_2026-09-06.csv').ok, false);
});

test('interns are stored, Simple rows are REFUSED and reported, blank rows are skipped', () => {
  const r = parseInternHoursCsv(CSV, FILE);
  assert.ok(r.ok);
  assert.deepEqual(r.rows.map((x) => x.email), ['maria@pathway.ph', 'juan@pathway.ph']);
  assert.equal(r.rows[0].name, 'Maria Intern');
  assert.equal(r.rows[0].row['Monday'], '1:00:00');
  assert.deepEqual(r.refused, [{ rowIndex: 1, email: 'kaner@simple.biz', name: 'Kane Reroma' }]);
  assert.equal(r.weekStart, '2026-08-30');
});

test('a file with no Email column is refused', () => {
  const r = parseInternHoursCsv('Member,Hours\nMaria,5', FILE);
  assert.equal(r.ok, false);
});

test('an undatable filename is refused before any row is read', () => {
  const r = parseInternHoursCsv(CSV, 'interns.csv');
  assert.equal(r.ok, false);
});

test('weekDays enumerates the seven dates from the Sunday', () => {
  assert.deepEqual(weekDays('2026-08-30'), [
    '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05',
  ]);
});

test('canonical weekday columns resolve to the week\'s dates and H:MM:SS parses to seconds', () => {
  const r = parseInternHoursCsv(CSV, FILE);
  assert.ok(r.ok);
  const days = internDaysFromRow(r.rows[0].row, FILE, r.weekStart);
  assert.ok(days);
  assert.equal(days.length, 7);
  assert.equal(days[1].iso, '2026-08-31');
  assert.equal(days[1].rawSec, 3600);
  assert.equal(days[2].rawSec, 5400);
  assert.equal(days[4].rawSec, 7200);
  assert.equal(days[0].rawSec, 0);
});

test('ISO-date columns are read directly', () => {
  const days = internDaysFromRow({ Email: 'x@pathway.ph', '2026-09-01': '2:00:00' }, FILE, '2026-08-30');
  assert.ok(days);
  assert.equal(days[2].rawSec, 7200);
});

test('a row with NO day column at all returns null so the caller refuses it (never a guessed lump)', () => {
  assert.equal(internDaysFromRow({ Email: 'x@pathway.ph', 'Total worked': '5:00:00' }, FILE, '2026-08-30'), null);
});
