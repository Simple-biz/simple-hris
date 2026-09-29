import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  INSIGHT_WEEKS,
  buildKpiInsights,
  compactPeso,
  isSentStatus,
  isSundayIso,
  monotonePath,
  niceTicks,
  scopeHslInsightBranchKeys,
  scopeInsightDeptKeys,
  toRuns,
  trendWindow,
  type InsightAppliedRow,
  type InsightStatusRow,
} from './kpi-insights';

const W1 = '2026-09-06';
const W2 = '2026-09-13';
const W3 = '2026-09-20';

function row(department: string, period_start: string, email: string | null, amount: number | string | null, name = ''): InsightAppliedRow {
  return { department, period_start, employee_email: email, employee_name: name || email, amount };
}
function st(department: string, period_start: string, status: string): InsightStatusRow {
  return { department, period_start, status };
}

describe('dates', () => {
  it('accepts only real Sundays', () => {
    assert.equal(isSundayIso('2026-09-20'), true);
    assert.equal(isSundayIso('2026-09-21'), false, 'Monday');
    assert.equal(isSundayIso('2026-02-30'), false, 'not a date');
    assert.equal(isSundayIso('2026-9-20'), false, 'not zero-padded');
    assert.equal(isSundayIso(null), false);
  });

  it('builds the window oldest-first, ending at `through`', () => {
    const w = trendWindow(W3);
    assert.equal(w.length, INSIGHT_WEEKS);
    assert.equal(w[w.length - 1], W3);
    assert.equal(w[w.length - 2], W2);
    assert.equal(w[0], '2026-07-05');
    assert.ok(w.every(isSundayIso));
  });
});

describe('scopeInsightDeptKeys — the server re-checks the grid', () => {
  it('a manager reads only their assigned departments', () => {
    const got = scopeInsightDeptKeys(['pm_team', 'lead_gen', 'accounting'], {
      kind: 'department',
      managed: ['PM Team', 'Lead Gen'],
    });
    assert.deepEqual(got, ['pm_team', 'lead_gen']);
  });

  it('an in-app department matches on the slug of its label', () => {
    const got = scopeInsightDeptKeys(['research_team'], {
      kind: 'department',
      managed: ['Research Team'],
    });
    assert.deepEqual(got, ['research_team']);
  });

  it('a RETIRED calculator department is refused even when granted, as on the grid', () => {
    const got = scopeInsightDeptKeys(['executive_assistants'], {
      kind: 'department',
      managed: ['Executive Assistants'],
    });
    assert.deepEqual(got, []);
  });

  it('namespaced hsl:* grants never open a department', () => {
    const got = scopeInsightDeptKeys(['hsl_intake_specialist', 'intake_specialist'], {
      kind: 'department',
      managed: ['hsl:intake_specialist'],
    });
    assert.deepEqual(got, []);
  });

  it('elevated with no assignments reads every calculator department, nothing else', () => {
    const got = scopeInsightDeptKeys(['pm_team', 'hogan_smith_law', 'smart_staff', 'made_up'], { kind: 'elevated' });
    assert.deepEqual(got, ['pm_team']);
  });

  it('no assignments and not elevated reads nothing', () => {
    assert.deepEqual(scopeInsightDeptKeys(['pm_team'], { kind: 'department', managed: [] }), []);
  });

  it('dedupes, and refuses malformed keys', () => {
    const got = scopeInsightDeptKeys(['pm_team', 'pm_team', 'PM_TEAM', "pm_team'--"], {
      kind: 'department',
      managed: ['PM Team'],
    });
    assert.deepEqual(got, ['pm_team']);
  });
});

