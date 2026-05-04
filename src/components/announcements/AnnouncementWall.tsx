'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BellOff, Pin, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import type { AnnouncementRow } from '@/lib/supabase/announcements';

interface AnnouncementWallProps {
  /**
   * How to filter announcements fetched and received via Realtime.
   * - 'all'         → no filter (admin / CEO)
   * - 'general'     → general scope only
   * - string[]      → general + those departments
   */
  scope: 'all' | 'general' | string[];
  /** The session email — used to show delete button on own posts. */
  viewerEmail: string | null | undefined;
  /** Whether this viewer is admin or CEO (can pin + delete anyone's posts). */
  isElevated?: boolean;
  className?: string;
}

function buildQueryString(scope: AnnouncementWallProps['scope']): string {
  if (scope === 'all') return '?scope=all';
  if (scope === 'general') return '?scope=general';
  return `?department=${encodeURIComponent(scope.join(','))}`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function authorInitials(row: AnnouncementRow): string {
  if (row.author_name) {
    return row.author_name
      .split(' ')
      .slice(0, 2)
      .map((w) => w[0] ?? '')
      .join('')
      .toUpperCase();
  }
  return (row.author_email[0] ?? '?').toUpperCase();
}

function scopeLabel(row: AnnouncementRow): string {
  if (row.scope === 'department') return row.department ?? 'Dept';
  return 'General';
}

export default function AnnouncementWall({
  scope,
  viewerEmail,
  isElevated = false,
  className,
}: AnnouncementWallProps) {
  const [items, setItems] = useState<AnnouncementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const deletingRef = useRef<Set<string>>(new Set());

  const normalizedEmail = (viewerEmail ?? '').trim().toLowerCase();

  // Initial fetch
  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/announcements${buildQueryString(scope)}`, {
        cache: 'no-store',
      });
      const json = (await res.json()) as { announcements?: AnnouncementRow[]; error?: string };
      if (json.error) throw new Error(json.error);
      setItems(json.announcements ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  // Realtime subscription
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const channel = supabase
      .channel('announcements-wall')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'announcements' },
        (payload) => {
          const row = payload.new as AnnouncementRow;

          // Client-side scope filter
          const visible =
            scope === 'all' ||
            row.scope === 'general' ||
            (Array.isArray(scope) && row.department != null && scope.includes(row.department));

          if (!visible) return;

          setItems((prev) => {
            // If pinned, insert at top; else after pinned items
            if (row.pinned) return [row, ...prev];
            const firstUnpinnedIdx = prev.findIndex((p) => !p.pinned);
            if (firstUnpinnedIdx === -1) return [...prev, row];
            return [...prev.slice(0, firstUnpinnedIdx), row, ...prev.slice(firstUnpinnedIdx)];
          });
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'announcements' },
        (payload) => {
          setItems((prev) => prev.filter((p) => p.id !== payload.old.id));
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'announcements' },
        (payload) => {
          const updated = payload.new as AnnouncementRow;
          setItems((prev) =>
            prev
              .map((p) => (p.id === updated.id ? updated : p))
              .sort((a, b) => {
                if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
                return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
              }),
          );
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [scope]);

  const handleDelete = async (id: string) => {
    if (deletingRef.current.has(id)) return;
    deletingRef.current.add(id);
    try {
      const res = await fetch(`/api/announcements/${id}`, { method: 'DELETE' });
      const json = (await res.json()) as { error?: string };
      if (json.error) throw new Error(json.error);
      setItems((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      deletingRef.current.delete(id);
    }
  };

  const handleTogglePin = async (row: AnnouncementRow) => {
    try {
      const res = await fetch(`/api/announcements/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: !row.pinned }),
      });
      const json = (await res.json()) as { error?: string };
      if (json.error) throw new Error(json.error);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Pin failed');
    }
  };

  if (loading) {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-28 animate-pulse rounded-2xl border border-[#ececec] bg-white dark:border-zinc-800 dark:bg-zinc-950"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn('rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300', className)}>
        {error}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-2 py-16 text-center', className)}>
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-600">
          <BellOff className="h-6 w-6" />
        </div>
        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">No announcements yet</p>
        <p className="text-xs text-zinc-400 dark:text-zinc-600">Check back later for updates from management.</p>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {items.map((row) => {
        const canDelete = isElevated || row.author_email.toLowerCase() === normalizedEmail;
        const canPin = isElevated;
        const isGeneral = row.scope === 'general';

        return (
          <article
            key={row.id}
            className={cn(
              'group relative overflow-hidden rounded-2xl border bg-white p-4 shadow-[0_2px_12px_-6px_rgba(0,0,0,0.06)] transition-shadow hover:shadow-[0_4px_18px_-8px_rgba(0,0,0,0.10)] dark:bg-zinc-950',
              row.pinned
                ? 'border-orange-200/80 dark:border-orange-900/40'
                : 'border-[#ececec] dark:border-zinc-800',
            )}
          >
            {/* Pin stripe */}
            {row.pinned && (
              <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-orange-400 via-rose-400 to-orange-300" />
            )}

            <div className="flex items-start gap-3">
              {/* Avatar */}
              <div
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm',
                  isGeneral
                    ? 'bg-gradient-to-br from-orange-500 to-rose-500 shadow-orange-500/25'
                    : 'bg-gradient-to-br from-blue-600 to-indigo-600 shadow-blue-500/25',
                )}
              >
                {authorInitials(row)}
              </div>

              <div className="min-w-0 flex-1">
                {/* Header row */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[13px] font-semibold text-zinc-900 dark:text-white">
                        {row.author_name ?? row.author_email}
                      </span>
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.12em]',
                          isGeneral
                            ? 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900/40 dark:bg-orange-950/30 dark:text-orange-300'
                            : 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/40 dark:bg-blue-950/30 dark:text-blue-300',
                        )}
                      >
                        {scopeLabel(row)}
                      </span>
                      {row.pinned && (
                        <span className="inline-flex items-center gap-0.5 rounded-full border border-orange-200 bg-orange-50 px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.12em] text-orange-600 dark:border-orange-900/40 dark:bg-orange-950/30 dark:text-orange-300">
                          <Pin className="h-2.5 w-2.5" />
                          Pinned
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-600">
                      {timeAgo(row.created_at)}
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    {canPin && (
                      <button
                        type="button"
                        onClick={() => handleTogglePin(row)}
                        title={row.pinned ? 'Unpin' : 'Pin to top'}
                        className={cn(
                          'rounded-md p-1 transition-colors',
                          row.pinned
                            ? 'text-orange-500 hover:bg-orange-50 dark:hover:bg-orange-950/30'
                            : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:text-zinc-600 dark:hover:bg-zinc-800',
                        )}
                      >
                        <Pin className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {canDelete && (
                      <button
                        type="button"
                        onClick={() => handleDelete(row.id)}
                        title="Delete"
                        className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-rose-50 hover:text-rose-600 dark:text-zinc-600 dark:hover:bg-rose-950/30 dark:hover:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Content */}
                <h3 className="mt-2 text-[13.5px] font-semibold tracking-tight text-zinc-900 dark:text-white">
                  {row.title}
                </h3>
                <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {row.body}
                </p>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
