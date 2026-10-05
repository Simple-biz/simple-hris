import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';
import { casUpdateAppSetting, getAppSettingWithMetaStrict } from '@/lib/supabase/app-settings';
import { PAB_PERIOD_EXCLUSIONS_KEY } from '@/lib/pab-period-settings';
import { normEmail } from '@/lib/email/norm-email';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import {
  applyPabExclusionBatchPatch,
  buildPabExclusionNotification,
  parsePabExclusionRequest,
  parseStoredPabExclusionsForWrite,
  type PabExclusionOutcome,
} from '@/lib/notifications/pab-exclusion';
import { escapeLikePattern } from '@/lib/db/like-escape';
import { insertAuditLogs, type NewAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { recordNotifyFailure } from '@/lib/notifications/notify-failure-audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Basic email shape, excluding characters meaningful in a PostgREST or() filter
 *  (comma, parens, quotes, whitespace) — same guard used in admin-tools.ts. */
function isSafeEmail(s: string): boolean {
  return /^[^\s@,()"']+@[^\s@,()"']+\.[^\s@,()"']+$/.test(s);
}

/** Re-read + re-patch attempts when another writer lands between our read and
 *  our write. Same budget as the Pay Processors registry. */
const CAS_ATTEMPTS = 4;

/** Notification lookups in flight at once for a bulk Ignore. */
const NOTIFY_CONCURRENCY = 6;

type SessionActor = Awaited<ReturnType<typeof getSessionActor>>;

/**
 * Best-effort `pab.excluded` / `pab.restored` notification for one person.
 * Returns whether it was delivered. Never throws — the exclusion is already
 * written by the time this runs, and a notification outage must never block
 * payroll work (pab-exclusions.md § The notification is best-effort).
 */
async function notifyOne(
  norm: string,
  monthKey: string,
  excluded: boolean,
  actor: SessionActor,
): Promise<boolean> {
  try {
    if (!isSafeEmail(norm)) {
      console.warn(`[pab-exclusions] email has unsafe characters — notification skipped: ${norm}`);
      return false;
    }
    const supabase = createSupabaseServiceRoleClient();
    if (!supabase) return false;
    const escaped = escapeLikePattern(norm);
    const { data: matchRow, error: lookupError } = await supabase
      .from('active_employees')
      .select('"Work Email","Personal Email"')
      .or(
        `"Work Email".ilike.${escaped},"Personal Email".ilike.${escaped},"Alternate Work Email".ilike.${escaped},"Alternate Work Email 2".ilike.${escaped}`,
      )
      .limit(1)
      .maybeSingle();

    if (lookupError) {
      console.error('[pab-exclusions] active_employees lookup failed:', lookupError.message);
      return false;
    }
    const row = matchRow as Record<string, unknown> | null;
    const recipient =
      normEmail(typeof row?.['Work Email'] === 'string' ? (row['Work Email'] as string) : null) ??
      normEmail(typeof row?.['Personal Email'] === 'string' ? (row['Personal Email'] as string) : null);

    if (!recipient) {
      console.warn(`[pab-exclusions] no active_employees match for ${norm} — notification skipped`);
      return false;
    }
    const content = buildPabExclusionNotification(excluded, monthKey);
    const { error: notifErr } = await supabase.from('employee_notifications').insert({
      recipient_email: recipient,
      type: content.type,
      tone: content.tone,
      title: content.title,
      message: content.message,
      details: { month: monthKey },
    });
    if (notifErr) {
      // pab.excluded / pab.restored were dead for 17 days behind a bare
      // console.error — 0 rows inserted, no signal anywhere. Still non-fatal,
      // but recorded where someone will find it.
      await recordNotifyFailure({
        notificationType: content.type,
        origin: 'pab-exclusions',
        error: notifErr.message,
        actor,
        details: { employee: norm, recipient, month: monthKey, excluded },
      });
      return false;
    }
    return true;
  } catch (e) {
    console.error('[pab-exclusions] notification failed:', e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * Sets one or many people's PAB exclusion for one month and notifies each
 * person whose state changed. Body: `{ monthKey, excluded }` plus EITHER
 * `email` (the System Bonus modal toggle and the PAB step's row Ignore) OR
 * `emails` (the PAB step's bulk Ignore, ≤ `PAB_EXCLUSION_BATCH_MAX`).
 *
 * The write is ONE compare-and-swap over the whole blob, retried on conflict.
 * It used to be a read-patch-upsert, so two accountants ignoring two people at
 * the same moment could silently lose one entry; with a bulk Ignore the lost
 * write would be a whole batch. A batch is therefore all-or-nothing on the
 * exclusion: every person lands, or none does and the caller is told.
 */
export async function POST(request: Request) {
  try {
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
    }
    const parsed = parsePabExclusionRequest(body);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { monthKey, emails, excluded, batch } = parsed;

    // Resolved once and shared by the audit rows and any notify-failure row.
    const actor = await getSessionActor();

    let outcomes: PabExclusionOutcome[] | null = null;
    for (let attempt = 0; attempt < CAS_ATTEMPTS && outcomes === null; attempt++) {
      const current = await getAppSettingWithMetaStrict(PAB_PERIOD_EXCLUSIONS_KEY);
      const stored = parseStoredPabExclusionsForWrite(current?.value ?? null);
      if (!stored.ok) {
        // Never write over a value we cannot read: the reader would call it
        // empty and this save would wipe every other month's entries.
        return NextResponse.json(
          { error: 'The stored PAB exclusions could not be read, so nothing was changed. Nothing is overwritten until the setting is repaired.' },
          { status: 500 },
        );
      }
      const patch = applyPabExclusionBatchPatch(stored.exclusions, monthKey, emails, excluded);
      if (!patch.outcomes.some((o) => o.changed)) {
        // Nothing to write — re-posting the same state is not an event.
        outcomes = patch.outcomes;
        break;
      }
      const write = await casUpdateAppSetting(
        PAB_PERIOD_EXCLUSIONS_KEY,
        JSON.stringify(patch.nextExclusions),
        current?.updatedAt ?? null,
      );
      if (write.ok) outcomes = patch.outcomes;
      else if (write.error) return NextResponse.json({ error: write.error }, { status: 500 });
      // conflict ⇒ someone else saved first; re-read and re-apply onto theirs.
    }
    if (outcomes === null) {
      return NextResponse.json(
        { error: 'Someone else changed PAB exclusions at the same moment — nothing was saved. Please try again.' },
        { status: 409 },
      );
    }

    const changed = outcomes.filter((o) => o.changed);
    const notifiedByEmail = new Map<string, boolean>();
    for (let i = 0; i < changed.length; i += NOTIFY_CONCURRENCY) {
      const chunk = changed.slice(i, i + NOTIFY_CONCURRENCY);
      const flags = await Promise.all(chunk.map((o) => notifyOne(o.email, monthKey, excluded, actor)));
      chunk.forEach((o, j) => notifiedByEmail.set(o.email, flags[j]));
    }

    // ── Audit every change, one row per person ────────────────────────────────
    // An exclusion zeroes a person's Perfect Attendance Bonus for a whole month,
    // and until 2026-08-20 it recorded NOTHING (107 person-month entries with no
    // recoverable author). One row PER PERSON, mirroring pab_dispute.*, so the
    // existing audit readers and the Admin Penny action-family search see a bulk
    // Ignore exactly as they see N single ones; `batch` ties the N rows to the
    // one click. Written only for people whose state changed.
    const batchMeta = batch ? { id: randomUUID(), size: emails.length } : null;
    const auditRows: NewAuditLog[] = changed.map((o) => ({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: excluded ? 'pab_exclusion.added' : 'pab_exclusion.removed',
      resource: PAB_PERIOD_EXCLUSIONS_KEY,
      details: {
        employee: o.email,
        month: monthKey,
        excluded,
        was_excluded: o.wasExcluded,
        notified: notifiedByEmail.get(o.email) ?? false,
        ...(batchMeta ? { batch: batchMeta } : {}),
      },
    }));
    await insertAuditLogs(auditRows);

    if (!batch) {
      const only = outcomes[0];
      return NextResponse.json({
        success: true,
        wasExcluded: only.wasExcluded,
        notified: notifiedByEmail.get(only.email) ?? false,
        error: null,
      });
    }
    return NextResponse.json({
      success: true,
      results: outcomes.map((o) => ({
        email: o.email,
        wasExcluded: o.wasExcluded,
        changed: o.changed,
        notified: notifiedByEmail.get(o.email) ?? false,
      })),
      error: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
