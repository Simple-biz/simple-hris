import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { listShippingDetails } from '@/lib/supabase/employee-gift-shipping';
import { getEmployeesForAuthorizedServerRoute } from '@/lib/supabase/employees';
import { describeAlternateRecipient } from '@/lib/gift-tracker/alternate-recipient';
import {
  buildRecentSubmissions,
  summarize,
  type ChannelEventInput,
  type RecentSubmission,
  type RosterInput,
} from '@/lib/gift-tracker/recent-submissions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Default page of the feed. The tab is a "who touched this lately" list, not an
 *  archive — the roster sub-tab and the export are where everything lives. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * The audit read is windowed by the returned rows' own span, and never wider
 * than this.
 *
 * `audit_log` is one of the largest tables here and PostgREST caps a page at
 * 1000 rows even with an explicit `.range()`, so an unbounded scan is both slow
 * and — without paging — silently truncated. A submission older than the window
 * simply reports `channel: null`, rendered as "Unknown source". That is the
 * honest outcome: this module never guesses a channel, and the alternative
 * (scanning the whole trail to colour in an eight-month-old row) costs the
 * request for information nobody is acting on.
 */
const MAX_AUDIT_WINDOW_DAYS = 120;

/** Written after the row it describes, so the window opens slightly earlier. */
const AUDIT_MARGIN_MS = 10 * 60 * 1000;

const CHANNEL_ACTIONS = ['gift_address.saved', 'employee_gift_shipping.submitted'] as const;

/**
 * GET /api/gift-tracker/recent-submissions?limit=100
 *
 * The Gift Tracker's "Recently filled / updated" sub-tab: every gift-address
 * submission, newest change first, with the surface it came from.
 *
 * Gated identically to the rest of the Gift Tracker — `hr / gift_tracker` view,
 * the same grant `GET /api/employee-gift-shipping` and the `[id]` routes
 * require. It returns home addresses and phone numbers, so it is never the
 * looser of the two.
 */
export async function GET(req: NextRequest) {
  const staff = await requireFeatureAccess('hr', 'gift_tracker', 'view');
  if (!staff.ok) {
    return NextResponse.json(
      { rows: [], summary: null, error: 'The Gift Tracker permission is required.' },
      { status: staff.status ?? 403 },
    );
  }

  const limitParam = Number(req.nextUrl.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(Math.floor(limitParam), MAX_LIMIT)
    : DEFAULT_LIMIT;

  // Already paged inside — truncation here does not shorten a list, it blanks
  // real people out of it.
  const { rows: submissions, error: subErr } = await listShippingDetails();
  if (subErr) {
    return NextResponse.json({ rows: [], summary: null, error: subErr }, { status: 500 });
  }

  const { employees, error: rosterErr } = await getEmployeesForAuthorizedServerRoute();
  if (rosterErr) {
    return NextResponse.json({ rows: [], summary: null, error: rosterErr }, { status: 500 });
  }
  const roster: RosterInput[] = employees.map((e) => ({
    work_email: e.work_email,
    personal_email: e.personal_email,
    alternate_work_email: e.alternate_work_email,
    alternate_work_email_2: e.alternate_work_email_2,
    name: e.name,
    department: e.department,
  }));

  // Shape once with no channel data so the window can be read off the page that
  // will actually be returned, rather than off the whole table.
  const ordered = buildRecentSubmissions({
    submissions,
    roster,
    events: [],
    describeRecipient: describeAlternateRecipient,
  });
  const page = ordered.slice(0, limit);

  const events = await readChannelEvents(page);
  const rows = buildRecentSubmissions({
    submissions: submissions.filter((s) => page.some((p) => p.id === s.id)),
    roster,
    events,
    describeRecipient: describeAlternateRecipient,
  });

  return NextResponse.json({
    rows,
    summary: summarize(rows),
    // So the tab can say "showing the newest 100 of 231" rather than implying
    // the list is everything.
    totalSubmissions: ordered.length,
    error: null,
  });
}

/**
 * The channel for each returned row, read out of `audit_log`.
 *
 * Both write routes already stamp it — `gift_address.saved` with
 * `channel: 'external_link'` and the work email as `resource_id`,
 * `employee_gift_shipping.submitted` with `employee_self` / `staff` and the
 * personal email. Neither is trusted to be present: a row with no event keeps
 * `channel: null`.
 */
async function readChannelEvents(page: readonly RecentSubmission[]): Promise<ChannelEventInput[]> {
  if (page.length === 0) return [];
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return [];

  const oldest = page.reduce((min, r) => {
    const t = Date.parse(r.updatedAt);
    return Number.isFinite(t) && t < min ? t : min;
  }, Number.POSITIVE_INFINITY);
  const floor = Date.now() - MAX_AUDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const sinceMs = Math.max(Number.isFinite(oldest) ? oldest - AUDIT_MARGIN_MS : floor, floor);
  const since = new Date(sinceMs).toISOString();

  const { rows, error } = await selectAllPaged<ChannelEventInput>((from, to) =>
    supabase
      .from('audit_log')
      .select('action, resource_id, created_at, details')
      .in('action', CHANNEL_ACTIONS as unknown as string[])
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
        data: ChannelEventInput[] | null;
        error: { message: string } | null;
      }>,
  );

  if (error) {
    // The feed is still worth serving without it — every row simply reads
    // "Unknown source". Failing the request would hide the submissions
    // themselves, which is the thing the tab exists to show.
    // eslint-disable-next-line no-console
    console.warn('[gift-recent] channel lookup failed; rows will report an unknown source:', error);
    return [];
  }
  return rows;
}
