import { NextResponse } from 'next/server';

import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { casUpdateAppSetting } from '@/lib/supabase/app-settings';
import { additionsSettingKey, parseAdditionsSaveBody } from '@/lib/payroll/wizard-additions';

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

  const write = await casUpdateAppSetting(
    additionsSettingKey(body.sourceFile),
    body.value,
    body.expectedUpdatedAt,
  );
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

  // The row's new revision: the client chains its next save off this, so its
  // own back-to-back saves never self-conflict.
  return NextResponse.json({ error: null, updatedAt: write.updatedAt ?? null });
}
