import { NextResponse } from 'next/server';

import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { casUpdateAppSetting, getAppSettingWithMetaStrict } from '@/lib/supabase/app-settings';
import {
  MV_NOTE_MAX_LEN,
  mergeIntoRawMvBlob,
  mvSettingKey,
  normalizeMvEmail,
  normalizeMvNote,
  parseManualValidationMap,
} from '@/lib/payroll/manual-validation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Manual validation ("MV") — a human vouching that one person's pay for one
 * cycle was checked by hand. Read by the Payroll Wizard's Validation step and by
 * the Mark Paid dialog, so the clerk sending the money can see who vouched for
 * the figure and what they said.
 *
 * Storage is one `app_settings` row per cycle (see `manual-validation.ts` for
 * why it is not a `payment_dispatches` column). Writes go through THIS route
 * rather than the generic `/api/app-settings` POST for three reasons:
 *
 *  1. **Merge, not replace.** The generic POST takes a whole value, so the
 *     client would have to send the entire map — and two clerks validating at
 *     the same time would overwrite each other with no error. Here the server
 *     merges one key under a compare-and-swap.
 *  2. **Attribution the client cannot forge.** `by` is the session email and
 *     `at` is stamped here. A client-supplied validator or timestamp would let
 *     someone vouch in another person's name, or backdate their own vouching —
 *     which is the entire value of the record.
 *  3. **An audit trail.** `payroll.wizard.*` writes through the generic route
 *     are not audited (`app/api/app-settings/route.ts` audits only admin-only,
 *     sensitive and dispatch-lock keys). An accountability record that leaves no
 *     trace of who set it is not much of a record.
 */

/** How many times to re-read-and-merge before giving up. Contention is two or
 *  three clerks on the same week, not a thundering herd, so a small bound is
 *  plenty — and an unbounded loop under a real fault would spin forever. */
const MAX_CAS_ATTEMPTS = 5;

/** Keys are built from this, so keep it to something filename-shaped. The fixed
 *  `payroll.wizard.mv.` prefix already contains the blast radius; this only
 *  stops control characters and absurd lengths from becoming keys. */
function cleanSourceFile(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s === '' || s.length > 300) return null;
  // Reject control characters explicitly rather than with a regex range — a real
  // source file is `simple-biz_daily_report_2026-08-09_to_2026-08-15.csv`, and a
  // mis-escaped character class here would silently reject every one of them.
  for (let j = 0; j < s.length; j += 1) {
    const code = s.charCodeAt(j);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return s;
}

/** GET ?sourceFile=… — the whole map for one cycle. Anyone who can SEE the
 *  wizard can read it; the Mark Paid dialog needs it too. */
export async function GET(req: Request) {
  const authz = await requireFeatureAccess('accounting', 'payroll_wizard', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const sourceFile = cleanSourceFile(new URL(req.url).searchParams.get('sourceFile'));
  if (!sourceFile) return NextResponse.json({ error: 'sourceFile is required' }, { status: 400 });

  try {
    const stored = await getAppSettingWithMetaStrict(mvSettingKey(sourceFile));
    const { map, malformed } = parseManualValidationMap(stored?.value ?? null);
    return NextResponse.json({ validations: map, malformed });
  } catch (err) {
    // A failed READ must never be reported as "nobody has validated anything".
    // The Validation step would render every row unticked and invite a clerk to
    // re-do work that is already recorded.
    const message = err instanceof Error ? err.message : 'Read failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * PATCH — set or clear ONE person's validation.
 * Body: `{ sourceFile, email, validated: boolean, note?: string | null }`.
 *
 * `validated: false` deletes the entry (an un-tick), so "not validated" has a
 * single representation. The note is optional by design — ticking without
 * typing anything is the common case.
 */
export async function PATCH(req: Request) {
  const authz = await requireFeatureEdit('accounting', 'payroll_wizard');
  if (!authz.ok) return deniedResponse(authz);

  let body: { sourceFile?: unknown; email?: unknown; validated?: unknown; note?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const sourceFile = cleanSourceFile(body.sourceFile);
  if (!sourceFile) return NextResponse.json({ error: 'sourceFile is required' }, { status: 400 });

  const email = normalizeMvEmail(typeof body.email === 'string' ? body.email : null);
  if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 });

  if (typeof body.validated !== 'boolean') {
    return NextResponse.json({ error: 'validated must be true or false' }, { status: 400 });
  }

  if (body.note != null && typeof body.note !== 'string') {
    return NextResponse.json({ error: 'note must be a string' }, { status: 400 });
  }
  const rawNote = typeof body.note === 'string' ? body.note : null;
  if (rawNote != null && rawNote.trim().length > MV_NOTE_MAX_LEN) {
    return NextResponse.json(
      { error: `A note is limited to ${MV_NOTE_MAX_LEN} characters.` },
      { status: 400 },
    );
  }

  const key = mvSettingKey(sourceFile);
  // Stamped HERE, never accepted from the client — see the header comment.
  const at = new Date().toISOString();
  const entry = body.validated
    ? { by: authz.sessionEmail, at, note: normalizeMvNote(rawNote) }
    : null;

  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
    let stored: { value: string; updatedAt: string | null } | null;
    try {
      stored = await getAppSettingWithMetaStrict(key);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Read failed';
      return NextResponse.json({ error: message }, { status: 500 });
    }

    const merged = mergeIntoRawMvBlob(stored?.value ?? null, email, entry);
    if (!merged.ok) {
      // The stored blob is unreadable. Refusing is the correct outcome: it may
      // still hold other people's validations, and overwriting destroys them.
      return NextResponse.json({ error: merged.reason }, { status: 409 });
    }

    const write = await casUpdateAppSetting(key, merged.next, stored?.updatedAt ?? null);
    if (write.error) return NextResponse.json({ error: write.error }, { status: 500 });
    if (write.conflict) continue; // somebody else wrote first — re-read and re-merge

    void insertAuditLog({
      user_name: authz.sessionEmail,
      user_role: authz.roles[0] ?? 'accounting',
      action: body.validated
        ? 'accounting.payroll_wizard.manual_validation.set'
        : 'accounting.payroll_wizard.manual_validation.cleared',
      resource: 'app_settings',
      resource_id: key,
      details: {
        source_file: sourceFile,
        subject_email: email,
        note: entry?.note ?? null,
        attempts: attempt,
      },
    });

    const { map, malformed } = parseManualValidationMap(merged.next);
    return NextResponse.json({ validations: map, malformed, entry });
  }

  // Lost the race MAX_CAS_ATTEMPTS times. Report it instead of forcing the
  // write — the client re-reads and the clerk re-ticks, which is recoverable.
  // A forced write here would be the exact lost-update this route prevents.
  return NextResponse.json(
    { error: 'Another clerk is editing this cycle’s validations. Try again.' },
    { status: 409 },
  );
}
