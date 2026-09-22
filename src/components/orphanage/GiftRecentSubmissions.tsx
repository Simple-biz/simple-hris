'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ExternalLink,
  Link2,
  Loader2,
  MonitorSmartphone,
  RefreshCw,
  Search,
  UserCog,
  UserRound,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { milestoneLabel } from '@/lib/gift-milestones';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import type { GiftSubmissionChannel } from '@/lib/gift-tracker/gift-live';
import type { RecentSubmission, RecentSummary } from '@/lib/gift-tracker/recent-submissions';
import {
  ORPHANAGE_TAB_CACHE_KEYS as OK,
  getOrphanageTabCache,
  isOrphanageTabCacheFresh,
  setOrphanageTabCache,
} from '@/lib/orphanage/tab-cache';
import { useGiftShippingLive } from '@/hooks/useGiftShippingLive';

/**
 * Gift Tracker → "Recently filled / updated".
 *
 * Kane, 2026-09-22: *"so we can catch people that are using the link"*. Every
 * gift-address submission, newest change first, with the surface it came from —
 * the public link, the Employee dashboard card, or a staff entry. Which of the
 * three is READ from `audit_log`, never inferred; a row whose channel cannot be
 * resolved says **Unknown source** rather than picking the likely one, because
 * the count of link users is the measurement this tab exists to produce.
 *
 * Live over Broadcast with a poll floor — see `useGiftShippingLive`. The status
 * pill states which of the two is actually carrying it, so the panel never
 * claims a freshness it does not have.
 */

interface FeedResponse {
  rows: RecentSubmission[];
  summary: RecentSummary | null;
  totalSubmissions?: number;
  error: string | null;
}

const CHANNEL_META: Record<
  GiftSubmissionChannel,
  { label: string; Icon: typeof Link2; className: string }
> = {
  external_link: {
    label: 'Public link',
    Icon: Link2,
    // The one everybody is here to count, so it is the only coloured chip.
    className:
      'border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-200',
  },
  employee_self: {
    label: 'Employee dashboard',
    Icon: MonitorSmartphone,
    className:
      'border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
  },
  staff: {
    label: 'Entered by staff',
    Icon: UserCog,
    className:
      'border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
  },
};

/** Relative, because "3 minutes ago" is the question this tab answers. Falls
 *  back to the absolute stamp once it stops being news. */