describe('scopeHslInsightBranchKeys — the HSL calculator gate, re-derived on the server', () => {
  it('reads only the branches the caller holds an explicit hsl:<key> grant for', () => {
    const got = scopeHslInsightBranchKeys(
      ['medical_records', 'intake_specialist', 'callback_team'],
      ['hsl:medical_records', 'hsl:callback_team', 'PM Team'],
      [],
    );
    assert.deepEqual(got, ['medical_records', 'callback_team']);
  });

  it('matches grants case-insensitively, as canAccessHslDept does', () => {
    assert.deepEqual(scopeHslInsightBranchKeys(['attestation'], [' HSL:Attestation '], []), ['attestation']);
  });

  it('has no elevated arm: no grant, no branch — the parent HSL assignment and a bare key open nothing', () => {
    const all = ['medical_records', 'intake_specialist', 'hsl_managers'];
    assert.deepEqual(scopeHslInsightBranchKeys(all, [], []), []);
    assert.deepEqual(scopeHslInsightBranchKeys(all, ['Hogan Smith Law', 'HSL', 'hsl', 'hogan_smith_law'], []), []);
    assert.deepEqual(scopeHslInsightBranchKeys(all, ['medical_records', 'Intake Specialist'], []), []);
  });

  it('a roster-only noKpi team is refused even when granted — it has no bonus to average', () => {
    const got = scopeHslInsightBranchKeys(
      ['executive_guest_services', 'executive_assistants', 'medical_records'],
      ['hsl:executive_guest_services', 'hsl:executive_assistants', 'hsl:medical_records'],
      [],
    );
    assert.deepEqual(got, ['medical_records']);
  });

  it('a RETIRED or unknown branch resolves nothing, even with the grant still on file', () => {
    // `case_manager` (singular) was superseded by `case_managers` on 2026-07-17
    // and still holds 50 people's rows.
    const got = scopeHslInsightBranchKeys(['case_manager', 'made_up'], ['hsl:case_manager', 'hsl:made_up'], []);
    assert.deepEqual(got, []);
  });

  it('a DATA sub-team is admitted only while it is stored under HSL', () => {
    const managed = ['hsl:healthcare_specialist'];
    assert.deepEqual(scopeHslInsightBranchKeys(['healthcare_specialist'], managed, ['healthcare_specialist']), [
      'healthcare_specialist',
    ]);
    assert.deepEqual(scopeHslInsightBranchKeys(['healthcare_specialist'], managed, []), []);
  });

  it('a data key that collides with a noKpi code team does not reopen it (the code config wins)', () => {
    const got = scopeHslInsightBranchKeys(
      ['executive_guest_services'],
      ['hsl:executive_guest_services'],
      ['executive_guest_services'],
    );
    assert.deepEqual(got, []);
  });

  it('never opens a Departments-calculator key, and dedupes / refuses malformed keys', () => {
    const got = scopeHslInsightBranchKeys(
      ['pm_team', 'care_team', 'care_team', 'CARE_TEAM', "care_team'--"],
      ['hsl:care_team', 'PM Team', 'hsl:pm_team'],
      [],
    );
    assert.deepEqual(got, ['care_team']);
  });
});

