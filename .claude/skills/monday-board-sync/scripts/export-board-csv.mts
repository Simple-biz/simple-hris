/**
 * READ-ONLY: every HRIS row on the Monday board as one CSV, plus the project SP summary as a second.
 * Built for the HRIS V1 close-out (Kane, 2026-10-09: "create a CSV for all the pushed data in monday
 * and how many SP we have worked on this project"). Governing doc: docs/features/hris-v1-closeout.md.
 *
 *   node --import tsx .claude/skills/monday-board-sync/scripts/export-board-csv.mts           # offline
 *   node --import tsx .claude/skills/monday-board-sync/scripts/export-board-csv.mts --board   # live board
 *   ... [--out <prefix>]     default docs/audits/<YYYY-MM-DD>-hris-v1
 *
 * TWO SOURCES, and every row says which one it came from (the Source column):
 *   • offline (default, no network): the plan (PLAN_EPICS / PLAN_TASKS) for what exists, and the
 *     repo's own record of each row's status, Completed Date and commits: every historical version of
 *     pass.mts in git, then the 2026-10-02 hand-paste TSVs for the rows pass 38 entered by hand. A
 *     row the current pass names is labelled as that pass, because it reaches the board only when the
 *     pass is applied. This is the board AS THE REPO SAYS IT IS, not a read of it.
 *   • --board: our epics and tasks read off the live board (listBoardItems, about 15 calls). Status,
 *     SP, sprint and Completed Date are the board's. Commit evidence still comes from the repo, since
 *     the board keeps it only inside item updates. Every plan-vs-board difference is listed.
 *
 * Completed Date and Actual SP are written ONLY for Done rows (export-csv.mts:9-10). A blank there is
 * the honesty gate working, not missing data.
 *
 * NEVER hand either file to Monday's importer. The importer may normalise a character, the reconciler
 * matches names byte-exact, and an altered name becomes a duplicate row forever (export-csv.mts:13).
 * Rows reach the board through apply.mts only.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  EPIC_COLS,
  MONDAY_BOARDS,
  PLAN_EPICS,
  PLAN_TASKS,
  REPO_ROOT,
  TASK_COLS,
  TASK_SPRINT_LABELS,
  isOurEpic,
  isOurTask,
  listBoardItems,
  taskItemName,
} from './monday.mts';
import { GITHUB_COMMIT, PASS_DATE, ROWS, selfcheck } from './pass.mts';

// project-sp.ts is CJS-compiled like hris-plan.ts, so it is imported dynamically (monday.mts:18-21).
const { projectSp } = (await import('../../../../src/lib/monday/project-sp')) as typeof import('../../../../src/lib/monday/project-sp');

const argv = process.argv.slice(2);
const BOARD = argv.includes('--board');
const outAt = argv.indexOf('--out');
const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
const PREFIX = outAt >= 0 ? argv[outAt + 1] : path.join(REPO_ROOT, 'docs/audits', `${today}-hris-v1`);
const PASS_FILE = '.claude/skills/monday-board-sync/scripts/pass.mts';
const PASTE_TSVS = ['docs/audits/2026-10-02-monday-withheld-sp.tsv', 'docs/audits/2026-10-02-monday-close-on-confirmation.tsv'];

const bad = selfcheck();
if (bad.length) {
  console.error(`pass selfcheck FAILED — refusing to export from an inconsistent pass:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}

type Plan = (typeof PLAN_TASKS)[number];
interface Record_ {
  status: string;
  completed?: string;
  shas?: string[];
  source: string;
}

// ── the repo's record of each row: every pass.mts version, oldest first ─────────────────────────
const git = (args: string[]) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
const ROW_RE = /name:\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1,\s*\n\s*status:\s*'([^']+)'([\s\S]*?)\n {2}\},/g;
const history = new Map<string, Record_>();
/** The last record that said Done, kept apart so a later non-Done mention cannot erase its date. */
const lastDone = new Map<string, Record_>();
for (const line of git(['log', '--reverse', '--format=%h %cs', '--', PASS_FILE]).trim().split('\n')) {
  const [sha, day] = line.split(' ');
  let text: string;
  try {
    text = git(['show', `${sha}:${PASS_FILE}`]);
  } catch {
    continue;
  }
  const body = text.slice(Math.max(0, text.indexOf('export const ROWS')));
  for (const m of body.matchAll(ROW_RE)) {
    const name = m[2].replace(/\\(['"`\\])/g, '$1');
    const rest = m[4];
    const shas = rest.match(/shas:\s*\[([^\]]*)\]/)?.[1].replace(/['"\s]/g, '').split(',').filter(Boolean);
    const rec: Record_ = { status: m[3], completed: rest.match(/completed:\s*'([^']+)'/)?.[1], shas, source: `pass.mts @${sha} (${day})` };
    history.set(name, rec);
    if (rec.status === 'Done' && rec.completed) lastDone.set(name, rec);
  }
}
// ── the rows pass 38 entered by hand, from its paste files ────────────────────────────────────────
for (const file of PASTE_TSVS) {
  const p = path.join(REPO_ROOT, file);
  if (!fs.existsSync(p)) continue;
  const [head, ...lines] = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
  const cols = head.split('\t');
  const at = (r: string[], c: string) => r[cols.indexOf(c)] ?? '';
  for (const l of lines) {
    const r = l.split('\t');
    const name = at(r, 'Name').replace(/^\[HRIS\] /, '');
    const evidence = cols.find((c) => c.startsWith('Update'));
    const shas = evidence ? at(r, evidence).split('|')[0].trim().split(/\s+/).filter(Boolean) : undefined;
    const rec: Record_ = { status: at(r, 'Status'), completed: at(r, 'Completed Date') || undefined, shas, source: `${path.basename(file)} (hand paste)` };
    if (!history.has(name)) history.set(name, rec);
    if (rec.status === 'Done' && rec.completed && !lastDone.has(name)) lastDone.set(name, rec);
  }
}
// ── the current pass, which reaches the board only when applied ─────────────────────────────────
const current = new Map(ROWS.map((r) => [r.name, r]));

/** The repo's best record of one plan task. */
function recordFor(t: Plan): Record_ {
  const cur = current.get(t.name);
  if (cur) return { status: cur.status, completed: cur.completed, shas: cur.shas, source: `pass ${PASS_DATE} (written when applied)` };
  if (t.done) {
    const d = lastDone.get(t.name);
    if (d) return d;
    const h = history.get(t.name);
    return { status: 'Done', shas: h?.shas, source: h ? `${h.source}; no Done date recorded in the repo` : 'plan (Done at create); no date in the repo' };
  }
  const h = history.get(t.name);
  return h ? { ...h, completed: undefined } : { status: 'Ready to Start', source: 'plan (created Ready to Start)' };
}

// ── rows ─────────────────────────────────────────────────────────────────────────────────────────
const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const HEAD = [
  'Kind', 'Epic code', 'Epic', 'Item', 'Type', 'Sprint', 'Quarter', 'Priority', 'Status',
  'Estimated SP', 'Actual SP', 'Completed Date', 'Commits', 'Latest commit', 'Source', 'Plan vs board',
];
const epicTitle = new Map(PLAN_EPICS.map((e) => [e.code, e.title]));
const out: string[][] = [];
const diffs: string[] = [];

let boardTasks: Map<string, { id: string; cols: Record<string, string> }> | null = null;
let boardEpics: Map<string, { id: string; name: string; cols: Record<string, string> }> | null = null;
const readAt = new Date().toISOString();
if (BOARD) {
  const [tasks, epics] = await Promise.all([
    listBoardItems(MONDAY_BOARDS.tasks, [
      TASK_COLS.status, TASK_COLS.type, TASK_COLS.priority, TASK_COLS.estimatedSp,
      TASK_COLS.actualSp, TASK_COLS.completed, TASK_COLS.sprint,
    ]),
    listBoardItems(MONDAY_BOARDS.epics, [EPIC_COLS.status, EPIC_COLS.quarter, EPIC_COLS.sp]),
  ]);
  boardTasks = new Map();
  for (const t of tasks.filter((x) => isOurTask(x.name))) {
    if (boardTasks.has(t.name)) diffs.push(`DUPLICATE board name ${t.name.slice(0, 80)}`);
    boardTasks.set(t.name, t);
  }
  boardEpics = new Map(epics.filter((e) => isOurEpic(e.name)).map((e) => [e.name.split('\t')[0], e]));
}

for (const e of PLAN_EPICS) {
  const kids = PLAN_TASKS.filter((t) => t.epic === e.code);
  const live = boardEpics?.get(e.code);
  const status = live ? live.cols[EPIC_COLS.status] || '(blank)' : e.status;
  const note: string[] = [];
  if (boardEpics && !live) note.push('NOT ON BOARD');
  if (live && status !== e.status) note.push(`plan says ${e.status}`);
  if (live && Number(live.cols[EPIC_COLS.sp] || 0) !== e.sp) note.push(`plan says ${e.sp} SP`);
  if (!boardEpics && e.code === 'HRIS-22') note.push('board says Cancelled (known drift, SKILL.md:397)');
  if (note.length) diffs.push(`${e.code}: ${note.join('; ')}`);
  out.push([
    'Epic', e.code, e.title, `${e.code} ${e.title}`, 'Epic', '', live?.cols[EPIC_COLS.quarter] || e.quarter, '',
    status, live ? live.cols[EPIC_COLS.sp] || '' : e.sp, '', '', '', '',
    BOARD ? `live board ${readAt}` : `plan (${kids.length} task rows, ${kids.reduce((a, t) => a + t.sp, 0)} SP)`,
    note.join('; '),
  ].map(String));
}

const planNames = new Set<string>();
const rollupTasks: { epic: string; sp: number; done: boolean; sprint: string }[] = [];
for (const t of PLAN_TASKS) {
  const name = taskItemName(t);
  planNames.add(name);
  const rec = recordFor(t);
  const live = boardTasks?.get(name);
  const note: string[] = [];
  let status = rec.status;
  let est: string | number = t.sp;
  let actual: string | number = status === 'Done' ? t.sp : '';
  let completed = status === 'Done' ? (rec.completed ?? '') : '';
  let sprint = TASK_SPRINT_LABELS[t.sprint];
  if (boardTasks && !live) note.push('NOT ON BOARD');
  if (live) {
    const c = live.cols;
    if ((c[TASK_COLS.status] || '') !== rec.status) note.push(`repo says ${rec.status}`);
    if (Number(c[TASK_COLS.estimatedSp] || 0) !== t.sp) note.push(`plan says ${t.sp} SP`);
    if ((c[TASK_COLS.sprint] || '') !== sprint) note.push(`plan says ${sprint}`);
    status = c[TASK_COLS.status] || '(blank)';
    est = c[TASK_COLS.estimatedSp] || '';
    actual = c[TASK_COLS.actualSp] || '';
    completed = c[TASK_COLS.completed] || '';
    sprint = c[TASK_COLS.sprint] || '';
    if (status === 'Done' && !completed) note.push('Done with no Completed Date');
    if (status !== 'Done' && (actual || completed)) note.push('Actual SP or date on a row that is not Done');
  }
  if (note.length) diffs.push(`${name.slice(0, 90)}: ${note.join('; ')}`);
  const shas = rec.shas ?? [];
  out.push([
    'Task', t.epic, epicTitle.get(t.epic) ?? '', name, live?.cols[TASK_COLS.type] || t.type, sprint, '',
    live?.cols[TASK_COLS.priority] || t.priority || '', status, est, actual, completed,
    shas.join(' '), shas.length ? `${GITHUB_COMMIT}${shas[shas.length - 1]}` : '',
    live ? `live board ${readAt}` : rec.source, note.join('; '),
  ].map(String));
  rollupTasks.push({ epic: t.epic, sp: Number(est) || 0, done: status === 'Done', sprint: t.sprint });
}
if (boardTasks) {
  for (const [name, t] of boardTasks) {
    if (planNames.has(name)) continue;
    diffs.push(`ON BOARD, NOT IN PLAN: ${name.slice(0, 90)}`);
    out.push([
      'Task', '', '', name, t.cols[TASK_COLS.type] || '', t.cols[TASK_COLS.sprint] || '', '', t.cols[TASK_COLS.priority] || '',
      t.cols[TASK_COLS.status] || '', t.cols[TASK_COLS.estimatedSp] || '', t.cols[TASK_COLS.actualSp] || '',
      t.cols[TASK_COLS.completed] || '', '', '', `live board ${readAt}`, 'on the board, not in the plan',
    ]);
  }
}

// ── summary ──────────────────────────────────────────────────────────────────────────────────────
const rollupEpics = PLAN_EPICS.map((e) => ({ code: e.code, sp: e.sp, status: boardEpics?.get(e.code)?.cols[EPIC_COLS.status] || e.status }));
const recorded = projectSp(rollupEpics, rollupTasks);
const notShipped = rollupEpics.filter((e) => e.status !== 'Shipped' && e.status !== 'Cancelled').map((e) => e.code);
const ifShipped = projectSp(rollupEpics, rollupTasks, notShipped);
const S = [['Section', 'Key', 'Rows', 'SP', 'Done SP', 'Open SP', 'Note']];
const src = BOARD ? `live board read ${readAt}` : `offline: plan + repo pass history (pass ${PASS_DATE} counted as applied)`;
S.push(['Source', 'this file', '', '', '', '', src]);
S.push(['Project (item 340 method)', 'Total Project SP', '', String(recorded.total), '', '', `Σ epic forecast ${recorded.forecast} + ${recorded.childPost} SP of task rows filed from Sprint 26 (Aug 4) on`]);
S.push(['Project (item 340 method)', 'SP Completed, as recorded', '', String(recorded.completed), '', '', `Total − ${recorded.openSp} open task SP − ${recorded.uncovered} forecast on not-Shipped epics that no row covers`]);
S.push(['Project (item 340 method)', `SP Completed, if the ${notShipped.length} In Progress epics are marked Shipped (V1 done)`, '', String(ifShipped.completed), '', '', `Total − ${ifShipped.openSp} open task SP. Epics: ${notShipped.join(' ')}`]);
S.push(['Project (portfolio rollup in sync.ts)', 'Σ epic forecast', String(PLAN_EPICS.length), String(recorded.forecast), '', '', 'what the Projects Portfolio row shows as Total; the item 340 figure there is item 154, still Kane\'s']);
S.push(['Task rows', 'all', String(recorded.taskRows), String(recorded.taskSp), String(recorded.doneSp), String(recorded.openSp), `${recorded.doneRows} Done · ${recorded.openRows} open`]);
for (const key of Object.keys(TASK_SPRINT_LABELS)) {
  const ts = rollupTasks.filter((t) => t.sprint === key);
  if (!ts.length) continue;
  const sp = ts.reduce((a, t) => a + t.sp, 0);
  const done = ts.filter((t) => t.done).reduce((a, t) => a + t.sp, 0);
  S.push(['By sprint', TASK_SPRINT_LABELS[key as keyof typeof TASK_SPRINT_LABELS], String(ts.length), String(sp), String(done), String(sp - done), '']);
}
for (const e of rollupEpics) {
  const ts = rollupTasks.filter((t) => t.epic === e.code);
  const sp = ts.reduce((a, t) => a + t.sp, 0);
  const done = ts.filter((t) => t.done).reduce((a, t) => a + t.sp, 0);
  const unc = recorded.uncoveredByEpic[e.code];
  S.push(['By epic', `${e.code} ${epicTitle.get(e.code)}`, String(ts.length), String(sp), String(done), String(sp - done),
    `${e.status} · forecast ${e.sp}${unc ? ` · ${unc} SP of forecast no row covers` : ''}`]);
}
for (const t of PLAN_TASKS) {
  const r = out.find((row) => row[0] === 'Task' && row[3] === taskItemName(t));
  if (r && r[8] !== 'Done') S.push(['Open row', r[3], '1', r[9], '0', r[9], `${r[8]} · ${r[5]}`]);
}

fs.mkdirSync(path.dirname(PREFIX), { recursive: true });
const write = (file: string, rows: string[][]) =>
  fs.writeFileSync(file, '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n', 'utf8');
const rowsFile = `${PREFIX}-monday-board.csv`;
const sumFile = `${PREFIX}-sp-summary.csv`;
write(rowsFile, [HEAD, ...out]);
write(sumFile, S);

const tasksOut = out.filter((r) => r[0] === 'Task');
const noDate = tasksOut.filter((r) => r[8] === 'Done' && !r[11]).length;
console.log(`source: ${src}`);
console.log(`wrote ${path.relative(REPO_ROOT, rowsFile)}: ${out.length - tasksOut.length} epics + ${tasksOut.length} tasks`);
console.log(`wrote ${path.relative(REPO_ROOT, sumFile)}`);
console.log(`  Total Project SP ${recorded.total} · SP Completed ${recorded.completed} as recorded, ${ifShipped.completed} if the ${notShipped.length} In Progress epics are Shipped`);
console.log(`  task rows ${recorded.taskRows} / ${recorded.taskSp} SP · Done ${recorded.doneRows} / ${recorded.doneSp} SP · open ${recorded.openRows} / ${recorded.openSp} SP`);
console.log(`  Done rows with no Completed Date: ${noDate}${BOARD ? ' (on the board)' : ' (in the repo record)'}`);
if (diffs.length) {
  console.log(`\nplan vs board / record notes (${diffs.length}):`);
  for (const d of diffs.slice(0, 60)) console.log(`  - ${d}`);
  if (diffs.length > 60) console.log(`  … ${diffs.length - 60} more, in the Plan vs board column`);
}
