'use client';

/**
 * UndoHistoryPanel — the record of every Undo pressed on Payment Dispatch.
 *
 * Undo DELETES the `payment_dispatches` row, so the `payment.undone` audit
 * events this reads are the ONLY surviving copy of the payments they describe.
 * Everything shown here is the snapshot taken at delete time; nothing is
 * re-derived, and no amount is recomputed.
 *
 * Four rules the next person will otherwise break:
 *
 *  1. **A row whose kind is `unrecorded` must never render as a payment.** 59
 *     live events (2026-06-08 → 2026-07-29) carry only `{count, ids}`. Rendering
 *     them through the payment branch prints "— paid —" to nobody, which reads
 *     as a ₱0 payment rather than as missing information.
 *  2. **A script actor is not a button press.** 82 live events were written by
 *     `kaner@simple.biz (dedupe-payment-dispatches)`. The script tag is shown
 *     separately so a bulk cleanup never reads as somebody clicking Undo.
 *  3. **A `duplicate_cleanup` never says "back in the pending queue".** The
 *     dedupe script deleted a duplicate echo row and the original survived, so
 *     the payment STANDS. It carries `original_status: 'paid'`, so the payment
 *     branch would otherwise claim 82 people were un-paid. None were.
 *  4. **The footer count is what was LOADED, never a total.** Marker clears are
 *     filtered out server-side and the trail is keyset-paged, so a count here
 *     posing as a total is the same "window as history" bug fixed twice before
 *     (memory/penny-audit-log-visibility.md).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarDays,
  FileQuestion,
  Layers,
  Loader2,
  RotateCcw,
  Search,
  Terminal,
  Undo2,
  User as UserIcon,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { formatCOP, formatPHP, formatUSD, PROCESSORS } from './mock-queue';
import type { UndoHistoryEntry, UndoKind } from '@/lib/payroll/undo-history';

const PAGE_SIZE = 25;

type ApiResponse = {
  entries: UndoHistoryEntry[];
  next_cursor: string | null;
  has_more: boolean;
  scanned: number;
  filtered_out: { marker_clears: number; search_misses: number };
  error: string | null;
};

const KIND_PRESENTATION: Record<UndoKind, { label: string; tone: string }> = {
  payment: {
    label: 'Payment undone',
    tone: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/30',
  },
  marker_clear: {
    label: 'Marker cleared',
    tone: 'bg-zinc-50 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700',
  },
  no_op: {
    label: 'Nothing to undo',
    tone: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30',
  },
  duplicate_cleanup: {
    label: 'Duplicate removed',
    tone: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:border-violet-500/30',
  },
  unrecorded: {
    label: 'Detail not kept',
    tone: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-300 dark:border-slate-500/30',
  },
};

/** Absolute Manila time — the trail is read across timezones, so it is pinned. */
function formatAbsolute(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-PH', {
      timeZone: 'Asia/Manila',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return '';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 31) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function processorLabel(id: string | null): string | null {
  if (!id) return null;
  return PROCESSORS.find((p) => p.id === id)?.label ?? id;
}

/** Every currency the snapshot actually carried — never a converted figure. */
function moneyParts(entry: UndoHistoryEntry): string[] {
  const out: string[] = [];
  if (entry.amountPhp != null) out.push(formatPHP(entry.amountPhp));
  if (entry.amountUsd != null) out.push(formatUSD(entry.amountUsd));
  if (entry.amountCop != null) out.push(formatCOP(entry.amountCop));
  return out;
}