describe('buildKpiInsights — sent is a STATUS, not a save', () => {
  const weeks = [W1, W2, W3];
  const depts = ['pm_team', 'edit'];

  it('only ready/locked dept-weeks reach `sent`; drafts are `pending`', () => {
    const out = buildKpiInsights({
      weeks,
      depts,
      selectedWeek: W3,
      applied: [row('pm_team', W3, 'a@x.com', 1000), row('edit', W3, 'b@x.com', 500)],
      statuses: [st('pm_team', W3, 'ready'), st('edit', W3, 'draft')],
    });
    const w3 = out.weeks[2]!;
    assert.equal(w3.sent, 1000);
    assert.equal(w3.pending, 500);
    assert.equal(w3.sentDepts, 1);
    assert.equal(w3.pendingDepts, 1);
    assert.equal(w3.sentPeople, 1);
    assert.equal(isSentStatus('locked'), true);
    assert.equal(isSentStatus('draft'), false);
    assert.equal(isSentStatus(null), false);
  });

  it('a week with no saved row is UNMEASURED, not ₱0', () => {
    const out = buildKpiInsights({
      weeks,
      depts,
      selectedWeek: W3,
      applied: [row('pm_team', W1, 'a@x.com', 100), row('pm_team', W3, 'a@x.com', 100)],
      statuses: [st('pm_team', W1, 'ready'), st('pm_team', W3, 'draft')],
    });
    assert.equal(out.weeks[1]!.measured, false, 'W2 has nothing saved');
    assert.equal(out.weeks[2]!.measured, true);
    assert.equal(out.weeks[2]!.sent, 0, 'rows saved, none sent → a real ₱0');
  });

  it('a status row for a department off the grid is ignored', () => {
    const out = buildKpiInsights({
      weeks,
      depts: ['pm_team'],
      selectedWeek: W3,
      applied: [row('pm_team', W3, 'a@x.com', 100), row('edit', W3, 'b@x.com', 900)],
      statuses: [st('pm_team', W3, 'ready'), st('edit', W3, 'ready')],
    });
    assert.equal(out.weeks[2]!.sent, 100);
  });

  it('sums in centavos (no float drift) and reads numeric strings', () => {
    const applied = Array.from({ length: 30 }, (_, i) => row('pm_team', W3, `p${i}@x.com`, '0.10'));
    const out = buildKpiInsights({ weeks, depts, selectedWeek: W3, applied, statuses: [st('pm_team', W3, 'locked')] });
    assert.equal(out.weeks[2]!.sent, 3);
  });

  it('a ready week with NO saved rows counts as sent (₱0) in the trend, as it does in the averages', () => {
    // HSL, measured 2026-09-29: Healthcare Team Lead and SSD's off-weeks are
    // Ready over zero rows every week. Counting sent by rows read them as "not
    // scored at all" and held the newest point hollow forever.
    const out = buildKpiInsights({
      weeks,
      depts: ['pm_team', 'edit', 'qc'],
      selectedWeek: W3,
      applied: [row('pm_team', W3, 'a@x.com', 1000)],
      statuses: [st('pm_team', W3, 'ready'), st('edit', W3, 'ready'), st('edit', W2, 'ready')],
    });
    const w3 = out.weeks[2]!;
    assert.equal(w3.sentDepts, 2, 'pm_team with rows + edit at ₱0');
    assert.equal(w3.pendingDepts, 0);
    assert.equal(w3.sent, 1000, 'a ₱0 submission adds nothing');
    assert.equal(3 - w3.sentDepts - w3.pendingDepts, 1, 'only qc is unscored');
    // No saved row anywhere that week → still NO point, whatever was sent.
    assert.equal(out.weeks[1]!.measured, false);
    assert.equal(out.weeks[1]!.sentDepts, 1);
    const edit = out.depts.find((d) => d.dept === 'edit')!;
    assert.equal(edit.weeksSent, 2, 'the averages already counted it');
  });
});

describe('department averages — ÷ the weeks the department SENT', () => {
  it('skipping a week does not drag the average down', () => {
    const out = buildKpiInsights({
      weeks: [W1, W2, W3],
      depts: ['pm_team'],
      selectedWeek: W3,
      applied: [
        row('pm_team', W1, 'a@x.com', 1000),
        row('pm_team', W1, 'b@x.com', 1000),
        row('pm_team', W2, 'a@x.com', 999), // saved, never sent
        row('pm_team', W3, 'a@x.com', 4000),
      ],
      statuses: [st('pm_team', W1, 'ready'), st('pm_team', W2, 'draft'), st('pm_team', W3, 'locked')],
    });
    const d = out.depts[0]!;
    assert.equal(d.weeksSent, 2);
    assert.equal(d.totalSent, 6000);
    assert.equal(d.avgWeekly, 3000);
    assert.equal(d.avgPerPerson, 2000, '6000 over three person-weeks');
    assert.deepEqual(d.series, [2000, null, 4000]);
  });

  it('a department that sent nothing averages 0 over 0 weeks', () => {
    const out = buildKpiInsights({ weeks: [W3], depts: ['edit'], selectedWeek: W3, applied: [], statuses: [] });
    assert.deepEqual(
      { w: out.depts[0]!.weeksSent, a: out.depts[0]!.avgWeekly, p: out.depts[0]!.avgPerPerson },
      { w: 0, a: 0, p: 0 },
    );
  });
});