function whenLabel(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

/** Rows, summary and total as ONE cached unit — see the key's doc comment. */
interface CachedFeed {
  rows: RecentSubmission[];
  summary: RecentSummary | null;
  total: number | null;
}

export default function GiftRecentSubmissions() {
  const [rows, setRows] = useState<RecentSubmission[]>([]);
  const [summary, setSummary] = useState<RecentSummary | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [linkOnly, setLinkOnly] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/gift-tracker/recent-submissions?limit=100', {
        cache: 'no-store',
      });
      const json = (await res.json()) as FeedResponse;
      if (!res.ok || json.error) throw new Error(json.error ?? 'Could not load submissions.');
      const feed: CachedFeed = {
        rows: json.rows ?? [],
        summary: json.summary ?? null,
        total: json.totalSubmissions ?? null,
      };
      setRows(feed.rows);
      setSummary(feed.summary);
      setTotal(feed.total);
      setOrphanageTabCache(OK.giftRecentSubmissions, feed);
      setError(null);
    } catch (e) {
      // The list is KEPT on a failed refresh — blanking it would turn a dropped
      // request into "nobody has submitted anything", which is the one reading
      // this tab must never produce.
      setError(e instanceof Error ? e.message : 'Could not load submissions.');
    } finally {
      setLoading(false);
      setSettled(true);
    }
  }, []);

  /**
   * Mount: paint from cache, then decide whether the network is needed at all.
   *
   * The cache PAINTS; it never DECIDES. A warm entry seeds the feed so coming
   * back to this tab — or to this dashboard — costs nothing, but only a FRESH
   * entry (< 30s) suppresses the fetch. Anything older revalidates silently
   * behind the rows already on screen. Collapsing those two questions into one
   * is the regression `hr-dashboard-cache.md` exists to prevent.
   */
  useEffect(() => {
    const cached = getOrphanageTabCache<CachedFeed>(OK.giftRecentSubmissions);
    if (cached) {
      setRows(cached.rows);
      setSummary(cached.summary);
      setTotal(cached.total);
      // Something to paint ⇒ no skeleton, whatever happens next.
      setLoading(false);
      setSettled(true);
    }
    if (isOrphanageTabCacheFresh(OK.giftRecentSubmissions)) return;
    void load();
  }, [load]);

  const liveStatus = useGiftShippingLive({ onChange: () => void load() });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = rows;
    if (linkOnly) out = out.filter((r) => r.channel === 'external_link');
    if (q) {
      out = out.filter((r) =>
        [r.name, r.workEmail, r.personalEmail, r.department, r.address, r.alternateRecipient]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      );
    }
    return out;
  }, [rows, search, linkOnly]);

  // Mandatory once a poll exists: a spinner that returns on every lap flashes
  // the list every 20 seconds.
  const showSpinner = loading && !settled;

  return (
    <Card className="border-emerald-100/80 dark:border-emerald-950/45">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            Recently filled / updated
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                liveStatus === 'live'
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
                  : 'border-zinc-300 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400',
              )}
              title={
                liveStatus === 'live'
                  ? 'Updates arrive the moment somebody submits.'
                  : 'The live channel is not connected — refreshing on a timer instead.'
              }
            >
              {liveStatus === 'live' ? 'Live' : liveStatus === 'connecting' ? 'Connecting' : 'Polling'}
            </span>
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            className="h-8 gap-1.5 text-xs"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Who has given us a delivery address lately, and which door they came through.
          {total !== null && rows.length < total && (
            <> Showing the newest {rows.length} of {total}.</>
          )}
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {summary && (
          /* Each tile is its own question. They are NEVER summed — a submission
             is both "from the link" and "an update", so a total would count it
             twice. Same rule the fulfilment tiles follow on the roster tab. */
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile label="From the public link" value={summary.externalLink} accent />
            <Tile label="First time filled" value={summary.filled} />
            <Tile label="Updated since" value={summary.updated} />
            <Tile label="Unknown source" value={summary.unknownChannel} />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, email, department, address…"
              className="h-9 pl-8 text-sm"
            />
          </div>
          <button
            type="button"
            onClick={() => setLinkOnly((v) => !v)}
            aria-pressed={linkOnly}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors',
              linkOnly
                ? 'border-violet-600 bg-violet-600 text-white'
                : 'border-violet-200 text-violet-700 hover:bg-violet-50 dark:border-violet-900/60 dark:text-violet-300 dark:hover:bg-violet-950/40',
            )}
          >
            <Link2 className="h-3.5 w-3.5" />
            Public link only
          </button>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-50/70 p-2.5 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/25 dark:text-amber-100">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {error} Showing the last list that loaded — it may be out of date.
            </span>
          </div>
        )}

        {showSpinner ? (
          <div className="flex items-center justify-center py-10 text-zinc-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading submissions…
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
            {rows.length === 0
              ? 'Nobody has filled in a gift address yet.'
              : 'No submission matches that filter.'}
          </p>
        ) : (
          <ul className="divide-y divide-emerald-100/70 dark:divide-emerald-950/40">
            {filtered.map((r) => (
              <FeedRow key={r.id} row={r} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Tile({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2',
        accent
          ? 'border-violet-200 bg-violet-50/60 dark:border-violet-900/50 dark:bg-violet-950/25'
          : 'border-emerald-100/80 bg-white/60 dark:border-emerald-950/45 dark:bg-zinc-950/30',
      )}
    >
      <div className="text-lg font-bold tabular-nums">{value}</div>
      <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{label}</div>
    </div>
  );
}

function FeedRow({ row }: { row: RecentSubmission }) {
  const meta = row.channel ? CHANNEL_META[row.channel] : null;
  const ChannelIcon = meta?.Icon ?? UserRound;

  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-semibold">
            {row.name ?? row.personalEmail}
          </span>
          <Badge
            variant="outline"
            className={cn(
              'gap-1 px-1.5 py-0 text-[10px] font-semibold',
              meta?.className ??
                'border-zinc-300 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400',
            )}
          >
            <ChannelIcon className="h-3 w-3" />
            {meta?.label ?? 'Unknown source'}
          </Badge>
          <Badge
            variant="outline"
            className="px-1.5 py-0 text-[10px] font-semibold text-zinc-600 dark:text-zinc-300"
          >
            {row.kind === 'filled' ? 'Filled in' : 'Updated'}
          </Badge>
          {row.offRoster && (
            /* Never hidden: an off-roster submitter is the likeliest mis-ship,
               which is why the export appends them flagged rather than dropping
               them. */
            <Badge
              variant="outline"
              className="gap-1 border-amber-300 bg-amber-50 px-1.5 py-0 text-[10px] font-semibold text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
            >
              <AlertTriangle className="h-3 w-3" />
              Off-roster
            </Badge>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
          {/* Never the raw cell: an `hsl:<sub>` value would otherwise reach a
              human as a bare slug (hsl-subdepartments.md:32). */}
          {milestoneLabel(row.milestoneIndex)} gift
          {row.department ? ` · ${formatDeptLabel(row.department)}` : ''} ·{' '}
          {row.address || 'no address given'}
        </div>
        {row.hasAlternateRecipient && (
          <div className="mt-0.5 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
            <ExternalLink className="h-3 w-3" />
            Received by: {row.alternateRecipient}
          </div>
        )}
      </div>
      <div className="shrink-0 text-right">
        <div className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
          {whenLabel(row.updatedAt)}
        </div>
        <div className="text-[11px] capitalize text-zinc-400">{row.status}</div>
      </div>
    </li>
  );
}
