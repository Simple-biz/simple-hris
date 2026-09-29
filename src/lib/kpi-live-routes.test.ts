import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Every route that changes what a published KPI week pays, or its status, must
// announce on `kpi-bonus-sync` — through `after()`, so the send outlives the
// response. A writer that forgets leaves every open dashboard stale with no
// error anywhere (the three DELETEs announced nothing before 2026-09-29).
const ROOT = path.resolve(__dirname, '..', '..');
const WRITERS: Array<{ file: string; announcer: 'announceKpiStatusChange' | 'announceKpiBonusChange'; calls: number }> = [
  { file: 'app/api/hsl-bonus/period-status/route.ts', announcer: 'announceKpiStatusChange', calls: 1 },
  { file: 'app/api/hsl-bonus/period/route.ts', announcer: 'announceKpiStatusChange', calls: 1 },
  { file: 'app/api/bonus-catalog-applied/route.ts', announcer: 'announceKpiBonusChange', calls: 2 },
  { file: 'app/api/hsl-bonus/entries/route.ts', announcer: 'announceKpiBonusChange', calls: 2 },
];

for (const w of WRITERS) {
  test(`${w.file} announces every KPI write (${w.calls}×, via after())`, () => {
    const src = fs.readFileSync(path.join(ROOT, w.file), 'utf8');
    const viaAfter = src.match(new RegExp(`after\\(\\s*${w.announcer}\\(`, 'g')) ?? [];
    assert.equal(viaAfter.length, w.calls, `${w.file}: expected ${w.calls} after(${w.announcer}(…)) calls`);
    assert.ok(!new RegExp(`void\\s+${w.announcer}\\(`).test(src), 'a void-ed announce can be frozen with the function');
  });
}

test('no KPI surface re-subscribes postgres_changes as its "live" path', () => {
  // Measured 2026-09-29: anon reads 0 of 337 / 18,969 / 7,118 rows of the three KPI
  // tables, so a binding there never fires. The wizard's was removed; this keeps it out.
  const wizard = fs.readFileSync(path.join(ROOT, 'src/components/PayrollWizard.tsx'), 'utf8');
  assert.ok(!wizard.includes("'payroll-wizard-hsl-status'"), 'the dead wizard HSL channel came back');
});
