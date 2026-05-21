'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Megaphone, Pin, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import type { AnnouncementRow } from '@/lib/supabase/announcements';

interface AnnouncementWallProps {
  /**
   * How to filter announcements fetched and received via Realtime.
   * - 'all'         -> no filter (admin / CEO)
   * - 'general'     -> general scope only
   * - string[]      -> general + those departments
   */
  scope: 'all' | 'general' | string[];
  /** The session email -- used to show delete button on own posts. */
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

/**
 * A stable string identity for a scope value. Array scopes are recreated on
 * every parent render (e.g. `department ? [department] : []`), so depending on
 * the array reference re-ran the fetch + Realtime subscription on every
 * re-render -- flashing the loading skeleton roughly every 30s as the shell
 * re-rendered. Keying effects off this content hash fixes that.
 */
function scopeKeyOf(scope: AnnouncementWallProps['scope']): string {
  if (scope === 'all') return 'all';
  if (scope === 'general') return 'general';
  return [...scope].sort().join('|');
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

/**
 * Author avatar: roster photo with a neutral monogram fallback. The initial
 * fetch carries a resolved `author_photo_url` (string or null). Realtime
 * inserts leave it `undefined`, so we resolve via the photo-redirect endpoint
 * there and let onError drop to initials.
 */
function AuthorAvatar({ row }: { row: AnnouncementRow }) {
  const [broken, setBroken] = useState(false);

  const src =
    row.author_photo_url !== undefined
      ? row.author_photo_url // known: string URL, or null (no photo)
      : `/api/employee-profile-photo?email=${encodeURIComponent(row.author_email)}&_fmt=img`;

  const monogram = (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-[11px] font-semibold tracking-wide text-zinc-600 ring-1 ring-inset ring-zinc-200/70 dark:bg-zinc-800/80 dark:text-zinc-300 dark:ring-zinc-700/70">
      {authorInitials(row)}
    </div>
  );

  if (!src || broken) return monogram;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- Supabase / Google avatar URL
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className="h-9 w-9 shrink-0 rounded-lg object-cover ring-1 ring-inset ring-zinc-200/70 dark:ring-zinc-700/70"
    />
  );
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

  // Latest scope, read inside callbacks/Realtime handlers without forcing them
  // to re-create on every render. Effects key off `scopeKey` (content) instead.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const scopeKey = scopeKeyOf(scope);

  const normalizedEmail = (viewerEmail ?? '').trim().toLowerCase();

  // Fetch. `silent` keeps the existing list on screen instead of swapping it for
  // the skeleton -- so a refresh never makes the feed vanish.
  const fetchAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/announcements${buildQueryString(scopeRef.current)}`, {
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
  }, []);

  // Initial load + refetch only when the *content* of scope changes.
  useEffect(() => {
    void fetchAll();
  }, [fetchAll, scopeKey]);

  // Realtime subscription -- resubscribes only when scope content changes.
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
          const sc = scopeRef.current;

          const visible =
            sc === 'all' ||
            row.scope === 'general' ||
            (Array.isArray(sc) && row.department != null && sc.includes(row.department));

          if (!visible) return;

          setItems((prev) => {
            if (prev.some((p) => p.id === row.id)) return prev;
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
              .map((p) =>
                p.id === updated.id
                  // Keep the server-resolved name + photo; the raw row lacks them.
                  ? { ...updated, author_name: p.author_name, author_photo_url: p.author_photo_url }
                  : p,
              )
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
  }, [scopeKey]);

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
      <div className={cn('flex flex-col gap-2.5', className)}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex gap-3 rounded-xl border border-zinc-200/70 bg-white p-4 dark:border-zinc-800/80 dark:bg-zinc-900/40"
          >
            <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
            <div className="flex-1 space-y-2.5 py-0.5">
              <div className="h-2.5 w-32 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
              <div className="h-3.5 w-2/3 animate-pulse rounded bg-zinc-200/80 dark:bg-zinc-800" style={{ animationDelay: `${i * 90}ms` }} />
              <div className="h-2.5 w-full animate-pulse rounded bg-zinc-100 dark:bg-zinc-800/70" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn('rounded-xl border border-rose-200 bg-rose-50/70 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300', className)}>
        {error}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-zinc-200 py-20 text-center dark:border-zinc-800', className)}>
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-zinc-50 text-zinc-300 ring-1 ring-inset ring-zinc-200/70 dark:bg-zinc-900 dark:text-zinc-600 dark:ring-zinc-800">
          <Megaphone className="h-5 w-5" strokeWidth={1.5} />
        </div>
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Nothing here yet</p>
          <p className="text-xs text-zinc-400 dark:text-zinc-600">New announcements from your team will appear here.</p>
        </div>
      </div>
    );
  }

  return (
    // Scrollable feed: pinned-first then newest (ordering comes from the API +
    // realtime handlers). Caps height so the page doesn't grow unbounded as
    // posts pile up — the list scrolls internally instead. Viewport-relative
    // max-height keeps it usable on small screens; `pr-1` gives the thin global
    // scrollbar room so cards aren't flush against it.
    <div
      className={cn(
        'flex max-h-[60vh] flex-col gap-2.5 overflow-y-auto overscroll-contain pr-1 sm:max-h-[68vh]',
        className,
      )}
      style={{ scrollbarGutter: 'stable' }}
    >
      {items.map((row, index) => {
        const canDelete = isElevated || row.author_email.toLowerCase() === normalizedEmail;
        const canPin = isElevated;
        const isGeneral = row.scope === 'general';

        return (
          <motion.article
            key={row.id}
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32, delay: Math.min(index * 0.04, 0.28), ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              'group relative overflow-hidden rounded-xl border transition-colors duration-200',
              row.pinned
                ? 'border-zinc-300/80 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-900/50'
                : 'border-zinc-200/70 bg-white hover:border-zinc-300 dark:border-zinc-800/80 dark:bg-zinc-900/40 dark:hover:border-zinc-700',
            )}
          >
            {/* Left accent rail for pinned posts — neutral, not a color wash */}
            {row.pinned && (
              <span className="absolute inset-y-0 left-0 w-[2px] bg-zinc-700 dark:bg-zinc-300" aria-hidden />
            )}

            <div className="flex gap-3.5 p-4">
              {/* Author avatar */}
              <AuthorAvatar row={row} />

              <div className="min-w-0 flex-1">
                {/* Meta row */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="truncate text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
                      {row.author_name ?? row.author_email}
                    </span>
                    <span className="h-0.5 w-0.5 rounded-full bg-zinc-300 dark:bg-zinc-700" aria-hidden />
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.13em] text-zinc-400 dark:text-zinc-500">
                      <span
                        className={cn(
                          'h-1.5 w-1.5 rounded-full',
                          isGeneral ? 'bg-amber-500' : 'bg-sky-500',
                        )}
                        aria-hidden
                      />
                      {scopeLabel(row)}
                    </span>
                    {row.pinned && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.13em] text-zinc-500 dark:text-zinc-400">
                        <Pin className="h-2.5 w-2.5" strokeWidth={2.5} />
                        Pinned
                      </span>
                    )}
                  </div>

                  {/* Actions */}
                  {(canPin || canDelete) && (
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
                      {canPin && (
                        <button
                          type="button"
                          onClick={() => handleTogglePin(row)}
                          title={row.pinned ? 'Unpin' : 'Pin to top'}
                          className={cn(
                            'rounded-md p-1.5 transition-colors',
                            row.pinned
                              ? 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
                              : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300',
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
                          className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-rose-50 hover:text-rose-600 dark:text-zinc-500 dark:hover:bg-rose-500/15 dark:hover:text-rose-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Timestamp */}
                <p className="mt-0.5 text-[11px] text-zinc-400 dark:text-zinc-600">
                  {timeAgo(row.created_at)}
                </p>

                {/* Content */}
                <h3 className="mt-2.5 text-[15px] font-semibold leading-snug tracking-tight text-zinc-900 dark:text-white">
                  {row.title}
                </h3>
                <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {row.body}
                </p>
              </div>
            </div>
          </motion.article>
        );
      })}
    </div>
  );
}
