/**
 * Export the pass as CSV. Read-only, no network — derived from pass.mts + PLAN_TASKS, which
 * `verify.mts` has already confirmed matches the board.
 *
 *   node --import tsx .claude/skills/monday-board-sync/scripts/export-csv.mts [outfile]
 *
 * Columns: Item · Type · Status · Estimated SP · Github Evidence · Completed Date
 *
 * Completed Date is populated ONLY for Done rows. A date on an unshipped row is an invented record,
 * so those cells are deliberately empty — an empty column here is the gate working, not missing data.
 *
 * The file is written with a UTF-8 BOM so Excel renders the em-dashes, curly quotes and ₱ correctly.
 * NEVER hand this CSV to Monday's importer: the importer is free to normalise a name, and because the
 * reconciler matches byte-exact, one altered character makes the row permanently unmatchable and it
 * gets recreated forever. Rows reach the board through apply.mts only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PLAN_TASKS, REPO_ROOT, taskItemName } from './monday.mts';
import { GITHUB_COMMIT, PASS_DATE, ROWS, selfcheck } from './pass.mts';

const bad = selfcheck();
if (bad.length) {
  console.error(`pass selfcheck FAILED — refusing to export a CSV of an inconsistent pass:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}

const out = process.argv[2] ?? path.join(REPO_ROOT, 'docs/audits', `${PASS_DATE}-monday-board-pass.csv`);
const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const header = ['Item', 'Type', 'Status', 'Estimated SP', 'Github Evidence', 'Completed Date'];

const lines = [header.map(q).join(',')];
for (const row of ROWS) {
  const plan = PLAN_TASKS.find((t) => t.name === row.name);
  if (!plan) throw new Error(`pass row not in PLAN_TASKS: ${row.name}`); // selfcheck should have caught this
  const latest = row.shas[row.shas.length - 1];
  lines.push(
    [
      taskItemName({ name: row.name }),
      plan.type,
      row.status,
      plan.sp,
      `${row.shas.join(' ')} | ${GITHUB_COMMIT}${latest}`,
      row.status === 'Done' ? (row.completed ?? '') : '',
    ]
      .map(q)
      .join(','),
  );
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, '﻿' + lines.join('\r\n') + '\r\n', 'utf8');

const done = ROWS.filter((r) => r.status === 'Done');
const spOf = (r: (typeof ROWS)[number]) => PLAN_TASKS.find((t) => t.name === r.name)?.sp ?? 0;
console.log(`wrote ${out}`);
console.log(`  ${ROWS.length} rows · ${done.length} Done (${done.reduce((a, r) => a + spOf(r), 0)} SP, completed ${PASS_DATE})`);
console.log(`  ${ROWS.length - done.length} not Done (${ROWS.filter((r) => r.status !== 'Done').reduce((a, r) => a + spOf(r), 0)} SP) — Completed Date left empty by rule`);
