import { NextRequest, NextResponse } from 'next/server';
import { fetchAuditLog } from '@/lib/supabase/audit-log';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireRateVisibilityOrFeatureEdit } from '@/lib/auth/authorize-feature';
import { isMoneyUndo, toUndoHistoryEntry } from '@/lib/payroll/undo-history';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/payment-dispatches/undo-history
 *
 * The record of every Undo pressed on Payment Dispatch — what the press
 * removed, who pressed it, and when. Undo DELETES the `payment_dispatches` row,
 * so these `payment.undone` audit events are the only surviving copy of the
 * payments they describe.
 *
 * Query params: `actor`, `since`, `until` (YYYY-MM-DD, Asia/Manila), `search`,
 * `before` (keyset cursor), `limit` (1-200).
 *
 * **Gate.** `requireRateVisibilityOrFeatureEdit('accounting','payment_dispatch')`
 * — the same gate `/api/payroll-wizard/audit` uses and the same feature the undo
 * WRITE requires, so anyone who can press Undo can read what they pressed
 * (Kane, 2026-09-12: "anyone who operates the payment dispatch"). Deliberately
 * NOT `requireElevatedSession()` like `/api/audit-log`: that would let a clerk
 * undo a payment and then be unable to see her own correction.
 *
 * **Paging.** Keyset via `fetchAuditLog`'s `before` cursor — never `.range()`,
 * which PostgREST truncates at 1000 ([[postgrest-1000-cap-sweep]]).
 *
 * **Honesty about the filter.** Marker clears and free-text search are filtered
 * in JS over each fetched page, so a page can return fewer rows than it
 * scanned. The response says so (`scanned`, `filtered_out`) rather than letting
 * a short page read as "that's all there is".
 */
export async function GET(req: NextRequest) {
  const authz = await requireRateVisibilityOrFeatureEdit('accounting', 'payment_dispatch');
  if (!authz.ok) return deniedResponse(authz);

  const sp = req.nextUrl.searchParams;
  const limit = Math.min(Math.max(parseInt(sp.get('limit') ?? '50', 10) || 50, 1), 200);
  const search = (sp.get('search') ?? '').trim().toLowerCase();

  // Over-fetch so a page that loses rows to the marker-clear filter still tends
  // to fill. The cursor below always comes from the LAST SCANNED row, never the
  // last kept one, so over-fetching can never skip an event.
  const scanLimit = Math.min(limit * 3, 500);

  const page = await fetchAuditLog({
    actionPrefix: 'payment.undone',
    actor: sp.get('actor'),
    since: sp.get('since'),
    until: sp.get('until'),
    before: sp.get('before'),
    limit: scanLimit,
  });
  if (page.error) {
    return NextResponse.json({ entries: [], error: page.error }, { status: 500 });
  }

  // `actionPrefix` is a prefix match, so `payment.undone_something` would also
  // come back. Pin it exactly — the family is shared with payment.dispatched.
  const undone = page.rows.filter((r) => r.action === 'payment.undone');

  const kept = undone.filter((r) => isMoneyUndo(r.details));
  let entries = kept.map(toUndoHistoryEntry);

  if (search) {
    entries = entries.filter((e) =>
      [
        e.recipientEmail,
        e.recipientName,
        e.processor,
        e.transactionId,
        e.bankUsed,
        e.actor,
        e.dispatchId,
        e.note,
        e.cycleSourceFile,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(search),
    );
  }

  const trimmed = entries.slice(0, limit);

  // The cursor is the oldest row SCANNED on this page, not the oldest kept —
  // otherwise the rows filtered out below the last kept row would be scanned
  // again forever, or (worse) skipped.
  const oldestScanned = page.rows[page.rows.length - 1]?.created_at ?? null;
  const hasMore = page.hasMore || entries.length > limit;

  return NextResponse.json({
    entries: trimmed,
    next_cursor: hasMore ? oldestScanned : null,
    has_more: hasMore,
    scanned: page.rows.length,
    // How many events this page deliberately withheld, and why — so a thin page
    // is explicable rather than suspicious.
    filtered_out: {
      marker_clears: undone.length - kept.length,
      search_misses: search ? kept.length - entries.length : 0,
    },
    error: null,
  });
}
