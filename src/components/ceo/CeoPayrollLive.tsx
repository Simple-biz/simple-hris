'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Eye, Radio, Wand2, Send, Users, Lock, Wallet } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import type { PayrollLivePeer } from '@/hooks/usePayrollLivePresence';
import type { PaymentsLiveState, PaidFeedEntry } from '@/hooks/usePaymentsLive';
import { useCobrowse } from '@/hooks/useCobrowse';
import CobrowseSurface from '@/components/collab/CobrowseSurface';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { normEmail } from '@/lib/email/norm-email';

/**
 * Live payroll oversight modal — opened from the CEO Overview "Payments to send"
 * KPI card. Lists every worker currently driving the Payroll Wizard or Payment
 * Dispatch (from the `payroll-live` presence channel); the CEO picks whose POV
 * to watch, which streams an exact live mirror of that person's screen via the
 * shared rrweb cobrowse engine (the same one Accounting uses), whatever surface
 * they're on. `locked` (the global dispatch lock) is passed in from the card so
 * we don't double-subscribe.
 */

const SURFACE_META: Record<string, { label: string; Icon: typeof Wand2; accent: string }> = {
  wizard: { label: 'Payroll Wizard', Icon: Wand2, accent: '#8b5cf6' },
  dispatch: { label: 'Payment Dispatch', Icon: Send, accent: '#f59e0b' },
};

function surfaceMeta(surface: string) {
  return SURFACE_META[surface] ?? { label: surface || 'Payroll', Icon: Send, accent: '#f59e0b' };
}

function toLabel(email: string) {
  return (email.split('@')[0] ?? email).slice(0, 22);
}

