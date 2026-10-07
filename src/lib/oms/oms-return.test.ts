import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  OMS_RETURN_COLUMNS,
  buildOmsReturnRows,
  cleanReturnAliases,
  parseOrphanageAmounts,
  toOmsReturnRecords,
} from './oms-return';

// The incident row from orphanage-pay-step.md: 5.80 reg × ₱355 + 9.70 OT × ₱532.50.
const DANA = {
  employee_email: 'dana@simple.biz',
  employee_name: 'Abad, Danilo Jr',
  pay_week: '9/13- 9/19',
  hours: '15.5000',
  reg_hours: '5.8000',
  ot_hours: '9.7000',
  regular_rate_php: '355.0000',
  ot_rate_php: '532.5000',
};

function build(input: Parameters<typeof buildOmsReturnRows>[0]) {
  const r = buildOmsReturnRows(input);
  if (!r.ok) throw new Error(r.reason);
  return r.build;
}

test('the amount sent is the PAYING blob value, never the record — and the record supplies the split', () => {
  const b = build({ orphanageAmounts: { 'Dana@simple.biz': 7224.25 }, records: [DANA] });
  assert.equal(b.rows.length, 1);
  const row = b.rows[0]!;
  assert.equal(row.hrisEmail, 'dana@simple.biz');
  assert.equal(row.amountPhp, 7224.25);
  assert.equal(row.regularHours, 5.8);
  assert.equal(row.otHours, 9.7);
  assert.equal(row.regularRatePhp, 355);
  assert.equal(row.otRatePhp, 532.5);
  assert.equal(row.verdict, 'ok');
  assert.equal(row.name, 'Abad, Danilo Jr');
});

test('a blob amount that disagrees with its record is sent AS PAID, flagged by the verdict', () => {
  const b = build({ orphanageAmounts: { 'dana@simple.biz': 3781 }, records: [{ ...DANA, ot_rate_php: '177.5' }] });
  assert.equal(b.rows[0]!.amountPhp, 3781);
  assert.equal(b.rows[0]!.verdict, 'ot_underpriced');
  assert.equal(b.verdictCounts.ot_underpriced, 1);
});

test('a hand-typed amount (no record) goes with hours BLANK and verdict unverifiable — never dropped, never invented', () => {
  const b = build({ orphanageAmounts: { 'erict@simple.biz': 5373 }, records: [] });
  const row = b.rows[0]!;
  assert.equal(row.amountPhp, 5373);
  assert.equal(row.hours, null);
  assert.equal(row.regularHours, null);
  assert.equal(row.otHours, null);
  assert.equal(row.verdict, 'unverifiable');
});

test('hours on record with no amount on the column are NOT sent, and are counted', () => {
  const b = build({ orphanageAmounts: {}, records: [DANA] });
  assert.equal(b.rows.length, 0);
  assert.deepEqual(b.recordsWithoutAmount, ['dana@simple.biz']);
});

test('a non-numeric blob amount refuses the WHOLE build', () => {
  const r = buildOmsReturnRows({ orphanageAmounts: { 'a@simple.biz': 100, 'b@simple.biz': 'abc' }, records: [] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /b@simple\.biz/);
});

test('two blob keys that differ only in case are refused, not merged', () => {
  const r = buildOmsReturnRows({ orphanageAmounts: { 'A@simple.biz': 100, 'a@simple.biz': 200 }, records: [] });
  assert.equal(r.ok, false);
});

test('an alias relabels work_email only — it never adds a row or moves money', () => {
  const aliases = new Map([
    ['dana@simple.biz', 'Danilo.Abad@oms.example'],
    ['ghost@simple.biz', 'ghost@oms.example'],
  ]);
  const b = build({ orphanageAmounts: { 'dana@simple.biz': 7224.25 }, records: [DANA], aliases });
  assert.equal(b.rows.length, 1);
  assert.equal(b.rows[0]!.workEmail, 'Danilo.Abad@oms.example');
  assert.equal(b.rows[0]!.hrisEmail, 'dana@simple.biz');
  assert.equal(b.rows[0]!.amountPhp, 7224.25);
});

test('totals sum the SENT rows; order is stable by name then email', () => {
  const b = build({
    orphanageAmounts: { 'zed@simple.biz': 100.1, 'dana@simple.biz': 7224.25, 'amy@simple.biz': 50 },
    records: [DANA, { employee_email: 'amy@simple.biz', employee_name: 'Amy', hours: 2, reg_hours: 2, ot_hours: 0, regular_rate_php: 25, ot_rate_php: null }],
  });
  assert.deepEqual(b.rows.map((r) => r.hrisEmail), ['dana@simple.biz', 'amy@simple.biz', 'zed@simple.biz']);
  assert.equal(b.totals.people, 3);
  assert.equal(b.totals.amountPhp, 7374.35);
  assert.equal(b.totals.regularHours, 7.8);
  assert.equal(b.totals.otHours, 9.7);
});

test('parseOrphanageAmounts: absent = nothing locked in; garbage is REFUSED, never read as empty', () => {
  assert.deepEqual(parseOrphanageAmounts(null), { ok: true, amounts: {} });
  assert.deepEqual(parseOrphanageAmounts('{"bonusOverrides":{}}'), { ok: true, amounts: {} });
  const ok = parseOrphanageAmounts('{"orphanageAmounts":{"a@simple.biz":12}}');
  assert.equal(ok.ok, true);
  assert.equal(parseOrphanageAmounts('not json').ok, false);
  assert.equal(parseOrphanageAmounts('[1,2]').ok, false);
  assert.equal(parseOrphanageAmounts('{"orphanageAmounts":[1]}').ok, false);
});

test('cleanReturnAliases: email → email only; a malformed pair is a refusal, not a silent drop', () => {
  const ok = cleanReturnAliases({ 'Dana@simple.biz': ' dana@oms.example ' });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.aliases.get('dana@simple.biz'), 'dana@oms.example');
  assert.equal(cleanReturnAliases(undefined).ok, true);
  assert.equal(cleanReturnAliases({ 'dana@simple.biz': 7224.25 }).ok, false);
  assert.equal(cleanReturnAliases({ 'not an email': 'x@y.z' }).ok, false);
  assert.equal(cleanReturnAliases(['a@b.c']).ok, false);
});

