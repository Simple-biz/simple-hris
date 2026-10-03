import { NextResponse } from 'next/server';

import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { NPD_SHEETS, type NpdSheetKind } from '@/lib/npd/columns';
import {
  bothNpdTabsLocked,
  buildNpdFeedText,
  npdFeedTabStatus,
  npdWeekForSourceFile,
  parseKnownVersions,
  type NpdFeedPayload,
  type NpdFeedTabStatus,
} from '@/lib/payroll/hris-npd-feed';
import { cleanSnapshotSourceFile } from '@/lib/payroll/hris-npd-snapshot';
import { readNpdSheet, readNpdSheetMeta, type NpdFailure } from '@/lib/supabase/npd-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Payroll Wizard → Validation → HRIS vs NPD: NPD's figures, read from NPD's own LOCKED
 * sheets. Kane, 2026-10-02: "once the values from NPD are both locked from ALL DEPT AND HSL -
 * The values from there will automatically feed here in the validation step". Governing doc:
 * docs/features/payroll-wizard-hris-vs-npd.md § NPD's locked sheets feed the step.
 *
 * READ-ONLY. Writes nothing and audits nothing.
 *
 * Gate: BOTH grants. `payroll_wizard` view, because the tab lives in the wizard; AND `npd`
 * view, because these are NPD's rows, and having the wizard does not give NPD (npd-dashboard.md
 * § Access, CHOSEN 1, "hidden until granted"). Without the NPD grant the reply says so
 * (`needsGrant`), and the step keeps its paste.
 *
 * GET ?sourceFile=<the wizard's week key>[&known=<allDeptVersion>,<hslVersion>]
 *   → `NpdFeedPayload`: the NPD week (the filename range's Sunday), each tab's state, and —
 *   ONLY when BOTH tabs are locked — the feed text (`buildNpdFeedText`). An unlocked tab's rows
 *   are never sent: until both are locked the figures are still being typed. `known` = the
 *   versions the caller already holds; if both tabs are still locked at exactly those, the
 *   rows are not re-read (`feed: 'unchanged'`), so the step's once-a-minute check costs two
 *   header reads.
 *
 * A failed read is an ERROR (500/503), never "not locked" and never an empty NPD: the step
 * must not compare HRIS against nobody and call that the answer.
 */

const NO_STORE = { 'Cache-Control': 'no-store' };

function failed(f: NpdFailure) {
  return NextResponse.json({ error: f.error, missing: f.missing }, { status: f.missing ? 503 : 500, headers: NO_STORE });
}

export async function GET(req: Request) {
  const wizard = await requireFeatureAccess('accounting', 'payroll_wizard', 'view');
  if (!wizard.ok) return deniedResponse(wizard);
  const npd = await requireFeatureAccess('accounting', 'npd', 'view');
  if (!npd.ok) {
    if (npd.status !== 403) return deniedResponse(npd);
    return NextResponse.json(
      {
        error:
          "Reading NPD's locked sheets needs the NPD (New Payroll Dashboard) grant. Paste NPD's figures instead, or ask an admin for NPD in Admin → Roles.",
        needsGrant: true,
      },
      { status: 403, headers: NO_STORE },
    );
  }

  const url = new URL(req.url);
  const sourceFile = cleanSnapshotSourceFile(url.searchParams.get('sourceFile'));
  if (!sourceFile) return NextResponse.json({ error: 'sourceFile is required' }, { status: 400 });
  const wk = npdWeekForSourceFile(sourceFile);
  if (!wk.ok) return NextResponse.json({ error: wk.reason, noWeek: true }, { status: 409, headers: NO_STORE });
  const week = wk.week;

  // Headers first: cheap, and enough to say what is locked.
  const metas = await Promise.all(NPD_SHEETS.map((s) => readNpdSheetMeta(s, week)));
  for (const m of metas) if (!m.ok) return failed(m);
  const headTabs = Object.fromEntries(
    NPD_SHEETS.map((s, i) => [s, npdFeedTabStatus((metas[i] as Extract<(typeof metas)[number], { ok: true }>).meta)]),
  ) as Record<NpdSheetKind, NpdFeedTabStatus>;

  if (!bothNpdTabsLocked(headTabs)) {
    return NextResponse.json({ week, tabs: headTabs, feed: null } satisfies NpdFeedPayload, { headers: NO_STORE });
  }

  const known = parseKnownVersions(url.searchParams.get('known'));
  if (known && NPD_SHEETS.every((s) => (headTabs[s] as { version: number }).version === known[s])) {
    return NextResponse.json({ week, tabs: headTabs, feed: 'unchanged' } satisfies NpdFeedPayload, { headers: NO_STORE });
  }

  // Both locked: read both sheets whole. `readNpdSheet` pages past PostgREST's 1000-row cap
  // and re-reads the header until the rows and the version agree.
  const sheets = await Promise.all(NPD_SHEETS.map((s) => readNpdSheet(s, week)));
  for (const r of sheets) if (!r.ok) return failed(r);
  const read = Object.fromEntries(
    NPD_SHEETS.map((s, i) => [s, sheets[i] as Extract<(typeof sheets)[number], { ok: true }>]),
  ) as Record<NpdSheetKind, Extract<(typeof sheets)[number], { ok: true }>>;
  const tabs = Object.fromEntries(NPD_SHEETS.map((s) => [s, npdFeedTabStatus(read[s].meta)])) as Record<
    NpdSheetKind,
    NpdFeedTabStatus
  >;
  // Unlocked between the header read and the rows: no feed, the same as never locked.
  if (!bothNpdTabsLocked(tabs)) {
    return NextResponse.json({ week, tabs, feed: null } satisfies NpdFeedPayload, { headers: NO_STORE });
  }

  const versions = { all_departments: read.all_departments.meta.version, hsl: read.hsl.meta.version };
  const built = buildNpdFeedText({
    week,
    sheets: {
      all_departments: { version: versions.all_departments, rows: read.all_departments.rows },
      hsl: { version: versions.hsl, rows: read.hsl.rows },
    },
  });
  return NextResponse.json(
    { week, tabs, feed: { versions, ...built } } satisfies NpdFeedPayload,
    { headers: NO_STORE },
  );
}
