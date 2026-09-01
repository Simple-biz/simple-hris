/**
 * ONE-OFF (2026-09-01, Kane-approved): move every NON-HRIS pending row out of the Sprint 27 group
 * into Sprint 28 — sprint label 104 + group move. Statuses are NEVER touched, Done rows NEVER move,
 * and [HRIS] rows are excluded (they belong to the plan/reconciler path, applied separately under
 * approval hash dd8f2aef9f0d).
 *
 * Scope per Kane's explicit choice ("Pending only — 85 + our 5"): rows in group_mm66ce8q whose
 * status is not Done and whose Actual SP is blank. Done-but-unscored rows (96) STAY in Sprint 27.
 *
 * Dry-run by default; --apply to write. Progress goes to tmp-move-s27-pending.progress.json one row
 * at a time, so a mid-run DailyLimitExceeded leaves an accurate ledger and a re-run resumes.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DailyLimitExceeded,
  MONDAY_BOARDS,
  SKILL_DIR,
  TASK_COLS,
  TASK_GROUPS,
  TASK_SPRINT_INDEX,
  gql,
  isOurTask,
  setColumns,
} from './monday.mts';

const APPLY = process.argv.includes('--apply');
const PROGRESS = path.join(SKILL_DIR, 'scripts', 'tmp-move-s27-pending.progress.json');
const doneIds = new Set<string>(
  fs.existsSync(PROGRESS) ? (JSON.parse(fs.readFileSync(PROGRESS, 'utf8')) as string[]) : [],
);

interface Row {
  id: string;
  name: string;
  column_values: { id: string; text: string | null }[];
}
const rows: Row[] = [];
let cursor: string | null = null;
do {
  const d = await gql<{
    boards: { groups: { items_page: { cursor: string | null; items: Row[] } }[] }[];
  }>(
    `query($b:[ID!],$g:[String!],$c:String,$cols:[String!]){boards(ids:$b){groups(ids:$g){
       items_page(limit:250,cursor:$c){cursor items{id name column_values(ids:$cols){id text}}}}}}`,
    {
      b: [MONDAY_BOARDS.tasks],
      g: [TASK_GROUPS.S27],
      c: cursor,
      cols: [TASK_COLS.status, TASK_COLS.actualSp],
    },
  );
  const page = d.boards[0]?.groups[0]?.items_page;
  if (!page) break;
  rows.push(...page.items);
  cursor = page.cursor;
} while (cursor);

const col = (r: Row, id: string) => r.column_values.find((c) => c.id === id)?.text ?? '';
const targets = rows.filter(
  (r) => !isOurTask(r.name) && col(r, TASK_COLS.status) !== 'Done' && !col(r, TASK_COLS.actualSp),
);

console.log(
  `Sprint 27 group: ${rows.length} items → ${targets.length} non-HRIS pending rows with no Actual SP` +
    ` (${doneIds.size} already moved per progress ledger)`,
);
for (const t of targets) {
  console.log(
    `  ${doneIds.has(t.id) ? '✓' : '·'} ${t.id.padEnd(12)} ${(col(t, TASK_COLS.status) || '(blank)').padEnd(18)} ${t.name.slice(0, 78)}`,
  );
}
if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to move them.');
  process.exit(0);
}

const M_MOVE = `mutation($item:ID!,$group:String!){move_item_to_group(item_id:$item,group_id:$group){id}}`;
let moved = 0;
try {
  for (const t of targets) {
    if (doneIds.has(t.id)) continue;
    // Label first, then group — the same order sync.ts uses. Statuses are untouched.
    await setColumns(MONDAY_BOARDS.tasks, t.id, {
      [TASK_COLS.sprint]: { index: TASK_SPRINT_INDEX.S28 },
    });
    await gql(M_MOVE, { item: t.id, group: TASK_GROUPS.S28 });
    doneIds.add(t.id);
    moved++;
    fs.writeFileSync(PROGRESS, JSON.stringify([...doneIds], null, 2), 'utf8');
  }
} catch (e) {
  fs.writeFileSync(PROGRESS, JSON.stringify([...doneIds], null, 2), 'utf8');
  const remaining = targets.filter((t) => !doneIds.has(t.id)).length;
  if (e instanceof DailyLimitExceeded) {
    console.error(`\nBUDGET DIED after ${moved} moves this run — ${remaining} rows remain. Re-run --apply after reset.`);
    console.error(e.message);
    process.exit(3);
  }
  console.error(`\nFAILED after ${moved} moves this run — ${remaining} rows remain.`);
  throw e;
}
console.log(`\nmoved ${moved} rows this run · ${doneIds.size}/${targets.length} total per ledger`);