test('every row carries the push metadata and the cycle_locked flag, keyed by exactly OMS_RETURN_COLUMNS', () => {
  const b = build({ orphanageAmounts: { 'dana@simple.biz': 7224.25 }, records: [DANA] });
  const recs = toOmsReturnRecords(b.rows, {
    pushId: '00000000-0000-4000-8000-000000000001',
    pushedAt: '2026-09-28T10:00:00.000Z',
    pushedBy: 'kaner@simple.biz',
    sourceFile: 'simple-biz_daily_report_2026-09-13_to_2026-09-19.csv',
    weekStart: '2026-09-13',
    cycleLocked: false,
  });
  assert.deepEqual(Object.keys(recs[0]!), [...OMS_RETURN_COLUMNS]);
  assert.equal(recs[0]!.cycle_locked, false);
  assert.equal(recs[0]!.amount_php, 7224.25);
});

test('the DDL handed to the OMS team names every column the writer inserts — and no other', () => {
  const doc = readFileSync(path.join(process.cwd(), 'docs/features/orphanage-oms-pull.md'), 'utf8');
  const m = doc.match(/```sql\r?\n(create table[\s\S]*?)```/i);
  assert.ok(m, 'orphanage-oms-pull.md must carry the OMS return-table DDL in a ```sql block');
  const ddl = m![1]!;
  const declared = [...ddl.matchAll(/^\s{2}([a-z_]+)\s+(?:uuid|timestamptz|text|date|numeric|boolean)\b/gm)].map((x) => x[1]);
  assert.deepEqual(declared, [...OMS_RETURN_COLUMNS]);
});

test('the SQL file sent to the OMS dev names every column the writer inserts, and no other', () => {
  const file = readFileSync(path.join(process.cwd(), 'references/sql/external/oms/2026-10-07_hris_orphanage_returns.sql'), 'utf8');
  const declared = [...file.matchAll(/^\s{2}([a-z_]+)\s+(?:uuid|timestamptz|text|date|numeric|boolean)\b/gm)].map((x) => x[1]);
  assert.deepEqual(declared, [...OMS_RETURN_COLUMNS]);
  // Append-only on their side too: the HRIS key may never UPDATE or DELETE there.
  assert.match(file, /revoke update, delete, truncate on public\.hris_orphanage_returns from service_role/);
  assert.match(file, /grant select, insert on public\.hris_orphanage_returns to service_role/);
});

test('an OMS error becomes a sentence naming what is missing and whose job it is', async () => {
  const { describeOmsReturnError } = await import('./oms-return-write');
  assert.match(describeOmsReturnError('t', { code: '42P01', message: 'relation "t" does not exist' }, 'read'), /no table named "t"/);
  assert.match(describeOmsReturnError('t', { code: 'PGRST205', message: 'Could not find the table in the schema cache' }, 'read'), /no table named/);
  assert.match(describeOmsReturnError('t', { code: '42703', message: 'column t.verdict does not exist' }, 'write'), /does not have the columns/);
  assert.match(describeOmsReturnError('t', { code: '42501', message: 'permission denied for table t' }, 'write'), /grant INSERT/);
  assert.match(describeOmsReturnError('t', { code: '42501', message: 'permission denied for table t' }, 'read'), /grant SELECT/);
  assert.match(describeOmsReturnError('t', { message: 'boom' }, 'write'), /OMS write failed: boom/);
});

test('the week is derived from the source file’s parsed range — a "(1)" suffix does not change it; no range = null', async () => {
  const { weekStartFromSourceFile } = await import('./oms-return');
  assert.equal(weekStartFromSourceFile('simple-biz_daily_report_2026-09-13_to_2026-09-19.csv'), '2026-09-13');
  assert.equal(weekStartFromSourceFile('simple-biz_daily_report_2026-08-23_to_2026-08-29 (1).csv'), '2026-08-23');
  assert.equal(weekStartFromSourceFile('hours.csv'), null);
});
