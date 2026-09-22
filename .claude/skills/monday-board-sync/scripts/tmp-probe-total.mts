/** OFFLINE: what Total Project SP would be if the disproven forecasts were replaced by measurement. */
import { PLAN_EPICS, PLAN_TASKS } from './monday.mts';
const E = PLAN_EPICS as any[], T = PLAN_TASKS as any[];
const kid = (c: string) => T.filter((t) => t.epic === c).reduce((a, t) => a + t.sp, 0);
const forecast = E.reduce((a, e) => a + e.sp, 0);
const measured = E.reduce((a, e) => a + Math.max(e.sp, kid(e.code)), 0);
const undecomposed = E.filter((e) => kid(e.code) === 0);
console.log(`Total as the board shows it (Σ epic forecast)      : ${forecast}`);
console.log(`Total with each blown forecast replaced by measure : ${measured}   (+${measured - forecast})`);
console.log(`  \_ un-decomposed forecast still inside it       : ${undecomposed.reduce((a, e) => a + e.sp, 0)} SP over ${undecomposed.length} epics — ${undecomposed.map((e) => e.code).join(' ')}`);
console.log(`\nBACKLOG rows in the plan (sprint 'BL'):`);
const bl = T.filter((t) => t.sprint === 'BL');
for (const b of bl) console.log(`  ${b.done ? 'DONE' : 'OPEN'} ${String(b.sp).padStart(2)} SP  [${b.epic}] ${b.name.slice(0, 88)}`);
console.log(`  → ${bl.length} rows · open ${bl.filter((b) => !b.done).length} (${bl.filter((b) => !b.done).reduce((a, b) => a + b.sp, 0)} SP)`);
console.log(`\nALL open plan rows, any sprint (the real remaining scope ON the board):`);
for (const t of T.filter((x) => !x.done)) console.log(`  [${t.sprint}] ${String(t.sp).padStart(2)} SP ${t.type.padEnd(11)} ${t.name.slice(0, 80)}`);
console.log(`  → ${T.filter((x) => !x.done).length} rows · ${T.filter((x) => !x.done).reduce((a, t) => a + t.sp, 0)} SP`);
