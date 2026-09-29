/** Probe (read-only, 2 calls): Sprint Tasks groups + Sprint label settings, to mirror Sprint 30. */
import { MONDAY_BOARDS, TASK_COLS, boardGroups, columnLabels } from './monday.mts';
const groups = await boardGroups(MONDAY_BOARDS.tasks);
for (const g of groups) if (/sprint (2[7-9]|3\d)|backlog|re-scop/i.test(g.title)) console.log(`group ${g.id}  "${g.title}"`);
const labels = await columnLabels(MONDAY_BOARDS.tasks, TASK_COLS.sprint);
for (const [i, l] of Object.entries(labels)) if (/sprint (2[7-9]|3\d)|backlog/i.test(l)) console.log(`label ${i} = "${l}"`);
