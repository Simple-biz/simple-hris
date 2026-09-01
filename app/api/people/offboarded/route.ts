import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { deniedResponse, requireRateVisibilitySession } from '@/lib/auth/authorize-email';
import { listOffboardedSheetRows } from '@/lib/supabase/global-master-list-db';
import { getAppSettings } from '@/lib/supabase/app-settings';
import { normEmail } from '@/lib/email/norm-email';
import { offboardSnapshotKey, type OffboardSnapshot } from '@/lib/hr/offboard-snapshot';
import {
  fetchLegacyBankPreferredByEmail,
  fetchPayoutIdsByEmail,
} from '@/lib/payroll/urgent-payout-details';
import {
  foldBankStatus,
  matchOffboardedRows,
  type OffboardedBankStatus,
  type OffboardedSearchHit,
} from '@/lib/people/offboarded-search';
import type { OffboardedBankPrefill } from '@/lib/payroll/offboarded-payroll-candidates';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export interface OffboardedSearchRow extends OffboardedSearchHit {
  bankStatus: OffboardedBankStatus;
  /** LIVE-resolved effective rail (the one allowed to LOCK Set Bank's picker
   *  and the one the chip names). Null = unrouted. */
  bankProcessor: string | null;
  /** Present only when bankStatus is 'missing_has_snapshot' — seeds Set Bank
   *  with what was on file at the moment they were offboarded. */
  bankPrefill: OffboardedBankPrefill | null;
  /** When the row's work email belongs to someone on the ACTIVE roster today,
   *  their name — the recycled-email caution (warn-and-allow, Kane 2026-09-01).
   *  Pay prefills and bank edits on this email physically target that person. */
  activeHolder: string | null;
}

/**
 * GET /api/people/offboarded?q=<search>
 *
 * People → Offboarded tab: search the WHOLE `offboarded_sheet` ledger at ROW
 * grain by name or work email — a recycled work email returns every record
 * that ever carried it (they are different people; `id` is the identity).
 * Matches are enriched with bank status (live employee_ids + legacy rates
 * fallbacks, else the offboard snapshot), so the tab can chip "Bank on file ·
 * <rail>" / "No Bank" and seed the shared SetBankDialog.
 *
 * Bank enrichment reads the SAME pair the Urgent one-off cards prefill from
 * (`fetchPayoutIdsByEmail` + `fetchLegacyBankPreferredByEmail`) — this tab's
 * Pay button files into that queue, so the chip must agree with the card the
 * clerk will actually see, not with a stricter parallel resolution.
 *
 * Gate mirrors /api/people (admin / accounting / ceo).
 */
export async function GET(request: NextRequest) {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  const q = request.nextUrl.searchParams.get('q') ?? '';

  try {
    const ledger = await listOffboardedSheetRows();
    const hits: OffboardedSearchHit[] = ledger.map((r) => ({
      id: String(r.id),
      name: r.name,
      workEmail: r.work_email,
      personalEmail: r.personal_email,
      department: r.department,
      startDate: r.start_date,
      offBoardedAt: r.off_boarded_at,
      origin: r.origin,
    }));
    const { rows: matched, total } = matchOffboardedRows(hits, q);

    if (matched.length === 0) {
      return NextResponse.json({ rows: [], total });
    }

    const supabase = createSupabaseServiceRoleClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    const workEmails = [
      ...new Set(
        matched
          .map((r) => normEmail(r.workEmail ?? ''))
          .filter((e): e is string => !!e),
      ),
    ];

    // Enrichment is best-effort where safety allows: a failed employee_ids or
    // snapshot read degrades a chip to "No Bank" (the clerk still hand-fills
    // Mark Paid at send time — same posture as the Urgent feed). The ACTIVE-
    // roster read is the exception: it powers a money-direction warning, so a
    // failure must SAY so rather than silently claiming "no collision".
    const [idsByEmail, legacyByEmail, rawSnapshots, activeRes] = await Promise.all([
      fetchPayoutIdsByEmail(supabase, workEmails),
      fetchLegacyBankPreferredByEmail(supabase, workEmails).catch(
        () => ({}) as Record<string, string | null>,
      ),
      getAppSettings(workEmails.map((e) => offboardSnapshotKey(e))).catch(
        () => ({}) as Record<string, string | null>,
      ),
      workEmails.length > 0
        ? supabase
            .from('active_employees')
            .select('"Name","Work Email"')
            .or(workEmails.map((e) => `"Work Email".ilike.${e}`).join(','))
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (activeRes.error) {
      return NextResponse.json(
        { error: `Active-roster check failed — refusing to search without the recycled-email warning: ${activeRes.error.message}` },
        { status: 500 },
      );
    }
    const activeByEmail = new Map<string, string>();
    for (const r of (activeRes.data ?? []) as Record<string, unknown>[]) {
      const e = normEmail(String(r['Work Email'] ?? ''));
      if (e) activeByEmail.set(e, String(r['Name'] ?? '').trim());
    }

    const readSnapshotRows = (workEmail: string): Record<string, unknown>[] | null => {
      const raw = rawSnapshots[offboardSnapshotKey(workEmail)];
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as OffboardSnapshot;
        return parsed && parsed.v === 1 ? parsed.employee_ids ?? [] : null;
      } catch {
        return null;
      }
    };

    const rows: OffboardedSearchRow[] = matched.map((hit) => {
      const email = normEmail(hit.workEmail ?? '');
      const idRow = email ? (idsByEmail[email] as unknown as Record<string, unknown> | undefined) : undefined;
      const legacy = email ? legacyByEmail[email] : null;
      const folded = foldBankStatus({
        idRow: idRow ?? null,
        extras: legacy != null ? { bankPreferredRaw: legacy } : undefined,
        snapshotIdRows: email ? readSnapshotRows(email) : null,
      });
      return {
        ...hit,
        ...folded,
        activeHolder: email ? activeByEmail.get(email) ?? null : null,
      };
    });

    return NextResponse.json({ rows, total });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
