/**
 * READ-ONLY: the mechanical half of "what actually shipped". No Monday calls, no network.
 *
 *   node --import tsx .claude/skills/monday-board-sync/scripts/sprint-evidence.mts [<base>[..<head>]]
 *
 * Defaults to the last board-sync commit recorded in pass.mts. Gathers only what a script can PROVE:
 *
 *   • every commit in the range with its file list and insertion count
 *   • whether each sha is an ancestor of origin/main       → In Progress vs Pending Deploy
 *   • whether it adds a migration or an n8n workflow        → forces Pending Deploy
 *   • which files are pure noise (settings/build artefacts) → no board row warranted
 *   • which plan names already exist, so a near-miss cannot become a duplicate row
 *
 * What it deliberately does NOT do is cluster the commits. Grouping is judgement and must be done by
 * reading the file lists: in one 78-commit range, four commits had messages that actively lied about
 * their contents and one commit reversed another. A script that grouped by message would have been
 * wrong five times. Read the output, then write pass.mts by hand.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PLAN_TASKS, REPO_ROOT, taskItemName } from './monday.mts';
import { AUDIT_RANGE } from './pass.mts';

const git = (...args: string[]) => execFileSync('git', args, { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 }).toString();
const arg = process.argv[2];
const range = arg?.includes('..') ? arg : `${arg ?? AUDIT_RANGE.split('..')[0]}..HEAD`;
const [base] = range.split('..');

console.log(`range: ${range}`);
try {
  git('merge-base', '--is-ancestor', base, 'HEAD');
  console.log(`  ${base} is an ancestor of HEAD — range is sane`);
} catch {
  console.error(`  ${base} is NOT an ancestor of HEAD — the range is wrong, fix it before scoring anything`);
  process.exit(1);
}
const head = git('rev-parse', '--short', 'HEAD').trim();
let originMain = '';
try {
  originMain = git('rev-parse', '--short', 'origin/main').trim();
} catch {
  console.log('  WARNING: no origin/main ref — cannot prove anything is pushed. Everything is In Progress.');
}
const ahead = originMain ? git('rev-list', '--count', 'origin/main..HEAD').trim() : '?';
console.log(`  HEAD ${head} · origin/main ${originMain || '(none)'} · unpushed commits: ${ahead}`);

// One numstat call for the whole range beats one call per commit.
const raw = git('log', '--date=short', '--numstat', '--pretty=format:@@@|%h|%ad|%s', range);
interface Commit {
  sha: string;
  date: string;
  subject: string;
  files: string[];
  insertions: number;
}
const commits: Commit[] = [];
for (const line of raw.split(/\r?\n/)) {
  if (line.startsWith('@@@|')) {
    const [, sha, date, ...rest] = line.split('|');
    commits.push({ sha, date, subject: rest.join('|'), files: [], insertions: 0 });
    continue;
  }
  const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
  if (m && commits.length) {
    const c = commits[commits.length - 1];
    c.files.push(m[3]);
    c.insertions += m[1] === '-' ? 0 : Number(m[1]);
  }
}
console.log(`\n${commits.length} commits in range\n`);

const NOISE = /^(\.claude\/settings|tsconfig\.tsbuildinfo|next-env\.d\.ts|\.next\/|package-lock\.json$)/;
const isNoise = (c: Commit) => c.files.length > 0 && c.files.every((f) => NOISE.test(f));

const pushedCache = new Map<string, boolean>();
const isPushed = (sha: string) => {
  if (!originMain) return false;
  if (!pushedCache.has(sha)) {
    try {
      git('merge-base', '--is-ancestor', sha, 'origin/main');
      pushedCache.set(sha, true);
    } catch {
      pushedCache.set(sha, false);
    }
  }
  return pushedCache.get(sha)!;
};

const noise: Commit[] = [];
console.log(`${'sha'.padEnd(9)} ${'date'.padEnd(11)} ${'push'} ${'files'.padStart(5)} ${'+lines'.padStart(7)}  blockers / subject`);
for (const c of commits) {
  if (isNoise(c)) {
    noise.push(c);
    continue;
  }
  const blockers: string[] = [];
  if (c.files.some((f) => /^references\/sql\//.test(f))) blockers.push('MIGRATION');
  if (c.files.some((f) => /^scripts\/apply-.*\.(mjs|mts)$/.test(f))) blockers.push('APPLY-SCRIPT');
  if (c.files.some((f) => /^references\/n8n\//.test(f))) blockers.push('N8N-IMPORT');
  const flag = blockers.length ? `[${blockers.join(' ')}] ` : '';
  console.log(
    `${c.sha.padEnd(9)} ${c.date.padEnd(11)} ${isPushed(c.sha) ? ' ok ' : 'UNPU'} ${String(c.files.length).padStart(5)} ${String(c.insertions).padStart(7)}  ${flag}${c.subject.slice(0, 76)}`,
  );
  // A junk message hiding a big diff is the single most common way real features get missed.
  if (c.insertions > 400 || c.files.length > 15) {
    console.log(`          ^ LARGE — diff the file list, the message may cover only part of it:`);
    for (const f of c.files.slice(0, 10)) console.log(`            ${f}`);
    if (c.files.length > 10) console.log(`            ... and ${c.files.length - 10} more`);
  }
}

if (noise.length) {
  console.log(`\nnoise commits (settings/build artefacts only — NO board row warranted): ${noise.length}`);
  for (const c of noise) console.log(`  ${c.sha} ${c.date} ${c.subject.slice(0, 70)}`);
}

const unpushed = commits.filter((c) => !isNoise(c) && !isPushed(c.sha));
console.log(`\nunpushed non-noise commits: ${unpushed.length}${unpushed.length ? ' → anything built on these is In Progress, not Pending Deploy' : ''}`);

// Every un-run external step in the repo. A row whose feature depends on one of these is not Done.
console.log('\n=== external steps that force Pending Deploy ===');
for (const dir of ['references/n8n', 'references/sql']) {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  const files = fs.readdirSync(abs, { recursive: true, encoding: 'utf8' }).filter((f) => /\.(json|sql)$/.test(f));
  console.log(`  ${dir}: ${files.length} files — an entry here is a claim, NOT proof it is un-run. Cross-check the`);
  console.log(`    Deploy notes in docs/features/ and the memory dir; five PENDING claims in this repo are stale.`);
}

console.log('\n=== plan name collisions ===');
const existing = new Set(PLAN_TASKS.map((t) => t.name));
console.log(`  ${existing.size} names already in PLAN_TASKS. Before adding a row, check it is not a near-miss of one`);
console.log(`  of these — the reconciler matches byte-exact, so a near-duplicate becomes a permanent second row.`);
console.log(`  Board names carry the "[HRIS] " prefix, e.g. ${JSON.stringify(taskItemName({ name: 'Example' }))}`);