describe('top earner — the selected week, one person summed across departments', () => {
  it('two departments in one week SUM before ranking', () => {
    const out = buildKpiInsights({
      weeks: [W3],
      depts: ['pm_team', 'edit'],
      selectedWeek: W3,
      applied: [
        row('pm_team', W3, 'Two@X.com', 600, 'Two Depts'),
        row('edit', W3, 'two@x.com', 600, 'Two Depts'),
        row('edit', W3, 'one@x.com', 1000, 'One Dept'),
      ],
      statuses: [st('pm_team', W3, 'ready')],
    });
    const s = out.spotlight;
    assert.equal(s.topAmount, 1200);
    assert.equal(s.tiedCount, 1);
    assert.equal(s.top[0]!.key, 'two@x.com');
    assert.deepEqual(s.top[0]!.depts, ['pm_team', 'edit']);
    assert.equal(s.top[0]!.sent, false, 'edit is still a draft, so this total is a projection');
    assert.equal(s.peoplePaid, 2);
    assert.equal(s.weekTotal, 2200);
    assert.equal(s.runnerUpAmount, 1000);
  });

  it('keeps every tied person, in name order, so the card can pick one at random', () => {
    const out = buildKpiInsights({
      weeks: [W3],
      depts: ['hr'],
      selectedWeek: W3,
      applied: [row('hr', W3, 'c@x.com', 500, 'Cara'), row('hr', W3, 'a@x.com', 500, 'Ana'), row('hr', W3, 'b@x.com', 100, 'Ben')],
      statuses: [st('hr', W3, 'ready')],
    });
    assert.deepEqual(out.spotlight.top.map((t) => t.name), ['Ana', 'Cara']);
    assert.equal(out.spotlight.tiedCount, 2);
    assert.equal(out.spotlight.runnerUpAmount, 100, 'the runner-up is the next DISTINCT amount, not the tie');
    assert.equal(out.spotlight.top[0]!.sent, true);
  });

  it('a row keyed on a NAME still ranks (and never crashes the card)', () => {
    const out = buildKpiInsights({
      weeks: [W3],
      depts: ['lead_gen'],
      selectedWeek: W3,
      applied: [{ department: 'lead_gen', period_start: W3, employee_email: null, employee_name: 'Mark A', amount: 750 }],
      statuses: [],
    });
    assert.equal(out.spotlight.top[0]!.key, 'name:mark a');
    assert.equal(out.spotlight.top[0]!.name, 'Mark A');
  });

  it('the selected week may sit outside the trend window', () => {
    const out = buildKpiInsights({
      weeks: [W1, W2],
      depts: ['hr'],
      selectedWeek: W3,
      applied: [row('hr', W3, 'a@x.com', 10)],
      statuses: [],
    });
    assert.equal(out.spotlight.topAmount, 10);
    assert.equal(out.weeks.some((w) => w.measured), false, 'but it never leaks into the trend');
  });

  it('an empty week has no top earner', () => {
    const out = buildKpiInsights({ weeks: [W3], depts: ['hr'], selectedWeek: W3, applied: [], statuses: [] });
    assert.deepEqual({ top: out.spotlight.top, amt: out.spotlight.topAmount }, { top: [], amt: 0 });
  });
});

