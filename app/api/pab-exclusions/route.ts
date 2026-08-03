import { NextResponse } from 'next/server';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';
import { getAppSettingStrict, upsertAppSetting } from '@/lib/supabase/app-settings';
import {
  parsePabPeriodExclusions,
  parseYearMonthKey,
  PAB_PERIOD_EXCLUSIONS_KEY,
} from '@/lib/pab-period-settings';
import { normEmail } from '@/lib/email/norm-email';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { applyPabExclusionPatch, buildPabExclusionNotification } from '@/lib/notifications/pab-exclusion';
import { escapeLikePattern } from '@/lib/db/like-escape';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Basic email shape, excluding characters meaningful in a PostgREST or() filter
 *  (comma, parens, quotes, whitespace) — same guard used in admin-tools.ts. */
function isSafeEmail(s: string): boolean {
  return /^[^\s@,()"']+@[^\s@,()"']+\.[^\s@,()"']+$/.test(s);
}

/**
 * Toggles a single person's PAB exclusion for one month and notifies them of
 * the change. Replaces the Payroll Wizard's previous direct write to the
 * generic `pab_period_exclusions` app-setting — this route owns both the
 * write AND the employee notification, matching how dispute decisions /
 * bank-preferred requests / resignation decisions already work.
 */
export async function POST(request: Request) {
  try {
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);

    const body = (await request.json()) as {
      email?: string;
      monthKey?: string;
      excluded?: boolean;
    };
    const monthKey = (body.monthKey ?? '').trim();
    const norm = normEmail(body.email ?? null);

    if (!parseYearMonthKey(monthKey)) {
      return NextResponse.json({ error: 'monthKey must be a valid YYYY-MM month' }, { status: 400 });
    }
    if (!norm) {
      return NextResponse.json({ error: 'Missing email' }, { status: 400 });
    }
    if (typeof body.excluded !== 'boolean') {
      return NextResponse.json({ error: 'excluded must be a boolean' }, { status: 400 });
    }
    const excluded = body.excluded;

    const currentRaw = await getAppSettingStrict(PAB_PERIOD_EXCLUSIONS_KEY);
    const currentExclusions = parsePabPeriodExclusions(currentRaw);
    const { nextExclusions, wasExcluded, changed } = applyPabExclusionPatch(
      currentExclusions,
      monthKey,
      norm,
      excluded,
    );

    const { error: writeError } = await upsertAppSetting(
      PAB_PERIOD_EXCLUSIONS_KEY,
      JSON.stringify(nextExclusions),
    );
    if (writeError) return NextResponse.json({ error: writeError }, { status: 500 });

    let notified = false;
    if (changed) {
      if (!isSafeEmail(norm)) {
        console.warn(`[pab-exclusions] email has unsafe characters — notification skipped: ${norm}`);
      } else {
        const supabase = createSupabaseServiceRoleClient();
        if (supabase) {
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
          } else {
            const row = matchRow as Record<string, unknown> | null;
            const recipient =
              normEmail(typeof row?.['Work Email'] === 'string' ? (row['Work Email'] as string) : null) ??
              normEmail(typeof row?.['Personal Email'] === 'string' ? (row['Personal Email'] as string) : null);

            if (recipient) {
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
                console.error('[pab-exclusions] notification insert failed:', notifErr.message);
              } else {
                notified = true;
              }
            } else {
              console.warn(`[pab-exclusions] no active_employees match for ${norm} — notification skipped`);
            }
          }
        }
      }
    }

    return NextResponse.json({ success: true, wasExcluded, notified, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
