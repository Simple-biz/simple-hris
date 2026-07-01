'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Search, Clock, RefreshCw, Landmark, Inbox, ShieldCheck, Eye, ChevronLeft, ChevronRight,
  CreditCard, Globe, UserPlus, PencilLine, Link2, Sparkles,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { TeamAvatar } from '@/components/team/team-ui';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { cn } from '@/lib/utils';
import type { Accent } from './PeopleTab';

/** One self-service payout change. Mirrors `BankChangeEntry` from the API. */
interface BankChange {
  id: string;
  name: string;
  email: string | null;
  fields: string[];
  processor: string | null;
  createdNew: boolean;
  via: string | null;
  ip_address: string | null;
  created_at: string;
}

// Kept literal to avoid pulling the server-only app-settings module into the
// client bundle — must match BANK_CHANGES_PULSE_KEY in src/lib/supabase/app-settings.ts.
const PULSE_KEY = 'people.bank_changes.pulse';
const POLL_INTERVAL_MS = 30_000;
const DEBOUNCE_MS = 450;
const FRESH_HIGHLIGHT_MS = 2600;
const PAGE_SIZE = 20;

const FIELD_LABELS: Record<string, string> = {
  preferred_processor: 'Payment method',
  preferred_bank_slot: 'Preferred bank',
  bank_name: 'Bank',
  account_holder_name: 'Account holder',
  account_number: 'Account number',
  routing_number: 'Routing number',
  swift_code: 'SWIFT / BIC',
  full_address: 'Address',
  phone_number: 'Phone',
  alt_bank_name: 'Alt bank',
  alt_account_holder_name: 'Alt account holder',
  alt_account_number: 'Alt account number',
  alt_routing_number: 'Alt routing',
  hurupay_email: 'Hurupay email',
  wepay_email: 'Wepay email',
  higlobe_email: 'HiGlobe email',
  higlobe_account_name: 'HiGlobe name',
  wise_email: 'Wise email',
  wise_tag: 'Wise tag',
};

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function absoluteTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('en-US') : iso;
}

/**
 * People-tab "Bank changes" feed (Accounting + CEO). A live, newest-first list of
 * self-service payout edits made via the external /update-bank-info link, sourced
 * from /api/people/bank-changes (the audit_log `bank_update.saved` events — field
 * NAMES only, never account values).
 *
 * Stays live two ways (mirrors usePaymentsLive, minus the sensitive-table channel):
 *   1. Supabase Realtime on the `people.bank_changes.pulse` app_settings key —
 *      bumped by the save route, so the feed updates the instant a change lands.
 *      Only a TIMESTAMP rides this channel; the PII (name / work email / IP) is
 *      fetched from the auth-gated /api/people/bank-changes endpoint. We
 *      deliberately do NOT subscribe to `audit_log` directly: that table carries
 *      PII, and the browser's anon Supabase client has no user JWT, so RLS can't
 *      scope it to Accounting/CEO — a direct subscription could leak audit rows
 *      to any anon websocket client.
 *   2. A 30s poll + tab-focus refetch as the always-works fallback.
 *
 * New arrivals slide in and flash an emerald highlight that fades; all motion
 * collapses under prefers-reduced-motion.
 */