function EntryCard({ entry }: { entry: UndoHistoryEntry }) {
  const meta = KIND_PRESENTATION[entry.kind];
  const who = entry.recipientName ?? entry.recipientEmail;
  const money = moneyParts(entry);
  const proc = processorLabel(entry.processor);
  // Kinds with no payment to name. A duplicate_cleanup is NOT thin — it has a
  // real recipient and amount; only its consequence differs.
  const isThin = entry.kind === 'unrecorded' || entry.kind === 'no_op';

  return (
    <li className="flex gap-3 px-4 py-3">
      <div
        className={cn(
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border',
          entry.kind === 'payment'
            ? 'border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300'
            : 'border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400',
        )}
      >
        {entry.kind === 'duplicate_cleanup' ? (
          <Layers className="h-3.5 w-3.5" />
        ) : entry.kind === 'no_op' ? (
          <AlertTriangle className="h-3.5 w-3.5" />
        ) : entry.kind === 'unrecorded' ? (
          <FileQuestion className="h-3.5 w-3.5" />
        ) : (
          <Undo2 className="h-3.5 w-3.5" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cn(
              'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
              meta.tone,
            )}
          >
            {meta.label}
          </span>

          {/* The thin kinds have no payment to name — say what is missing. */}
          {isThin ? (
            <span className="text-[12px] text-zinc-500 dark:text-zinc-400">
              {entry.kind === 'no_op'
                ? 'the records were already gone — nothing changed'
                : 'undone before the full record was kept'}
            </span>
          ) : (
            <span className="truncate text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">
              {who ?? 'Unnamed recipient'}
            </span>
          )}

          {money.length > 0 && (
            <span className="font-mono text-[12px] font-semibold tabular-nums text-rose-700 dark:text-rose-300">
              {money.join(' · ')}
            </span>
          )}
          {proc && (
            <span className="rounded border border-zinc-200 px-1 py-px text-[10px] font-medium text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
              {proc}
            </span>
          )}
        </div>

        {/* What it reverted to, plus the identifiers that make it findable. */}
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
          {entry.kind === 'payment' && (
            <span>
              removed from paid → back in the pending queue
              {entry.urgent && !entry.urgent.revived ? ' (source request NOT restored)' : ''}
            </span>
          )}
          {/* A dedupe cleanup deleted a DUPLICATE row; the oldest row survived
              and still marks the payment. Saying "back in the pending queue"
              here would claim 82 people were un-paid when none were. */}
          {entry.kind === 'duplicate_cleanup' && (
            <span>
              duplicate row removed — the original payment stands
              {entry.keptDispatchId ? (
                <span className="font-mono"> (kept {entry.keptDispatchId.slice(0, 8)})</span>
              ) : null}
            </span>
          )}
          {entry.recipientEmail && who !== entry.recipientEmail && (
            <span className="truncate">{entry.recipientEmail}</span>
          )}
          {entry.transactionId && (
            <span className="font-mono">txn {entry.transactionId}</span>
          )}
          {entry.bankUsed && <span>via {entry.bankUsed}</span>}
          {entry.sentDate && <span>sent {entry.sentDate}</span>}
          {entry.originallyPaidBy && (
            <span>
              originally paid by{' '}
              <span className="font-medium text-zinc-600 dark:text-zinc-300">
                {entry.originallyPaidBy}
              </span>
            </span>
          )}
          {entry.urgent?.warning && (
            <span className="text-amber-700 dark:text-amber-400">{entry.urgent.warning}</span>
          )}
          {entry.kind === 'unrecorded' && entry.dispatchId && (
            <span className="font-mono">dispatch {entry.dispatchId}</span>
          )}
        </div>

        {/* Who + when. The timestamp is the point of the panel, so it is never
            only relative — "3d ago" cannot be quoted in a dispute. */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
          <span className="inline-flex items-center gap-1 font-medium text-zinc-700 dark:text-zinc-300">
            <UserIcon className="h-3 w-3" />
            {entry.actorEmail || 'unknown'}
          </span>
          {entry.actorScript && (
            <span
              className="inline-flex items-center gap-1 rounded border border-violet-200 bg-violet-50 px-1 py-px text-[10px] font-semibold text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300"
              title="Written by a script run, not by someone pressing Undo"
            >
              <Terminal className="h-2.5 w-2.5" />
              {entry.actorScript}
            </span>
          )}
          <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
            {formatAbsolute(entry.at)}
          </span>
          <span className="text-zinc-400 dark:text-zinc-500">({formatRelative(entry.at)})</span>
          {entry.batch && entry.batch.requested > 1 && (
            <span className="rounded bg-zinc-100 px-1 py-px text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              part of {entry.batch.deleted} undone together
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

export default function UndoHistoryPanel({ className }: { className?: string }) {
  const [entries, setEntries] = useState<UndoHistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [markerClears, setMarkerClears] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [actor, setActor] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');

  // Guards against an out-of-order response overwriting a newer one when the
  // filters are changed quickly.
  const reqId = useRef(0);

  const buildQuery = useCallback(
    (before: string | null) => {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (search.trim()) qs.set('search', search.trim());
      if (actor.trim()) qs.set('actor', actor.trim());
      if (since) qs.set('since', since);
      if (until) qs.set('until', until);
      if (before) qs.set('before', before);
      return qs.toString();
    },
    [search, actor, since, until],
  );

  const load = useCallback(async () => {
    const mine = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/payment-dispatches/undo-history?${buildQuery(null)}`, {
        cache: 'no-store',
      });
      const json = (await res.json()) as ApiResponse;
      if (mine !== reqId.current) return;
      if (!res.ok || json.error) throw new Error(json.error ?? 'Could not load the undo history');
      setEntries(json.entries);
      setCursor(json.next_cursor);
      setHasMore(json.has_more);
      setMarkerClears(json.filtered_out?.marker_clears ?? 0);
    } catch (e) {
      if (mine !== reqId.current) return;
      setError(e instanceof Error ? e.message : 'Could not load the undo history');
      setEntries([]);
      setHasMore(false);
    } finally {
      if (mine === reqId.current) setLoading(false);
    }
  }, [buildQuery]);

  // Debounced so typing in search does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/payment-dispatches/undo-history?${buildQuery(cursor)}`, {
        cache: 'no-store',
      });
      const json = (await res.json()) as ApiResponse;
      if (!res.ok || json.error) throw new Error(json.error ?? 'Could not load more');
      setEntries((prev) => {
        // The keyset cursor is the oldest SCANNED row, so a page can legitimately
        // re-deliver a row already held. De-dupe on the audit event id.
        const seen = new Set(prev.map((e) => e.id));
        return [...prev, ...json.entries.filter((e) => !seen.has(e.id))];
      });
      setCursor(json.next_cursor);
      setHasMore(json.has_more);
      setMarkerClears((n) => n + (json.filtered_out?.marker_clears ?? 0));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load more');
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, buildQuery]);

  const hasFilters = Boolean(search.trim() || actor.trim() || since || until);
  const clearFilters = () => {
    setSearch('');
    setActor('');
    setSince('');
    setUntil('');
  };

  const undoneCount = useMemo(
    () => entries.filter((e) => e.kind === 'payment').length,
    [entries],
  );

  return (
    <section
      className={cn(
        'flex min-h-0 flex-col rounded-2xl border border-rose-200/70 bg-gradient-to-br from-rose-50/40 to-white dark:border-rose-500/20 dark:from-rose-500/5 dark:to-zinc-950',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rose-100/80 px-4 py-2.5 dark:border-rose-500/10">
        <h2 className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-rose-800 dark:text-rose-300">
          <RotateCcw className="h-3.5 w-3.5" />
          Undo history
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-rose-500" />}
        </h2>
        <p className="text-[10px] text-rose-800/70 dark:text-rose-300/70">
          Every Undo pressed here — what it removed, who pressed it, when.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <div className="relative min-w-[180px] flex-1">
          <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center">
            <Search className="h-3.5 w-3.5 text-rose-500/60 dark:text-rose-400/50" />
          </span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search recipient, txn id, processor…"
            className="w-full rounded-lg border border-rose-200/80 bg-white/90 py-1.5 pl-7 pr-2.5 text-[12px] placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-rose-400/60 dark:border-rose-500/20 dark:bg-zinc-950/60 dark:placeholder:text-zinc-600"
          />
        </div>
        <input
          type="text"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          placeholder="Who pressed it"
          className="w-[150px] rounded-lg border border-rose-200/80 bg-white/90 px-2.5 py-1.5 text-[12px] placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-rose-400/60 dark:border-rose-500/20 dark:bg-zinc-950/60 dark:placeholder:text-zinc-600"
        />
        <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          <CalendarDays className="h-3.5 w-3.5" />
          <input
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="rounded-lg border border-rose-200/80 bg-white/90 px-2 py-1.5 text-[12px] dark:border-rose-500/20 dark:bg-zinc-950/60"
          />
          <span>→</span>
          <input
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="rounded-lg border border-rose-200/80 bg-white/90 px-2 py-1.5 text-[12px] dark:border-rose-500/20 dark:bg-zinc-950/60"
          />
        </span>
        {hasFilters && (
          <Button
            variant="outline"
            size="sm"
            onClick={clearFilters}
            className="h-7 gap-1 px-2 text-[11px]"
          >
            <X className="h-3 w-3" />
            Clear
          </Button>
        )}
      </div>

      {error ? (
        <div className="px-4 py-6 text-center text-xs text-rose-600 dark:text-rose-400">{error}</div>
      ) : loading && entries.length === 0 ? (
        <div className="px-4 py-10 text-center text-xs text-zinc-500 dark:text-zinc-400">
          <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
          Loading the undo trail…
        </div>
      ) : entries.length === 0 ? (
        <div className="px-4 py-10 text-center text-xs text-zinc-500 dark:text-zinc-400">
          {hasFilters
            ? 'No undos match these filters.'
            : 'No payment has been undone yet.'}
        </div>
      ) : (
        <>
          <ul className="min-h-0 flex-1 divide-y divide-rose-100/70 overflow-y-auto dark:divide-rose-500/10">
            {entries.map((e) => (
              <EntryCard key={e.id} entry={e} />
            ))}
          </ul>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rose-100/80 px-4 py-2 text-[10px] text-zinc-500 dark:border-rose-500/10 dark:text-zinc-400">
            {/* "loaded", never "total" — the trail is paged and filtered. */}
            <span>
              {entries.length} loaded · {undoneCount} payment
              {undoneCount === 1 ? '' : 's'} undone
              {markerClears > 0 && <> · {markerClears} marker clear{markerClears === 1 ? '' : 's'} hidden</>}
            </span>
            {hasMore ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="h-7 gap-1.5 px-2.5 text-[11px]"
              >
                {loadingMore && <Loader2 className="h-3 w-3 animate-spin" />}
                Load older
              </Button>
            ) : (
              <span>Reached the start of the trail.</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
