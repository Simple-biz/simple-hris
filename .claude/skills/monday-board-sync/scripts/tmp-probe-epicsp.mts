/** OFFLINE: epic SP vs the task work actually filed under it. */
import { PLAN_EPICS, PLAN_TASKS } from './monday.mts';
const E = PLAN_EPICS as any[], T = PLAN_TASKS as any[];
console.log(`Σ PLAN_EPICS.sp = ${E.reduce((a, e) => a + e.sp, 0)}   (this IS the board's Total Project SP)`);
console.log(`Σ PLAN_TASKS.sp = ${T.reduce((a, t) => a + t.sp, 0)} over ${T.length} task rows`);
console.log(`  of which done:true = ${T.filter((t) => t.done).reduce((a, t) => a + t.sp, 0)} · done:false = ${T.filter((t) => !t.done).reduce((a, t) => a + t.sp, 0)}`);
console.log('\nepic      epicSP  kids  kidSP  doneSP  status        gap(kidSP-epicSP)');
let noKids = 0, noKidsSp = 0, over = 0, overBy = 0;
for (const e of E.sort((a, b) => a.code.localeCompare(b.code))) {
  const kids = T.filter((t) => t.epic === e.code);
  const kidSp = kids.reduce((a, t) => a + t.sp, 0);
  const doneSp = kids.filter((t) => t.done).reduce((a, t) => a + t.sp, 0);
  if (!kids.length) { noKids++; noKidsSp += e.sp; }
  if (kidSp > e.sp) { over++; overBy += kidSp - e.sp; }
  const gap = kidSp - e.sp;
  console.log(`${e.code.padEnd(9)} ${String(e.sp).padStart(5)} ${String(kids.length).padStart(5)} ${String(kidSp).padStart(6)} ${String(doneSp).padStart(7)}  ${e.status.padEnd(12)} ${gap > 0 ? '+' + gap + ' OVER' : gap === 0 ? '0' : String(gap)}`);
}
console.log(`\nepics with ZERO task rows: ${noKids} carrying ${noKidsSp} SP — that SP answers to nothing`);
console.log(`epics whose CHILD SP already EXCEEDS the epic estimate: ${over}, by ${overBy} SP in total`);
const orphanEpicCodes = [...new Set(T.map((t) => t.epic))].filter((c) => !E.some((e) => e.code === c));
console.log(`task rows pointing at an epic code NOT in PLAN_EPICS: ${orphanEpicCodes.join(' ') || 'none'}`);
