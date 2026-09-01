/** Probe: every item physically in the Sprint 27 GROUP, split ours/theirs, no-Actual-SP flagged. */
import { MONDAY_BOARDS, TASK_COLS, TASK_GROUPS, gql, isOurTask } from './monday.mts';

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
      cols: [TASK_COLS.status, TASK_COLS.actualSp, TASK_COLS.estimatedSp, TASK_COLS.sprint, TASK_COLS.completed],
    },
  );
  const page = d.boards[0]?.groups[0]?.items_page;
  if (!page) break;
  rows.push(...page.items);
  cursor = page.cursor;
} while (cursor);

const col = (r: Row, id: string) => r.column_values.find((c) => c.id === id)?.text ?? '';
const ours = rows.filter((r) => isOurTask(r.name));
const theirs = rows.filter((r) => !isOurTask(r.name));
console.log(`Sprint 27 group holds ${rows.length} items: ${ours.length} ours ([HRIS]) · ${theirs.length} other teams'`);

for (const [label, set] of [['OURS', ours], ['THEIRS', theirs]] as const) {
  const noActual = set.filter((r) => !col(r, TASK_COLS.actualSp));
  console.log(`\n── ${label}: ${set.length} rows, ${noActual.length} with NO Actual SP ──`);
  for (const r of noActual) {
    console.log(
      `  ${r.id.padEnd(12)} est=${(col(r, TASK_COLS.estimatedSp) || '-').padStart(2)} ` +
        `${(col(r, TASK_COLS.status) || '(blank)').padEnd(18)} sprint-label="${col(r, TASK_COLS.sprint)}" ` +
        `${r.name.slice(0, 70)}`,
    );
  }
}
