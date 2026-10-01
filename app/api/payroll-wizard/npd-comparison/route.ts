import { createHash } from 'node:crypto';

import { NextResponse } from 'next/server';

import { auditFrom } from '@/lib/audit/context';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { cleanSnapshotSourceFile, validateHrisNpdSnapshot } from '@/lib/payroll/hris-npd-snapshot';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  readLatestHrisNpdSave,
  saveHrisNpdSnapshot,
  type HrisNpdSaveFailure,
} from '@/lib/supabase/hris-npd-snapshot-db';

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
 * POST order (source-guarded in hris-npd-snapshot.test.ts):
 *   1. validate — shape, every verdict against its tolerance, counts, totals, and the NPD
 *      side re-derived from the stored paste · 2. hash the VALIDATED snapshot (canonical
 *      key order), so re-saving an identical output returns the existing version ·
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
      },
    });
  }

  return NextResponse.json({ latest: saved.latest, unchanged: saved.unchanged }, { headers: NO_STORE });
}
