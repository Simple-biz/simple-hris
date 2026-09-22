/** OFFLINE PROPOSAL: re-derive Total Project SP, with the essential backlog folded in. */
import { PLAN_EPICS, PLAN_TASKS } from './monday.mts';
const E = PLAN_EPICS as any[], T = PLAN_TASKS as any[];
/** [group, name, sp, epic] — every row is an OPEN item in docs/audits or memory, none on the board today. */
const BACKLOG: [string, string, number, string][] = [
  ['money','COE is blind to KPI bonuses paid through the wizard Adj. column (gyd@ lost ₱25,000 twice)',5,'HRIS-18'],
  ['money','HslBonusEditModal re-scores with calcBonus not scoreEntry — a past week STRIPS the Library bonus',3,'HRIS-08'],
  ['money','Orphanage pay OT differential underpay',3,'HRIS-03c'],
  ['money','Org report total payout is salary-only',3,'HRIS-33'],
  ['money','Never-paid and misdelivered paystubs',3,'HRIS-03b'],
  ['money','orphanage_pay filename drift blinds the divergence detector',3,'HRIS-03c'],
  ['money','Re-lock juliar@ 2026-09-06 week after the ₱279.99 override',2,'HRIS-02b'],
  ['money','75 filing_specialist rows score ₱68,825 under the new bands — ruling',2,'HRIS-30'],
  ['roster','Master sync keys on (personal_email, department) so every transfer ORPHANS a row',5,'HRIS-26'],
  ['roster','External API cursor is a UUID parsed as an integer — 1,141 people unreachable',3,'HRIS-14'],
  ['roster','KPI departed guard hides actively working people on the live week',3,'HRIS-06'],
  ['roster','7 live people absent from the sheet + 41 unclassified, all left ACTIVE',2,'HRIS-26'],
  ['security','global_master_list is readable by the PUBLIC anon key — 2,833 rows of PII',5,'HRIS-05'],
  ['security','Two pre-release security blockers outstanding at EOM',3,'HRIS-05'],
  ['security','Repo hygiene: env.local tracked at 0 bytes, plus two more',2,'HRIS-15'],
  ['fpu','FPU groups documented as shipped, actually NOT BUILT',5,'HRIS-07'],
  ['fpu','Mark completed attendance gate is narrower than Close class and its refusals are invisible',3,'HRIS-07'],
  ['fpu','DELETE /api/hr/fpu-enrollments erases a failed verdict',2,'HRIS-07'],
  ['support','Content moderation — unscoped, BLOCKING (N1), must fail OPEN',8,'HRIS-04'],
  ['support','Seven additions ruled live 2026-09-18 (tasks 21-28), never shown to Carla',8,'HRIS-04'],
  ['support','Time-adjustment restriction is a guard or a sentence — undecided',2,'HRIS-04'],
  ['platform','Salaried pay basis is person-dated — NOT BUILT',5,'HRIS-02b'],
  ['platform','Three HR Overview stat readers drop ~32% of the checklist',3,'HRIS-12'],
  ['platform','System bonus department resolver split',3,'HRIS-08'],
  ['platform','KPI bonus keyed on a shared personal email',3,'HRIS-06'],
  ['platform','Three guard tests are RED on a clean main',3,'HRIS-15'],
];
const kid = (c: string) => T.filter((t) => t.epic === c).reduce((a, t) => a + t.sp, 0);
const back = (c: string) => BACKLOG.filter((b) => b[3] === c).reduce((a, b) => a + b[2], 0);
const forecast = E.reduce((a, e) => a + e.sp, 0);
const measured = E.reduce((a, e) => a + Math.max(e.sp, kid(e.code)), 0);
const withBacklog = E.reduce((a, e) => a + Math.max(e.sp, kid(e.code) + back(e.code)), 0);
const g: Record<string, number> = {};
for (const b of BACKLOG) g[b[0]] = (g[b[0]] ?? 0) + b[2];
console.log('PROPOSED BACKLOG — ' + BACKLOG.length + ' rows · ' + BACKLOG.reduce((a, b) => a + b[2], 0) + ' SP');
for (const [k, v] of Object.entries(g)) console.log('  ' + k.padEnd(9) + String(v).padStart(3) + ' SP · ' + BACKLOG.filter((b) => b[0] === k).length + ' rows');
console.log('\nTOTAL PROJECT SP');
console.log('  on the board today (Σ epic forecast)        : ' + forecast);
console.log('  disproven forecasts replaced by measurement : ' + measured + '  (+' + (measured - forecast) + ')');
console.log('  … plus the essential backlog above          : ' + withBacklog + '  (+' + (withBacklog - measured) + ')');
console.log('\n  NOTE: the backlog is ' + BACKLOG.reduce((a, b) => a + b[2], 0) + ' SP but only moves Total by ' + (withBacklog - measured) + ' —');
console.log('  ' + (BACKLOG.reduce((a, b) => a + b[2], 0) - (withBacklog - measured)) + ' SP lands inside epics whose forecast still EXCEEDS their decomposed work,');
console.log('  so it is already paid for by the original estimate. Adding it naively would DOUBLE COUNT.');
console.log('\nper-epic movement:');
for (const e of E.sort((a, b) => a.code.localeCompare(b.code))) {
  const was = Math.max(e.sp, kid(e.code)), now = Math.max(e.sp, kid(e.code) + back(e.code));
  if (now !== was || back(e.code)) console.log(`  ${e.code.padEnd(9)} forecast ${String(e.sp).padStart(3)} · kids ${String(kid(e.code)).padStart(3)} · backlog ${String(back(e.code)).padStart(2)} → ${String(was).padStart(3)} to ${String(now).padStart(3)} ${now === was ? '(absorbed by headroom)' : '(+' + (now - was) + ')'}`);
}