function initialsFor(name: string | null, email: string): string {
  const src = (name && name.trim()) || email.split('@')[0] || email;
  const parts = src.replace(/[._-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ── Money formatting for the "being paid now" feed ─────────────────────────────
// Always two decimals for USD/PHP (never drop cents); COP is whole pesos.
function fmtUsd(v: number | null): string | null {
  if (v == null) return null;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPhp(v: number | null): string | null {
  if (v == null) return null;
  return `₱${v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtCop(v: number | null): string | null {
  if (v == null) return null;
  return `COP ${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
/** USD leads; PHP (or COP) rides underneath, smaller. Falls back gracefully
 *  when a recipient was only paid in one currency. */
function payAmounts(p: PaidFeedEntry): { primary: string; secondary: string | null } {
  const usd = fmtUsd(p.amountUsd);
  const php = fmtPhp(p.amountPhp);
  const cop = fmtCop(p.amountCop);
  if (usd) return { primary: usd, secondary: php ?? cop };
  if (php) return { primary: php, secondary: cop };
  if (cop) return { primary: cop, secondary: null };
  return { primary: '—', secondary: null };
}

// ── Watch roster ──────────────────────────────────────────────────────────────
// Merges the two live presence sources so nobody on a payroll surface is missed:
//   1. `accounting-collab` — the SAME channel the Accounting dashboard's avatar
//      rail / "Observe" uses (every accountant on the dashboard is on it). Kept
//      to people whose current section is a payroll surface.
//   2. `payroll-live` — published by PayrollLivePublisher (covers the standalone
//      /payroll-clerk dashboard, which has no collab layer).
// Deduped by email (the richer payroll-live entry wins). The screen mirror still
// rides `accounting-cobrowse` (useCobrowse). Subscribes only while `enabled`.
const PAYROLL_SECTIONS: Record<string, { surface: 'wizard' | 'dispatch'; activity: string }> = {
  'payroll-wizard': { surface: 'wizard', activity: 'In the Payroll Wizard' },
  'payment-dispatch': { surface: 'dispatch', activity: 'In Payment Dispatch' },
};

interface AccountingPresence {
  email?: string;
  name?: string | null;
  avatarUrl?: string | null;
  section?: string;
}
interface PayrollLivePresence {
  email?: string;
  name?: string | null;
  avatarUrl?: string | null;
  surface?: string;
  activity?: string | null;
  online_at?: string;
}

/** Minimal presence record for anyone present in Accounting right now. */
interface OnlinePresence {
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

interface WatchRoster {
  /** People currently ON a payroll surface (Wizard / Payment Dispatch) — the
   *  only ones whose screen can be watched. */
  peers: PayrollLivePeer[];
  /** Everyone present in Accounting right now (ANY section) — powers the
   *  online/offline badge for the whole team directory. */
  onlineByEmail: Map<string, OnlinePresence>;
}

function usePayrollWatchRoster(viewerEmail: string | null, enabled: boolean): WatchRoster {
  const normSelf = useMemo(
    () => (viewerEmail ? normEmail(viewerEmail) ?? viewerEmail.trim().toLowerCase() : null),
    [viewerEmail],
  );
  const [acPeers, setAcPeers] = useState<PayrollLivePeer[]>([]);
  const [plPeers, setPlPeers] = useState<PayrollLivePeer[]>([]);
  // Everyone present on each channel (regardless of section) — for online status.
  const [acOnline, setAcOnline] = useState<OnlinePresence[]>([]);
  const [plOnline, setPlOnline] = useState<OnlinePresence[]>([]);

  useEffect(() => {
    if (!enabled) {
      setAcPeers([]);
      setPlPeers([]);
      setAcOnline([]);
      setPlOnline([]);
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !normSelf) return;

    const ac = supabase.channel('accounting-collab', {
      config: { presence: { key: normSelf }, broadcast: { self: false } },
    });
    const syncAc = () => {
      const state = ac.presenceState<AccountingPresence>();
      const peers: PayrollLivePeer[] = [];
      const online: OnlinePresence[] = [];
      for (const k of Object.keys(state)) {
        const m = state[k]?.[0];
        if (!m) continue;
        const email = normEmail(m.email ?? k) ?? (m.email ?? k).trim().toLowerCase();
        if (!email || email === 'anon') continue;
        // Present in Accounting → online, whatever section they're on.
        online.push({ email, name: m.name ?? null, avatarUrl: m.avatarUrl ?? null });
        const meta = PAYROLL_SECTIONS[m.section ?? ''];
        if (!meta) continue; // online, but not on a payroll surface → not watchable
        peers.push({
          email,
          name: m.name ?? null,
          avatarUrl: m.avatarUrl ?? null,
          surface: meta.surface,
          activity: meta.activity,
          online_at: '',
        });
      }
      setAcPeers(peers);
      setAcOnline(online);
    };
    ac.on('presence', { event: 'sync' }, syncAc)
      .on('presence', { event: 'join' }, syncAc)
      .on('presence', { event: 'leave' }, syncAc)
      .subscribe();

    const pl = supabase.channel('payroll-live', { config: { presence: { key: normSelf } } });
    const syncPl = () => {
      const state = pl.presenceState<PayrollLivePresence>();
      const peers: PayrollLivePeer[] = [];
      const online: OnlinePresence[] = [];
      for (const k of Object.keys(state)) {
        const m = state[k]?.[0];
        if (!m) continue;
        const email = normEmail(m.email ?? k) ?? (m.email ?? k).trim().toLowerCase();
        if (!email || email === 'anon') continue;
        online.push({ email, name: m.name ?? null, avatarUrl: m.avatarUrl ?? null });
        peers.push({
          email,
          name: m.name ?? null,
          avatarUrl: m.avatarUrl ?? null,
          surface: m.surface ?? 'dispatch',
          activity: m.activity ?? null,
          online_at: m.online_at ?? '',
        });
      }
      setPlPeers(peers);
      setPlOnline(online);
    };
    pl.on('presence', { event: 'sync' }, syncPl)
      .on('presence', { event: 'join' }, syncPl)
      .on('presence', { event: 'leave' }, syncPl)
      .subscribe();

    return () => {
      void supabase.removeChannel(ac);
      void supabase.removeChannel(pl);
    };
  }, [enabled, normSelf]);

  return useMemo(() => {
    const byEmailPeers = new Map<string, PayrollLivePeer>();
    for (const p of acPeers) byEmailPeers.set(p.email, p);
    for (const p of plPeers) byEmailPeers.set(p.email, p); // payroll-live is richer → wins
    const onlineByEmail = new Map<string, OnlinePresence>();
    for (const o of acOnline) onlineByEmail.set(o.email, o);
    for (const o of plOnline) onlineByEmail.set(o.email, o);
    return { peers: Array.from(byEmailPeers.values()), onlineByEmail };
  }, [acPeers, plPeers, acOnline, plOnline]);
}

/** One row in the Accounting directory: everyone with Accounting access, each
 *  tagged online/offline and (if online on a payroll surface) watchable. */
interface RosterEntry {
  email: string;
  name: string | null;
  avatarUrl: string | null;
  online: boolean;
  /** The payroll surface they're on right now, or null (offline / elsewhere). */
  surface: 'wizard' | 'dispatch' | null;
  activity: string | null;
}

function StatusAvatar({ entry }: { entry: RosterEntry }) {
  const [failed, setFailed] = useState(false);
  const url = entry.avatarUrl?.trim();
  const show = !!url && !failed;
  // Ring: surface accent when watchable, emerald when just online, grey offline.
  const accent = entry.surface
    ? surfaceMeta(entry.surface).accent
    : entry.online
      ? '#10b981'
      : '#94a3b8';
  return (
    <div className="relative h-11 w-11 shrink-0">
      {/* Clipped circle holds the ring + image. The status dot lives on the
          OUTER wrapper below so overflow-hidden can't swallow it (it sits just
          outside the frame edge). */}
      <div
        className={
          'h-full w-full overflow-hidden rounded-full bg-white dark:bg-zinc-900 ' +
          (entry.online ? '' : 'opacity-60 grayscale')
        }
        style={{ boxShadow: `0 0 0 2px ${accent}, 0 2px 8px rgba(0,0,0,0.18)` }}
      >
        {show ? (
          // eslint-disable-next-line @next/next/no-img-element -- Supabase/Google avatar URL
          <img
            src={url}
            alt=""
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
            onError={() => setFailed(true)}
          />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center text-[13px] font-bold text-white"
            style={{ background: `linear-gradient(135deg, ${accent}, #1e293b)` }}
            aria-hidden
          >
            {initialsFor(entry.name, entry.email)}
          </div>
        )}
      </div>
      {/* Status dot — OUTSIDE the clipped frame. Green (pulsing) online, grey off. */}
      <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center">
        {entry.online && (
          <motion.span
            className="absolute inline-flex h-full w-full rounded-full bg-emerald-400"
            initial={{ opacity: 0.55, scale: 1 }}
            animate={{ opacity: 0, scale: 2.1 }}
            transition={{ duration: 1.9, repeat: Infinity, ease: 'easeOut' }}
          />
        )}
        <span
          className={
            'relative h-3.5 w-3.5 rounded-full border-2 border-white dark:border-zinc-950 ' +
            (entry.online ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600')
          }
        />
      </span>
    </div>
  );
}

// ── Live "being paid now" feed rail ────────────────────────────────────────────
// A side column listing who's getting paid from Payment Dispatch right now, with
// the running paid/left counter on top. Two columns per row: name + amount (USD
// leads, PHP small beneath). Fed by usePaymentsLive (Realtime pulse + poll), so
// new payments animate in the instant anyone marks a worker paid.
function PaymentsFeedRail({ payments }: { payments: PaymentsLiveState }) {
  const feed = payments.recent;
  return (
    <aside className="flex min-h-0 shrink-0 flex-col border-t border-zinc-200 max-md:max-h-[42vh] md:w-[300px] md:border-l md:border-t-0 dark:border-zinc-800">
      <div className="shrink-0 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            <Wallet className="h-3.5 w-3.5 text-emerald-500" /> Being paid now
          </div>
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            Live
          </span>
        </div>
        <div className="mt-1.5 flex items-baseline gap-1.5">
          <motion.span
            key={payments.paid}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="text-2xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100"
          >
            {payments.paid}
          </motion.span>
          <span className="text-[12px] text-zinc-400">
            paid · <span className="tabular-nums">{payments.remaining}</span> left
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {feed.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-3 py-8 text-center">
            <Wallet className="h-6 w-6 text-zinc-300 dark:text-zinc-700" />
            <p className="text-[12px] text-zinc-400 dark:text-zinc-500">
              No one has been paid yet this cycle. Recipients appear here the moment they’re marked paid.
            </p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            <AnimatePresence initial={false}>
              {feed.map((p) => {
                const display = (p.name && p.name.trim()) || toLabel(p.email);
                const { primary, secondary } = payAmounts(p);
                return (
                  <motion.li
                    key={p.email}
                    layout
                    initial={{ opacity: 0, y: -6, backgroundColor: 'rgba(16,185,129,0.14)' }}
                    animate={{ opacity: 1, y: 0, backgroundColor: 'rgba(16,185,129,0)' }}
                    exit={{ opacity: 0, transition: { duration: 0.15 } }}
                    transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                    className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5"
                  >
                    <span
                      className="min-w-0 truncate text-[12.5px] font-medium text-zinc-800 dark:text-zinc-100"
                      title={display}
                    >
                      {display}
                    </span>
                    <span className="flex shrink-0 flex-col items-end leading-tight">
                      <span className="text-[13px] font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                        {primary}
                      </span>
                      {secondary && (
                        <span className="text-[10.5px] tabular-nums text-zinc-400 dark:text-zinc-500">
                          {secondary}
                        </span>
                      )}
                    </span>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </aside>
  );
}

interface Props {
  viewerEmail: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Global dispatch lock — whether accounting has started processing. */
  locked: boolean;
  /** Live payments progress + recent-paid feed (from the CEO Overview's hook). */
  payments: PaymentsLiveState;
}

export default function CeoPayrollLive({ viewerEmail, open, onOpenChange, locked, payments }: Props) {
  // Live presence: who's on a payroll surface (watchable `peers`) + who's online
  // in Accounting at all (`onlineByEmail`). Only subscribes while the modal is open.
  const { peers, onlineByEmail } = usePayrollWatchRoster(viewerEmail, open);

  const normSelf = useMemo(
    () => (viewerEmail ? normEmail(viewerEmail) ?? viewerEmail.trim().toLowerCase() : null),
    [viewerEmail],
  );

  // The Accounting directory (everyone with the `accounting` role) so the modal
  // shows the WHOLE team — online AND offline — not just whoever's driving a
  // payroll surface. Fetched fresh each time the modal opens.
  const [directory, setDirectory] = useState<{ email: string; name: string | null }[]>([]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch('/api/ceo/accounting-team', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { members?: { email: string; name: string | null }[] }) => {
        if (alive) setDirectory(Array.isArray(j.members) ? j.members : []);
      })
      .catch(() => {
        /* directory is best-effort; live presence still renders */
      });
    return () => {
      alive = false;
    };
  }, [open]);

  // Merge directory + live presence into one ranked roster: on a payroll surface
  // first (watchable), then merely online, then offline. Never lists the CEO.
  const roster = useMemo<RosterEntry[]>(() => {
    const peerByEmail = new Map(peers.map((p) => [p.email, p]));
    const dirNameByEmail = new Map(directory.map((d) => [d.email, d.name]));
    const emails = new Set<string>();
    for (const d of directory) emails.add(d.email);
    for (const e of onlineByEmail.keys()) emails.add(e);
    for (const p of peers) emails.add(p.email);
    if (normSelf) emails.delete(normSelf);

    const entries: RosterEntry[] = [];
    for (const email of emails) {
      if (!email) continue;
      const peer = peerByEmail.get(email) ?? null;
      const on = onlineByEmail.get(email) ?? null;
      entries.push({
        email,
        name: peer?.name ?? on?.name ?? dirNameByEmail.get(email) ?? null,
        avatarUrl: peer?.avatarUrl ?? on?.avatarUrl ?? null,
        online: !!peer || !!on,
        surface: peer ? ((peer.surface as 'wizard' | 'dispatch') ?? null) : null,
        activity: peer?.activity ?? null,
      });
    }
    const rank = (e: RosterEntry) => (e.surface ? 0 : e.online ? 1 : 2);
    entries.sort(
      (a, b) => rank(a) - rank(b) || (a.name ?? a.email).localeCompare(b.name ?? b.email),
    );
    return entries;
  }, [directory, peers, onlineByEmail, normSelf]);

  const watchable = useMemo(() => roster.filter((e) => !!e.surface), [roster]);
  const onlineCount = useMemo(() => roster.filter((e) => e.online).length, [roster]);

  const [observedEmail, setObservedEmail] = useState<string | null>(null);
  // Latest observedEmail readable inside the lock-transition effect without
  // making that effect depend on it (so it fires only on a lock change).
  const observedRef = useRef<string | null>(null);
  observedRef.current = observedEmail;
  // Set when accounting STOPS processing while the CEO is here — explains why
  // the view closed. `stoppedFullScreen` is the version shown over the live
  // mirror when they were actively watching full-screen at the moment of stop.
  const [stoppedNotice, setStoppedNotice] = useState(false);
  const [stoppedFullScreen, setStoppedFullScreen] = useState(false);

  // Watching is gated on the global dispatch lock: the CEO can ONLY observe
  // while accounting has "Start processing" engaged. No lock → no watching.
  const canWatch = locked;
  const live = locked;

  // Stop watching if the person drops off the roster, or the modal closes.
  useEffect(() => {
    // Stop watching if the person is gone or no longer on a watchable surface
    // (e.g. they left the Wizard/Dispatch or went offline).
    if (observedEmail && !roster.some((p) => p.email === observedEmail && p.surface)) {
      setObservedEmail(null);
    }
  }, [observedEmail, roster]);
  useEffect(() => {
    if (!open) {
      setObservedEmail(null);
      setStoppedNotice(false);
      setStoppedFullScreen(false);
    }
  }, [open]);

  // React to processing start/stop (the lock is realtime via useDispatchLock).
  // When accounting STOPS (lock true→false): break the live connection, force
  // the CEO out of watching, and surface a "processing has been stopped" notice
  // — full-screen if they were actively watching, so the message lands on the
  // surface they're looking at (not just the modal behind it). A fresh start
  // clears it.
  const prevLockedRef = useRef(locked);
  useEffect(() => {
    const was = prevLockedRef.current;
    prevLockedRef.current = locked;
    if (was && !locked) {
      if (observedRef.current) setStoppedFullScreen(true);
      setObservedEmail(null);
      setStoppedNotice(true);
    } else if (locked) {
      setStoppedNotice(false);
      setStoppedFullScreen(false);
    }
  }, [locked]);

  const { setReplayContainer, status: cobrowseStatus } = useCobrowse({
    selfEmail: normSelf,
    observedEmail,
  });

  const observedPeer = observedEmail ? roster.find((p) => p.email === observedEmail) ?? null : null;
  const observedDisplay = observedPeer
    ? (observedPeer.name && observedPeer.name.trim()) || toLabel(observedPeer.email)
    : observedEmail
      ? toLabel(observedEmail)
      : '';
  const observedAccent =
    observedPeer?.surface ? surfaceMeta(observedPeer.surface).accent : '#f59e0b';

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-4xl">
          <div className="flex max-h-[85vh] flex-col">
            <DialogHeader className="shrink-0 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <DialogTitle className="flex items-center gap-2 text-lg">
                <span className="relative flex h-2.5 w-2.5 items-center justify-center">
                  {live && (
                    <motion.span
                      className="absolute inline-flex h-full w-full rounded-full bg-rose-500"
                      initial={{ opacity: 0.7, scale: 1 }}
                      animate={{ opacity: 0, scale: 2.6 }}
                      transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
                    />
                  )}
                  <span
                    className={
                      'relative h-2.5 w-2.5 rounded-full ' +
                      (live ? 'bg-rose-500' : 'bg-zinc-300 dark:bg-zinc-700')
                    }
                  />
                </span>
                <Radio className={'h-4 w-4 ' + (live ? 'text-rose-500' : 'text-zinc-400')} />
                Live payroll processing
              </DialogTitle>
              <DialogDescription>
                {stoppedNotice
                  ? 'Payroll processing has been stopped — you can still see who’s online below.'
                  : canWatch
                    ? watchable.length > 0
                      ? `${watchable.length} ${watchable.length === 1 ? 'person is' : 'people are'} processing now — pick whose screen to watch · ${onlineCount} of ${roster.length} online.`
                      : `Processing has started — waiting for someone to open the Payroll Wizard or Payment Dispatch · ${onlineCount} of ${roster.length} online.`
                    : `Accounting hasn’t started processing yet — nothing to watch · ${onlineCount} of ${roster.length} online.`}
              </DialogDescription>
            </DialogHeader>

            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {roster.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 text-zinc-400 dark:bg-zinc-900">
                    <Users className="h-6 w-6" />
                  </div>
                  <p className="max-w-xs text-[13px] text-zinc-500 dark:text-zinc-400">
                    No one with Accounting access to show yet.
                  </p>
                </div>
              ) : (
                <>
                  {/* When watching is unavailable (processing not started / stopped)
                      we still list the whole team so the CEO can see who's around. */}
                  {!canWatch && (
                    <div
                      className={
                        'mb-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] ' +
                        (stoppedNotice
                          ? 'border-rose-200 bg-rose-50/60 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/20 dark:text-rose-300'
                          : 'border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400')
                      }
                    >
                      {stoppedNotice ? (
                        <Lock className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <Radio className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span>
                        {stoppedNotice
                          ? 'Processing stopped — watching is unavailable, but you can still see who’s online.'
                          : 'Processing hasn’t started — watching unlocks when Accounting hits “Start processing.”'}
                      </span>
                    </div>
                  )}
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <AnimatePresence initial={false}>
                      {roster.map((entry) => {
                        const display = (entry.name && entry.name.trim()) || toLabel(entry.email);
                        const watching = observedEmail === entry.email;
                        const meta = entry.surface ? surfaceMeta(entry.surface) : null;
                        const SurfaceIcon = meta?.Icon;
                        const canWatchThis = canWatch && !!entry.surface;
                        return (
                          <motion.div
                            key={entry.email}
                            layout
                            initial={{ opacity: 0, y: 8, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
                            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                            className={
                              'flex items-center gap-3 rounded-xl border p-3 transition-colors ' +
                              (watching
                                ? 'border-rose-300 bg-rose-50/60 dark:border-rose-900/60 dark:bg-rose-950/20'
                                : entry.online
                                  ? 'border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700'
                                  : 'border-zinc-200/70 bg-zinc-50/50 dark:border-zinc-800/60 dark:bg-zinc-900/30')
                            }
                          >
                            <StatusAvatar entry={entry} />
                            <div className="min-w-0 flex-1">
                              <div
                                className={
                                  'truncate text-[13px] font-semibold ' +
                                  (entry.online
                                    ? 'text-zinc-900 dark:text-zinc-100'
                                    : 'text-zinc-500 dark:text-zinc-400')
                                }
                              >
                                {display}
                              </div>
                              {meta && SurfaceIcon ? (
                                <div
                                  className="mt-0.5 flex items-center gap-1 text-[11px] font-medium"
                                  style={{ color: meta.accent }}
                                >
                                  <SurfaceIcon className="h-3 w-3 shrink-0" />
                                  <span className="truncate">{meta.label}</span>
                                </div>
                              ) : (
                                <div
                                  className={
                                    'mt-0.5 text-[11px] font-medium ' +
                                    (entry.online
                                      ? 'text-emerald-600 dark:text-emerald-400'
                                      : 'text-zinc-400 dark:text-zinc-500')
                                  }
                                >
                                  {entry.online ? 'Online' : 'Offline'}
                                </div>
                              )}
                              {entry.activity && (
                                <div className="truncate text-[11px] text-zinc-400 dark:text-zinc-500">
                                  {entry.activity}
                                </div>
                              )}
                            </div>
                            {canWatchThis && (
                              <button
                                type="button"
                                onClick={() => setObservedEmail(watching ? null : entry.email)}
                                className={
                                  'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors ' +
                                  (watching
                                    ? 'bg-rose-500 text-white hover:bg-rose-600'
                                    : 'bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200')
                                }
                              >
                                <Eye className="h-3.5 w-3.5" />
                                {watching ? 'Watching' : 'Watch'}
                              </button>
                            )}
                          </motion.div>
                        );
                      })}
                    </AnimatePresence>
                  </div>
                </>
              )}
            </div>

              {/* Live "being paid now" feed — who Payment Dispatch is paying
                  right now, USD-led amounts, ticking in via Realtime. */}
              <PaymentsFeedRail payments={payments} />
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Full-screen live mirror of the chosen POV — sits above the dialog. */}
      <AnimatePresence>
        {observedEmail && (
          <CobrowseSurface
            key={observedEmail}
            driverName={observedDisplay}
            accent={{ bg: observedAccent, glow: `${observedAccent}88` }}
            status={cobrowseStatus}
            setReplayContainer={setReplayContainer}
            onStop={() => setObservedEmail(null)}
          />
        )}
      </AnimatePresence>

      {/* Forced-stop notice — covers the full screen (above the mirror) the
          instant accounting stops processing while the CEO is watching, so the
          message lands where they're looking instead of the screen just vanishing. */}
      <AnimatePresence>
        {stoppedFullScreen && (
          <motion.div
            className="rr-block fixed inset-0 z-[130] flex flex-col items-center justify-center gap-4 bg-zinc-950/95 px-6 text-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-rose-500/15 text-rose-400">
              <Lock className="h-8 w-8" />
            </div>
            <div className="text-lg font-semibold text-white">Payroll processing has been stopped</div>
            <div className="max-w-sm text-[13px] leading-relaxed text-zinc-400">
              Accounting ended the payment run, so the live view was closed. It&apos;ll be available
              here again the moment they start processing.
            </div>
            <button
              type="button"
              onClick={() => setStoppedFullScreen(false)}
              className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-[13px] font-semibold text-zinc-900 transition-colors hover:bg-zinc-200"
            >
              Close
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
