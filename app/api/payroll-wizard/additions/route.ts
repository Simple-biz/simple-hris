import { NextResponse } from 'next/server';

import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { casUpdateAppSetting, getAppSettingWithMetaStrict } from '@/lib/supabase/app-settings';
import { additionsSettingKey, parseAdditionsSaveBody } from '@/lib/payroll/wizard-additions';
import { describeAdditionsSave } from '@/lib/payroll/wizard-additions-audit';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { auditFrom } from '@/lib/audit/context';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Concurrency-checked write for the Payroll Wizard additions blob
 * (`payroll.wizard.additions.<sourceFile>` — orphanage amounts, Adj. overrides,
 * metrics, bonus toggles, the PAB snapshot; the value that PAYS).
 *
 * The blob is one whole object, so it used to ride the generic
 * `/api/app-settings` POST — which is last-write-wins. A save from a tab
 * holding stale state therefore reverted EVERY person in the map with no error
 * on either side: that is how the 2026-08-09 week's 34 re-pasted corrections
 * were rolled back nine minutes after they landed, and how the 2026-08-23 week
 * ended up with 44 recorded-hours rows paying ₱0 (₱176k). See
 * docs/features/orphanage-pay-step.md §The 2026-08 incident / §Open.
 *
 * Here the client sends the `updated_at` it loaded alongside the value
 * (`expectedUpdatedAt`; null = "the blob did not exist when I read it") and the
 * write lands only if the row still carries that revision. A stale write gets a
 * 409 and NOTHING lands — the wizard then re-hydrates and the clerk re-applies
 * their change on top of what actually happened. There is no server-side merge
 * on purpose: the blob's maps carry deletions (removing a locked-in orphanage
 * amount deletes its key), and a merge cannot tell a stale key from an edit, so
 * it would quietly resurrect removed money. Refuse-and-rehydrate is the only
 * honest recovery.
 *
 * The generic `/api/app-settings` POST refuses this key family, so no
 * last-write-wins writer remains. Never "fix" a 409 here by dropping the CAS
 * predicate — the 409 IS the feature.
 */
export async function POST(req: Request) {
  const authz = await requireFeatureEdit('accounting', 'payroll_wizard');
  if (!authz.ok) return deniedResponse(authz);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const body = parseAdditionsSaveBody(raw);
  if (!body.ok) return NextResponse.json({ error: body.reason }, { status: 400 });

  const key = additionsSettingKey(body.sourceFile);

  // What is on file now, so a successful save can record exactly what it
  // changed (`wizard.additions_saved`). A failed read never blocks the save —
  // the event then says the old value is unknown.
  let prior: { value: string; updatedAt: string | null } | null = null;
  let priorUnavailable = false;
  try {
    prior = await getAppSettingWithMetaStrict(key);
  } catch {
    priorUnavailable = true;
  }

  const write = await casUpdateAppSetting(key, body.value, body.expectedUpdatedAt);
  if (write.error) return NextResponse.json({ error: write.error }, { status: 500 });
  if (write.conflict) {
    return NextResponse.json(
      {
        error:
          'Not saved — this period’s additions were saved by someone else after this tab loaded them.',
        conflict: true,
      },
      { status: 409 },
    );
  }

  // Every save that lands is on the record, whichever path produced it: the
  // Lock-in button, the Notes-board pre-fill, a KPI metric modal. The client's
  // per-edit `logAudit` calls cover only five updaters; this diff is what was
  // actually written. The CAS proved the row carried `expectedUpdatedAt`, so the
  // prior read is exact when it carried that same revision — otherwise another
  // save landed between the read and the write and `before_exact` says so.
  const audit = describeAdditionsSave(prior?.value ?? null, body.value, { beforeUnavailable: priorUnavailable });
  if (audit) {
    const sameRevision = (a: string | null, b: string | null) =>
      a === null || b === null ? a === b : Date.parse(a) === Date.parse(b);
    const beforeExact = !priorUnavailable && sameRevision(prior?.updatedAt ?? null, body.expectedUpdatedAt);
    await insertAuditLog({
      ...auditFrom(req, authz),
      action: 'wizard.additions_saved',
      resource: 'app_settings',
      resource_id: key,
      details: {
        ...audit,
        before_exact: beforeExact,
        cycle: { source_file: body.sourceFile },
      },
    }).catch(() => undefined);
  }

  // The row's new revision: the client chains its next save off this, so its
  // own back-to-back saves never self-conflict.
  return NextResponse.json({ error: null, updatedAt: write.updatedAt ?? null });
}
