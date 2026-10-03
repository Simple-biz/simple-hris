import { createHash } from 'node:crypto';

import { NextResponse } from 'next/server';

import { auditFrom } from '@/lib/audit/context';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { NPD_SHEETS, NPD_SHEET_LABELS } from '@/lib/npd/columns';
import { buildNpdFeedText, npdWeekForSourceFile, readNpdFeedSignature } from '@/lib/payroll/hris-npd-feed';
import { cleanSnapshotSourceFile, validateHrisNpdSnapshot } from '@/lib/payroll/hris-npd-snapshot';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  readLatestHrisNpdSave,
  saveHrisNpdSnapshot,
  type HrisNpdSaveFailure,
} from '@/lib/supabase/hris-npd-snapshot-db';
import { readNpdSheet } from '@/lib/supabase/npd-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Payroll Wizard → Validation step → HRIS vs NPD → **Save output**. Kane, 2026-10-01:
 * "save the output for the current week". Governing doc:
 * docs/features/payroll-wizard-hris-vs-npd.md § Saving the output.
 *
 * Gate: the `payroll_wizard` accounting feature — `view` to read the last save, `edit` to
 * save — the same as the Manual Validation route beside it on the same step. Admin bypass
 * inside `requireFeatureAccess`.
 *
 * Storage is two service-role-only tables (RLS on, no policies), NOT the shared settings
 * store, whose `payroll.wizard.*` family every signed-in user can read (Sep 16 log item
 * 161). A save APPENDS the week's next version and never overwrites one, so nothing here
 * needs an audit-before-delete; the database refuses any UPDATE of a saved output.
 *
 * POST order (source-guarded in hris-npd-snapshot.test.ts and hris-npd-feed.test.ts):
 *   1. validate — shape, every verdict against its tolerance, counts, totals, and the NPD
 *      side re-derived from the stored paste · 1b. when that paste is NPD's LOCKED-SHEETS
 *      feed (2026-10-02), prove it is still exactly what both locked sheets say: same week,
 *      both still locked at the versions it names, and rebuilt text identical — else nothing
 *      is saved (409 `npdChanged`) · 2. hash the VALIDATED snapshot (canonical key order), so
 *      re-saving an identical output returns the existing version ·
 *   3. the atomic save, which proves counts, totals and verdicts again ·
 *   4. `accounting.payroll_wizard.npd_comparison.saved`, for a new version only.
 * `saved_by` is the SESSION email, never anything from the body.
 */

const NO_STORE = { 'Cache-Control': 'no-store' };

/** A JSON body is capped well above a real week (~1,200 rows ≈ 0.5 MB). */
const MAX_BODY_BYTES = 4_000_000;

function failed(f: HrisNpdSaveFailure) {
  // A missing table is "not set up yet" (503). A refusal by the save function's own
  // checks (P0001, `pw_npd_cmp_*`) is the request's fault (400). Anything else is 500.
  // None of them is ever "nothing saved".
  const refusedByDb = !f.missing && /\bpw_npd_cmp_[a-z_]+/.test(f.error);
  return NextResponse.json(
    { error: refusedByDb ? `The database refused this output (${f.error}).` : f.error, missing: f.missing },
    { status: f.missing ? 503 : refusedByDb ? 400 : 500, headers: NO_STORE },
  );
}

