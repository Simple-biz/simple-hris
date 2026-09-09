import { NextResponse } from 'next/server';
import {
  fetchAuditLog,
  insertAuditLog,
  purgeAuditLogBefore,
  countAuditLogBefore,
  AUDIT_PURGE_MIN_AGE_DAYS,
} from '@/lib/supabase/audit-log';
import type { AuditLogEntry, NewAuditLog } from '@/lib/supabase/audit-log';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { auditFrom, clientIp } from '@/lib/audit/context';
import { familiesForSurface, AUDIT_SURFACES, type AuditSurface } from '@/lib/audit/registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Free-text search cannot go into SQL (details keys vary per action), so it
 *  filters a WIDER server-side window in JS. The window is reported back to the
 *  client so "no results" is never mistaken for "never happened". */
const SEARCH_WINDOW = 2000;

const SURFACE_IDS = new Set<string>(AUDIT_SURFACES.map((s) => s.id));

function isSurface(value: string): value is AuditSurface {
  return SURFACE_IDS.has(value);
}

/** The action prefixes belonging to one dashboard, as a filter string. */
function prefixesForSurface(surface: AuditSurface): string {
  return familiesForSurface(surface)
    .map((f) => f.match)
    .join(',');
}

function matchesSearch(entry: AuditLogEntry, needle: string): boolean {
  const hay = [
    entry.action,
    entry.resource,
    entry.resource_id ?? '',
    entry.user_name,
    entry.user_role,
    entry.details ? JSON.stringify(entry.details) : '',
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(needle);
}

// ─── GET /api/audit-log ───────────────────────────────────────────────────────
// One page of the trail, filtered server-side. Query params:
//   surface        one of AUDIT_SURFACES ids — expands to that dashboard's
//                  action prefixes via the registry
//   action_prefix  comma-separated prefixes (wins over `surface`)
//   actor          exact for an email, contains-match otherwise
//   search         free text across action/resource/actor/details
//   since, until   YYYY-MM-DD, Asia/Manila days
//   before         keyset cursor (a previous page's next_cursor)
//   limit          1-500, default 100

export async function GET(request: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const { searchParams } = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') ?? '100', 10) || 100, 1), 500);
  const search = (searchParams.get('search') ?? '').trim().toLowerCase();

  const surfaceParam = (searchParams.get('surface') ?? '').trim().toLowerCase();
  const explicitPrefix = (searchParams.get('action_prefix') ?? '').trim();
  const actionPrefix =
    explicitPrefix ||
    (surfaceParam && surfaceParam !== 'all' && isSurface(surfaceParam)
      ? prefixesForSurface(surfaceParam)
      : '');

  try {
    const page = await fetchAuditLog({
      actionPrefix,
      actor: searchParams.get('actor'),
      since: searchParams.get('since'),
      until: searchParams.get('until'),
      before: searchParams.get('before'),
      // A free-text pass needs a wider window than the page it returns.
      limit: search ? SEARCH_WINDOW : limit,
    });
    if (page.error) {
      return NextResponse.json({ rows: [], error: page.error }, { status: 500 });
    }

    if (!search) {
      return NextResponse.json({
        rows: page.rows,
        next_cursor: page.nextCursor,
        has_more: page.hasMore,
        scanned: page.rows.length,
        search_window: null,
        error: null,
      });
    }

    const hits = page.rows.filter((r) => matchesSearch(r, search));
    return NextResponse.json({
      rows: hits.slice(0, limit),
      // Paging a JS-filtered set by cursor would skip matches, so a searching
      // client gets one window and is told exactly how far it reached.
      next_cursor: null,
      has_more: hits.length > limit,
      scanned: page.rows.length,
      search_window: page.hasMore
        ? {
            complete: false,
            events_scanned: page.rows.length,
            oldest_scanned: page.rows[page.rows.length - 1]?.created_at ?? null,
            note: `Searched the newest ${page.rows.length} events matching the other filters. Older matches exist — narrow by dashboard, actor or date range to reach them.`,
          }
        : { complete: true, events_scanned: page.rows.length, oldest_scanned: null, note: null },
      error: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg }, { status: 500 });
  }
}

// ─── POST /api/audit-log ─────────────────────────────────────────────────────
// Writes a new audit log entry. Called by the client after any settings change.

export async function POST(request: Request) {
  try {
    // Actor identity always comes from the verified session, never the body --
    // otherwise the log can be poisoned with forged user_name/user_role.
    const actor = await getSessionActor();
    if (actor.user_name === 'anonymous') {
      return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    }

    const body = (await request.json()) as Partial<NewAuditLog>;

    if (!body.action || !body.resource) {
      return NextResponse.json({ error: 'Missing required fields: action, resource' }, { status: 400 });
    }

    const { error } = await insertAuditLog({
      user_name:   actor.user_name,
      user_role:   actor.user_role,
      action:      body.action,
      resource:    body.resource,
      resource_id: body.resource_id ?? null,
      details:     body.details ?? null,
      ip_address:  clientIp(request),
    });

    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── DELETE /api/audit-log ───────────────────────────────────────────────────
// Retention purge — deletes events OLDER THAN `older_than_days` (minimum
// AUDIT_PURGE_MIN_AGE_DAYS). Pass `preview=1` to count without deleting.
//
// This replaced a wholesale "clear the log" that left no trace of itself. The
// `audit.purged` event is written BEFORE the delete and the purge is abandoned
// if that write fails, so a pruned window always has a row above it naming who
// pruned it, from where, and how many events went.

export async function DELETE(request: Request) {
  try {
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);
    if (!authz.roles?.includes('admin')) {
      return NextResponse.json({ error: 'Admin role required' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const preview = searchParams.get('preview') === '1';
    const days = parseInt(searchParams.get('older_than_days') ?? '', 10);
    if (!Number.isFinite(days)) {
      return NextResponse.json(
        { error: 'older_than_days is required (an integer number of days)' },
        { status: 400 },
      );
    }
    if (days < AUDIT_PURGE_MIN_AGE_DAYS) {
      return NextResponse.json(
        {
          error: `Refusing to purge events newer than ${AUDIT_PURGE_MIN_AGE_DAYS} days (asked for ${days}).`,
        },
        { status: 400 },
      );
    }

    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

    const { count, error: countError } = await countAuditLogBefore(cutoff);
    if (countError) return NextResponse.json({ error: countError }, { status: 500 });

    if (preview) {
      return NextResponse.json({ preview: true, cutoff, matching: count, error: null });
    }
    if (count === 0) {
      return NextResponse.json({ deleted: 0, cutoff, error: null });
    }

    // Audit first. If the trail cannot record the pruning, nothing is pruned.
    const { error: auditError } = await insertAuditLog({
      ...auditFrom(request, authz),
      action: 'audit.purged',
      resource: 'audit_log',
      resource_id: null,
      details: { cutoff, older_than_days: days, matching: count },
    });
    if (auditError) {
      return NextResponse.json(
        { error: `Purge abandoned — the audit event could not be written: ${auditError}` },
        { status: 500 },
      );
    }

    const { deleted, error } = await purgeAuditLogBefore(cutoff);
    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ deleted, cutoff, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
