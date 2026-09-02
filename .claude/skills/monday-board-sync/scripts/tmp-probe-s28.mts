/** Probe: every item physically in the Sprint 28 GROUP, ours vs theirs. */
import { MONDAY_BOARDS, TASK_COLS, TASK_GROUPS, gql, isOurTask } from './monday.mts';
interface Row { id: string; name: string; column_values: { id: string; text: string | null }[] }
const rows: Row[] = [];
let cursor: string | null = null;
do {
  const d = await gql<{ boards: { groups: { items_page: { cursor: string | null; items: Row[] } }[] }[] }>(
    `query($b:[ID!],$g:[String!],$c:String,$cols:[String!]){boards(ids:$b){groups(ids:$g){
       items_page(limit:250,cursor:$c){cursor items{id name column_values(ids:$cols){id text}}}}}}`,
    { b: [MONDAY_BOARDS.tasks], g: [TASK_GROUPS.S28], c: cursor,
      cols: [TASK_COLS.status, TASK_COLS.actualSp, TASK_COLS.estimatedSp, TASK_COLS.sprint, TASK_COLS.completed] },
  );
  const page = d.boards[0]?.groups[0]?.items_page;
  if (!page) break;
  rows.push(...page.items);
  cursor = page.cursor;
} while (cursor);
const col = (r: Row, id: string) => r.column_values.find((c) => c.id === id)?.text ?? '';
const ours = rows.filter((r) => isOurTask(r.name));
console.log(`Sprint 28 group (${TASK_GROUPS.S28}) holds ${rows.length} items: ${ours.length} ours · ${rows.length - ours.length} other teams'`);
for (const r of ours) {
  console.log(`  ${r.id} est=${(col(r, TASK_COLS.estimatedSp)||'-').padStart(2)} act=${(col(r, TASK_COLS.actualSp)||'-').padStart(2)} ${(col(r, TASK_COLS.status)||'(blank)').padEnd(15)} label="${col(r, TASK_COLS.sprint)}" ${r.name.slice(7, 72)}`);
}
