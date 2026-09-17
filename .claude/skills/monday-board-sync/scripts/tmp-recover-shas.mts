/** READ-ONLY, offline: recover full sha lists for rows from the git history of pass.mts. */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PLAN_TASKS, REPO_ROOT } from './monday.mts';

const git = (...a: string[]) =>
  execFileSync('git', a, { cwd: REPO_ROOT, maxBuffer: 256 * 1024 * 1024 }).toString();
const PATH = '.claude/skills/monday-board-sync/scripts/pass.mts';
const revs = git('log', '--format=%H', '--', PATH).trim().split('\n');
const NAMES: string[] = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

const SHAS = /shas: \[([^\]]*)\]/;
const out: Record<string, { name: string; shas: string[]; date: string; anc: boolean }> = {};

for (const rev of revs) {
  let body: string;
  try {
    body = git('show', `${rev}:${PATH}`);
  } catch {
    continue;
  }
  for (const frag of NAMES) {
    if (out[frag]) continue;
    const i = body.indexOf(frag);
    if (i < 0) continue;
    const start = body.lastIndexOf('\n  {', i);
    const end = body.indexOf('\n  },', i);
    if (start < 0 || end < 0) continue;
    const block = body.slice(start, end);
    const m = block.match(SHAS);
    if (!m) continue;
    const shas = [...m[1].matchAll(/'([0-9a-f]{6,40})'/g)].map((x) => x[1]);
    if (!shas.length) continue;
    const plan = PLAN_TASKS.find((t) => t.name.includes(frag));
    if (!plan) continue;
    const last = shas[shas.length - 1];
    let anc = false;
    try {
      git('merge-base', '--is-ancestor', last, 'origin/main');
      anc = true;
    } catch {
      anc = false;
    }
    out[frag] = {
      name: plan.name,
      shas,
      date: git('log', '-1', '--date=short', '--format=%ad', last).trim(),
      anc,
    };
  }
  if (Object.keys(out).length === NAMES.length) break;
}

fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2), 'utf8');
for (const f of NAMES) {
  const r = out[f];
  console.log(r ? `${r.date} anc=${r.anc} ${String(r.shas.length).padStart(2)} shas | ${r.name.slice(0, 58)}` : `MISSING  ${f}`);
}