describe('drawing helpers', () => {
  it('toRuns never bridges a gap', () => {
    assert.deepEqual(toRuns([1, 2, null, 3, null, null, 4, 5]), [
      { start: 0, items: [1, 2] },
      { start: 3, items: [3] },
      { start: 6, items: [4, 5] },
    ]);
    assert.deepEqual(toRuns([null, null]), []);
  });

  /** Sample each cubic segment and return its y-range. */
  function segmentYRanges(d: string): { lo: number; hi: number; y0: number; y1: number }[] {
    const nums = d.replace(/^M/, '').split(/C/);
    const [sx, sy] = nums[0]!.split(',').map(Number);
    let prev = { x: sx!, y: sy! };
    const out: { lo: number; hi: number; y0: number; y1: number }[] = [];
    for (const seg of nums.slice(1)) {
      const v = seg.split(',').map(Number);
      const [, c1y, , c2y, ex, ey] = v as [number, number, number, number, number, number];
      let lo = Infinity;
      let hi = -Infinity;
      for (let t = 0; t <= 1; t += 0.01) {
        const u = 1 - t;
        const y = u * u * u * prev.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey;
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
      out.push({ lo, hi, y0: prev.y, y1: ey });
      prev = { x: ex, y: ey };
    }
    return out;
  }

  it('monotonePath never overshoots a sharp drop (the Catmull-Rom failure)', () => {
    // Screen space: y grows downward; 200 is the ₱0 baseline.
    const pts = [
      { x: 0, y: 20 },
      { x: 50, y: 20 },
      { x: 100, y: 200 },
      { x: 150, y: 30 },
      { x: 200, y: 25 },
    ];
    for (const r of segmentYRanges(monotonePath(pts))) {
      assert.ok(r.lo >= Math.min(r.y0, r.y1) - 0.05, `dips past ${Math.min(r.y0, r.y1)}: ${r.lo}`);
      assert.ok(r.hi <= Math.max(r.y0, r.y1) + 0.05, `rises past ${Math.max(r.y0, r.y1)}: ${r.hi}`);
    }
  });

  it('degenerate inputs', () => {
    assert.equal(monotonePath([]), '');
    assert.equal(monotonePath([{ x: 1, y: 2 }]), 'M1,2');
    assert.equal(monotonePath([{ x: 1, y: 2 }, { x: 3, y: 4 }]), 'M1,2L3,4');
  });

  it('niceTicks keeps the peak inside the plot, zero-based', () => {
    const live = niceTicks(1_197_585);
    assert.deepEqual({ top: live.top, step: live.step }, { top: 1_200_000, step: 300_000 });
    assert.deepEqual(live.ticks, [0, 300_000, 600_000, 900_000, 1_200_000]);
    assert.ok(niceTicks(802_000).top >= 802_000);
    assert.ok(niceTicks(802_000).top / 802_000 < 1.35, 'no more than a third empty');
    assert.equal(niceTicks(0).top, 1);
    assert.equal(niceTicks(0).ticks[0], 0);
  });

  it('compactPeso', () => {
    assert.equal(compactPeso(1_250_000), '₱1.3M');
    assert.equal(compactPeso(350_000), '₱350k');
    assert.equal(compactPeso(900), '₱900');
  });
});

describe('source pins', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const route = readFileSync(path.join(root, 'app/api/manager/kpi-insights/route.ts'), 'utf8');
  const db = readFileSync(path.join(root, 'src/lib/supabase/kpi-insights-db.ts'), 'utf8');

  it('the route resolves scope from the SESSION, never from a client flag', () => {
    assert.match(route, /getServerSession\(authOptions\)/);
    assert.match(route, /listDepartmentsForManager\(sessionEmail\)/);
    assert.match(route, /scopeInsightDeptKeys\(/);
    assert.doesNotMatch(route, /searchParams\.get\('(elevated|scope|email)'\)/);
  });

  it('the HSL route resolves scope from the SESSION and the stored sub-teams, never from a client flag', () => {
    const hsl = readFileSync(path.join(root, 'app/api/manager/kpi-insights/hsl/route.ts'), 'utf8');
    assert.match(hsl, /getServerSession\(authOptions\)/);
    assert.match(hsl, /listDepartmentsForManager\(sessionEmail\)/);
    assert.match(hsl, /scopeHslInsightBranchKeys\(requested, managed, dataBranchKeys\)/);
    // The Departments scope admits every calculator dept for an elevated caller;
    // the HSL calculator has no such arm, so its route must not borrow it.
    assert.doesNotMatch(hsl, /scopeInsightDeptKeys/);
    assert.doesNotMatch(hsl, /searchParams\.get\('(elevated|scope|email)'\)/);
    // A failed sub-team read is a 500, never "no data branches".
    assert.match(hsl, /catch \(e\) \{\s*return empty\(/);
    assert.match(hsl, /readHslInsightEntries\(/);
    assert.doesNotMatch(hsl, /readInsightApplied\(/);
  });

  it('every multi-row read is paged (PostgREST truncates at 1000)', () => {
    const froms = db.match(/\.from\(/g)?.length ?? 0;
    const paged = db.match(/selectAllPaged</g)?.length ?? 0;
    const singleRow = db.match(/\.limit\(1\);/g)?.length ?? 0;
    assert.ok(froms > 0);
    assert.equal(singleRow, 1, 'only the latest-week probe is unpaged, and it reads one row');
    assert.equal(paged + singleRow, froms, 'every other .from() goes through selectAllPaged');
    assert.doesNotMatch(db, /\.select\('\*'\)/, 'projection only');
  });
});
