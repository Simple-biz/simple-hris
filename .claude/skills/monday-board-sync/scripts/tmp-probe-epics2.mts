/** READ-ONLY: exact name-parity on the epics board, using the plan's own epicItemName(). */
import { MONDAY_BOARDS, PLAN_EPICS, epicItemName, isOurEpic, listBoardItems } from './monday.mts';
const live = (await listBoardItems(MONDAY_BOARDS.epics, [])).filter((e: any) => isOurEpic(e.name));
const liveNames = new Set(live.map((e: any) => e.name));
const absent = (PLAN_EPICS as any[]).filter((e) => !liveNames.has(epicItemName(e)));
const planNames = new Set((PLAN_EPICS as any[]).map((e) => epicItemName(e)));
const orphans = live.filter((e: any) => !planNames.has(e.name));
console.log(`plan epics ${(PLAN_EPICS as any[]).length} · live ours ${live.length}`);
console.log(`ABSENT from board (reconciler would CREATE these): ${absent.length}`);
for (const e of absent) console.log(`   + ${epicItemName(e)}  [${e.quarter}]`);
console.log(`ORPHANS on board not in plan: ${orphans.length}`);
for (const e of orphans) console.log(`   ? ${e.name}`);