export default function PeopleBankChanges({ accent }: { accent: Accent }) {
  const reduce = useReducedMotion();
  const instanceId = useId();
  const [rows, setRows] = useState<BankChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<BankChange | null>(null);

  // True once the FIRST fetch has completed (independent of row count) so the
  // first real arrivals into an initially-empty feed still flash "New".
  const hydratedRef = useRef(false);
  // Ids we've already shown — so only genuinely NEW rows flash (never the whole
  // list on first load). Cleared-fresh ids stay "seen".
  const seenRef = useRef<Set<string>>(new Set());
  const freshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetch = useCallback(async (mode: 'initial' | 'quiet') => {
    if (mode === 'quiet') setRefreshing(true);
    try {
      const res = await fetch('/api/people/bank-changes?limit=80', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: BankChange[]; error?: string };
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      const next = json.rows ?? [];

      // Flash rows we haven't seen before — but never on the very first load.
      // Keyed on hydration (not row count) so the first arrivals into an
      // initially-empty feed still flash.
      const firstLoad = !hydratedRef.current;
      if (!firstLoad) {
        const incoming = next.filter((r) => !seenRef.current.has(r.id)).map((r) => r.id);
        if (incoming.length) {
          setFreshIds((prev) => new Set([...prev, ...incoming]));
          if (freshTimer.current) clearTimeout(freshTimer.current);
          freshTimer.current = setTimeout(() => setFreshIds(new Set()), FRESH_HIGHLIGHT_MS);
        }
      }
      for (const r of next) seenRef.current.add(r.id);
      hydratedRef.current = true;

      setRows(next);
      setError(json.error ?? null);
      setLastSync(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const debouncedRefetch = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void refetch('quiet');
    }, DEBOUNCE_MS);
  }, [refetch]);

  // Initial hydration.
  useEffect(() => {
    void refetch('initial');
  }, [refetch]);

  // Realtime — subscribe ONLY to the app_settings pulse key (a timestamp, no
  // PII). The save route bumps it on every change, and app_settings reliably
  // reaches the anon client over Realtime. The PII-bearing audit_log is never
  // subscribed to directly (see the file header) — the poll + focus below cover
  // the case where this pulse channel can't bind.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const pulseChannel = supabase
      .channel(`people-bankchanges-pulse${instanceId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'app_settings', filter: `key=eq.${PULSE_KEY}` },
        () => debouncedRefetch(),
      )
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // eslint-disable-next-line no-console
          console.warn(
            `[people-bank-changes] pulse Realtime ${status}; relying on the ` +
              `${POLL_INTERVAL_MS / 1000}s poll + focus refetch.`,
            err,
          );
        }
      });

    return () => {
      void supabase.removeChannel(pulseChannel);
    };
  }, [debouncedRefetch, instanceId]);

  // Poll fallback.
  useEffect(() => {
    const id = window.setInterval(() => void refetch('quiet'), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refetch]);

  // Refetch on tab refocus.
  useEffect(() => {
    const onFocus = () => void refetch('quiet');
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refetch]);

  // Clean up timers on unmount.
  useEffect(
    () => () => {
      if (freshTimer.current) clearTimeout(freshTimer.current);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        (r.name ?? '').toLowerCase().includes(q) ||
        (r.email ?? '').toLowerCase().includes(q) ||
        (r.processor ?? '').toLowerCase().includes(q) ||
        r.fields.some((f) => fieldLabel(f).toLowerCase().includes(q)),
    );
  }, [rows, query]);

  // Reset to page 1 whenever the search changes so results never land on an
  // out-of-range page.
  useEffect(() => setPage(1), [query]);

  // Paginate — 20 per page. safePage clamps after the result set shrinks (e.g.
  // a search narrows the list while you're on a later page).
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <div className="mx-auto max-w-3xl">
      {/* Header: live status + count + manual refresh */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            <Landmark className="h-4 w-4 text-emerald-500" />
            Recent bank changes
          </h2>
          <p className="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
            <LiveDot reduce={!!reduce} /> Live · self-service payout edits via the external link
            {lastSync && (
              <span className="text-zinc-400 dark:text-zinc-600">
                · synced {timeAgo(new Date(lastSync).toISOString())}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn('rounded-full px-2.5 py-1 text-[11px] font-medium tabular-nums', accent.chipBg, accent.chipText)}>
            {rows.length} {rows.length === 1 ? 'change' : 'changes'}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 px-2.5 text-[12px]"
            onClick={() => void refetch('quiet')}
            disabled={refreshing || (loading && rows.length === 0)}
            aria-label="Refresh bank changes"
            title="Pull the latest bank changes now"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by person, email, processor, or field…"
          className={cn('pl-9', accent.ring)}
          aria-label="Search bank changes"
        />
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <FeedSkeleton />
      ) : filtered.length === 0 ? (
        <EmptyState searching={query.trim().length > 0} />
      ) : (
        // Cross-fade the page as a unit on page change (key=safePage). Within a
        // page, live arrivals just slot in and flash via ChangeCard — the list
        // itself doesn't re-animate, so the feed stays calm under live updates.
        <AnimatePresence mode="wait" initial={false}>
          <motion.ul
            key={safePage}
            initial={reduce ? false : { opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, x: -10 }}
            transition={reduce ? { duration: 0 } : { duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="space-y-2"
          >
            {pageRows.map((row) => (
              <ChangeCard
                key={row.id}
                row={row}
                fresh={freshIds.has(row.id)}
                reduce={!!reduce}
                onView={() => setDetail(row)}
              />
            ))}
          </motion.ul>
        </AnimatePresence>
      )}

      {filtered.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-zinc-500">
          <span className="tabular-nums">
            Showing {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-[12px]"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </Button>
              <span className="tabular-nums text-zinc-600 dark:text-zinc-300">
                Page {safePage} of {totalPages}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-[12px]"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
      )}

      <p className="mt-2 text-center text-[11px] text-zinc-400 dark:text-zinc-600">
        Account numbers are never shown here — open a person in the roster to review their audited details.
      </p>

      {detail && <BankChangeDetailDialog row={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

/* ── A single change row ─────────────────────────────────────────────────── */

function ChangeCard({
  row,
  fresh,
  reduce,
  onView,
}: {
  row: BankChange;
  fresh: boolean;
  reduce: boolean;
  onView: () => void;
}) {
  // Compact summary only — the full field breakdown lives behind "View".
  const changedCount = row.fields.filter((f) => f !== 'preferred_processor').length;
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onView}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onView();
          }
        }}
        className="group relative cursor-pointer overflow-hidden rounded-xl border border-zinc-200 bg-white p-3.5 shadow-sm transition-colors hover:border-emerald-300 hover:bg-emerald-50/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-emerald-800/60 dark:hover:bg-emerald-950/10"
      >
        {/* Fresh-arrival flash that fades out. */}
        {fresh && !reduce && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-xl bg-emerald-400/15 ring-1 ring-inset ring-emerald-400/50"
            initial={{ opacity: 1 }}
            animate={{ opacity: 0 }}
            transition={{ duration: 2.4, ease: 'easeOut' }}
          />
        )}
        <div className="relative flex items-center gap-3">
          <TeamAvatar name={row.name ?? ''} email={row.email} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="truncate text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
                {row.name || '—'}
              </span>
              {row.createdNew ? (
                <span className="inline-flex items-center rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
                  First-time setup
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  Updated
                </span>
              )}
              <AnimatePresence>
                {fresh && (
                  <motion.span
                    initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="inline-flex items-center rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-semibold text-white"
                  >
                    New
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
            <div className="truncate text-[11px] text-zinc-400">{row.email ?? ''}</div>

            {/* One-line summary — processor + how many fields, NOT the full list. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {row.processor && (
                <span className="inline-flex items-center rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10.5px] font-medium capitalize text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                  {row.processor}
                </span>
              )}
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                {changedCount > 0
                  ? `${changedCount} field${changedCount === 1 ? '' : 's'} updated`
                  : 'Payment method updated'}
              </span>
            </div>
          </div>

          {/* Time + a View action that opens the full breakdown. */}
          <div className="flex shrink-0 flex-col items-end gap-1.5 text-right">
            <span
              className="flex items-center gap-1 whitespace-nowrap text-[11px] text-zinc-500 dark:text-zinc-400"
              title={absoluteTime(row.created_at)}
            >
              <Clock className="h-3 w-3" /> {timeAgo(row.created_at)}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2 text-[12px]"
              onClick={(e) => {
                e.stopPropagation();
                onView();
              }}
            >
              <Eye className="h-3.5 w-3.5" /> View
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
}

/* ── "What changed" detail dialog ────────────────────────────────────────── */

function BankChangeDetailDialog({ row, onClose }: { row: BankChange; onClose: () => void }) {
  const changed = row.fields.filter((f) => f !== 'preferred_processor');
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="gap-4 overflow-hidden p-4 sm:max-w-md">
        {/* ── Hero: who + at-a-glance status, bled to the dialog edges ───────── */}
        <div className="relative -mx-4 -mt-4 overflow-hidden border-b border-emerald-100/70 bg-gradient-to-br from-emerald-50 via-white to-teal-50/40 px-5 pb-4 pt-5 dark:border-emerald-900/40 dark:from-emerald-950/40 dark:via-[#0d1117] dark:to-[#0a1628]">
          {/* Decorative watermark */}
          <Landmark
            aria-hidden
            className="pointer-events-none absolute -right-4 -top-5 h-28 w-28 rotate-12 text-emerald-500/10 dark:text-emerald-400/[0.07]"
          />

          <DialogDescription className="relative inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300/90">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              <Landmark className="h-3 w-3" />
            </span>
            Self-service payout change
          </DialogDescription>

          <div className="relative mt-3 flex items-center gap-3">
            <span className="shrink-0 rounded-full shadow-md ring-2 ring-white dark:ring-zinc-900/80">
              <TeamAvatar name={row.name ?? ''} email={row.email} />
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-[15px] font-semibold text-zinc-900 dark:text-zinc-50">
                {row.name || '—'}
              </DialogTitle>
              <div className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
                {row.email ?? 'No email on file'}
              </div>
            </div>
          </div>

          <div className="relative mt-3 flex flex-wrap items-center gap-1.5">
            {row.createdNew ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2.5 py-1 text-[11px] font-semibold text-sky-700 dark:bg-sky-950/50 dark:text-sky-300">
                <Sparkles className="h-3 w-3" /> First-time setup
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                <PencilLine className="h-3 w-3" /> Updated details
              </span>
            )}
            {row.processor && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold capitalize text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                <CreditCard className="h-3 w-3" /> {row.processor}
              </span>
            )}
          </div>
        </div>

        {/* ── Meta: when / type / source / IP ───────────────────────────────── */}
        <div className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200/80 bg-white/60 dark:divide-zinc-800/80 dark:border-zinc-800 dark:bg-zinc-900/40">
          <MetaRow
            icon={<Clock className="h-3.5 w-3.5" />}
            tint="bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-300"
            label="When"
            value={
              <>
                {absoluteTime(row.created_at)}{' '}
                <span className="text-zinc-400 dark:text-zinc-500">· {timeAgo(row.created_at)}</span>
              </>
            }
          />
          <MetaRow
            icon={row.createdNew ? <UserPlus className="h-3.5 w-3.5" /> : <PencilLine className="h-3.5 w-3.5" />}
            tint={
              row.createdNew
                ? 'bg-sky-50 text-sky-600 dark:bg-sky-950/50 dark:text-sky-300'
                : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
            }
            label="Type"
            value={row.createdNew ? 'First-time payout setup' : 'Updated existing details'}
          />
          <MetaRow
            icon={<Link2 className="h-3.5 w-3.5" />}
            tint="bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300"
            label="Source"
            value={row.via === 'external_link' ? 'External self-service link' : row.via || 'External link'}
          />
          {row.ip_address && (
            <MetaRow
              icon={<Globe className="h-3.5 w-3.5" />}
              tint="bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-300"
              label="IP address"
              value={<span className="font-mono text-[11.5px]">{row.ip_address}</span>}
            />
          )}
        </div>

        {/* ── Exactly which fields changed ──────────────────────────────────── */}
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Fields updated
            </span>
            <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-emerald-100 px-1.5 text-[11px] font-bold tabular-nums text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
              {changed.length}
            </span>
          </div>
          {changed.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50/60 px-3 py-2.5 text-[12px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
              Only the payment method was changed.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {changed.map((f) => (
                <span
                  key={f}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200/70 bg-emerald-50/70 px-2 py-1 text-[11.5px] font-medium text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  {fieldLabel(f)}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* ── Privacy footer, bled to the dialog edges ──────────────────────── */}
        <div className="-mx-4 -mb-4 flex items-start gap-2 rounded-b-xl border-t border-zinc-100 bg-zinc-50/70 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
          <ShieldCheck className="mt-px h-4 w-4 shrink-0 text-emerald-500" />
          <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
            Field names only — account numbers are never recorded here. Open this person in the roster to review
            their audited details.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One labelled detail row inside the dialog's meta card. */
function MetaRow({
  icon,
  tint,
  label,
  value,
}: {
  icon: ReactNode;
  tint: string;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-3.5 py-2.5">
      <span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', tint)}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          {label}
        </div>
        <div className="mt-0.5 break-words text-[12.5px] text-zinc-700 dark:text-zinc-200">{value}</div>
      </div>
    </div>
  );
}

/* ── Live indicator ──────────────────────────────────────────────────────── */

function LiveDot({ reduce }: { reduce: boolean }) {
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      {!reduce && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
      )}
      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
    </span>
  );
}

/* ── Loading + empty states ──────────────────────────────────────────────── */

function FeedSkeleton() {
  return (
    <ul className="space-y-2" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <li
          key={i}
          className="flex items-start gap-3 rounded-xl border border-zinc-200 bg-white p-3.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
        >
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3.5 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="h-2.5 w-52 max-w-[70%] animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="flex gap-1">
              <div className="h-4 w-16 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800/70" />
              <div className="h-4 w-20 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800/70" />
            </div>
          </div>
          <div className="h-2.5 w-12 shrink-0 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
        </li>
      ))}
    </ul>
  );
}

function EmptyState({ searching }: { searching: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-300 bg-white/50 py-16 text-center dark:border-zinc-700 dark:bg-zinc-950/40">
      {searching ? (
        <>
          <Search className="mb-2 h-6 w-6 text-zinc-300 dark:text-zinc-600" />
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No bank changes match your search.</p>
        </>
      ) : (
        <>
          <Inbox className="mb-2 h-6 w-6 text-zinc-300 dark:text-zinc-600" />
          <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">No bank changes yet</p>
          <p className="mt-1 flex items-center gap-1 text-[12px] text-zinc-400 dark:text-zinc-500">
            <ShieldCheck className="h-3.5 w-3.5" /> Self-service payout edits will appear here the moment they land.
          </p>
        </>
      )}
    </div>
  );
}