/** GET ?sourceFile=… → `{ latest }`: the week's newest saved output (header only), or null. */
export async function GET(req: Request) {
  const authz = await requireFeatureAccess('accounting', 'payroll_wizard', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const sourceFile = cleanSnapshotSourceFile(new URL(req.url).searchParams.get('sourceFile'));
  if (!sourceFile) return NextResponse.json({ error: 'sourceFile is required' }, { status: 400 });

  const r = await readLatestHrisNpdSave(sourceFile);
  if (!r.ok) return failed(r);
  return NextResponse.json({ latest: r.latest }, { headers: NO_STORE });
}

/**
 * POST `{ sourceFile, snapshot: { header, rows } }` → `{ latest, unchanged }`.
 * `unchanged: true` = identical to the week's newest saved output, so nothing was written.
 */
export async function POST(req: Request) {
  const authz = await requireFeatureEdit('accounting', 'payroll_wizard');
  if (!authz.ok) return deniedResponse(authz);

  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'That output is too large to save.' }, { status: 413 });
  }
  let body: { sourceFile?: unknown; snapshot?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const sourceFile = cleanSnapshotSourceFile(body.sourceFile);
  if (!sourceFile) return NextResponse.json({ error: 'sourceFile is required' }, { status: 400 });

  const valid = validateHrisNpdSnapshot(body.snapshot);
  if (!valid.ok) {
    return NextResponse.json(
      { error: `This output can't be saved: ${valid.errors.slice(0, 3).join('; ')}`, errors: valid.errors },
      { status: 400 },
    );
  }

  // 1b. NPD's locked sheets: a saved output that says it compared them must match them.
  const source = await proveNpdSource(sourceFile, valid.snapshot.header.paste_text);
  if (!source.ok) return source.response;

  const contentSha256 = createHash('sha256').update(JSON.stringify(valid.snapshot)).digest('hex');

  const saved = await saveHrisNpdSnapshot({
    sourceFile,
    savedBy: authz.sessionEmail,
    contentSha256,
    snapshot: valid.snapshot,
  });
  if (!saved.ok) return failed(saved);

  if (!saved.unchanged) {
    const h = valid.snapshot.header;
    void insertAuditLog({
      ...auditFrom(req, authz),
      action: 'accounting.payroll_wizard.npd_comparison.saved',
      resource: 'payroll_wizard_npd_comparisons',
      resource_id: saved.latest.id,
      details: {
        source_file: sourceFile,
        version: saved.latest.version,
        tolerance_cents: h.tolerance_cents,
        fx_rate: h.fx_rate,
        rows: h.row_count,
        match: h.match_count,
        mismatch: h.mismatch_count,
        not_in_hris: h.not_in_hris_count,
        not_in_npd: h.not_in_npd_count,
        left_out: h.left_out_count,
        refused_lines: h.refusal_count,
        hris_total_cents: h.hris_total_cents,
        npd_total_cents: h.npd_total_cents,
        content_sha256: contentSha256,
        ...(source.feed
          ? { npd_source: 'locked_sheets', npd_week: source.feed.week, npd_versions: source.feed.versions }
          : { npd_source: 'paste' }),
      },
    });
  }

  return NextResponse.json({ latest: saved.latest, unchanged: saved.unchanged }, { headers: NO_STORE });
}

/**
 * Where the saved NPD figures came from. A typed paste is trusted as typed (the operator's
 * paste is the record, re-derived in `validateHrisNpdSnapshot`). NPD's LOCKED-SHEETS feed
 * names its week and each sheet's version in its first line, so it is held to that: this
 * output's week, both tabs still locked at exactly those versions, and the text rebuilt from
 * the sheets identical byte for byte. Anything else saves nothing. A failed read of NPD is an
 * error, never a pass.
 */
async function proveNpdSource(
  sourceFile: string,
  pasteText: string,
): Promise<
  | { ok: true; feed: null | { week: string; versions: Record<string, number> } }
  | { ok: false; response: NextResponse }
> {
  const sig = readNpdFeedSignature(pasteText);
  if (sig.kind === 'paste') return { ok: true, feed: null };
  const refuse = (status: number, error: string, extra: Record<string, unknown> = {}) => ({
    ok: false as const,
    response: NextResponse.json({ error, ...extra }, { status, headers: NO_STORE }),
  });
  if (sig.kind === 'malformed') {
    return refuse(400, "This output can't be saved: its NPD figures start like NPD's locked sheets but are not them exactly.");
  }
  const wk = npdWeekForSourceFile(sourceFile);
  if (!wk.ok || wk.week !== sig.week) {
    return refuse(400, `This output can't be saved: its NPD figures are NPD's week of ${sig.week}, not this wizard week's.`);
  }

  const reads = await Promise.all(NPD_SHEETS.map((s) => readNpdSheet(s, sig.week)));
  const changed: string[] = [];
  for (const [i, s] of NPD_SHEETS.entries()) {
    const r = reads[i]!;
    if (!r.ok) {
      return refuse(
        r.missing ? 503 : 500,
        `NPD's locked sheets could not be read to check this output, so nothing was saved: ${r.error}`,
      );
    }
    if (!r.meta.lockedAt) changed.push(`${NPD_SHEET_LABELS[s]} is no longer locked`);
    else if (r.meta.version !== sig.versions[s]) changed.push(`${NPD_SHEET_LABELS[s]} is now v${r.meta.version}, not v${sig.versions[s]}`);
  }
  if (changed.length > 0) {
    return refuse(
      409,
      `NPD changed since this output was loaded (${changed.join('; ')}). Nothing was saved. Refresh the NPD figures and check the output again.`,
      { npdChanged: true },
    );
  }
  const ok = (i: number) => reads[i] as Extract<(typeof reads)[number], { ok: true }>;
  const rebuilt = buildNpdFeedText({
    week: sig.week,
    sheets: {
      all_departments: { version: ok(0).meta.version, rows: ok(0).rows },
      hsl: { version: ok(1).meta.version, rows: ok(1).rows },
    },
  });
  if (rebuilt.text !== pasteText) {
    return refuse(400, "This output can't be saved: its NPD figures are not what NPD's locked sheets say.");
  }
  return { ok: true, feed: { week: sig.week, versions: { ...sig.versions } } };
}
