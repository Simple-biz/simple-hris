'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Eye, Radio, Wand2, Send, Users, Lock } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import type { PayrollLivePeer } from '@/hooks/usePayrollLivePresence';
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

function usePayrollWatchRoster(viewerEmail: string | null, enabled: boolean): PayrollLivePeer[] {
  const normSelf = useMemo(
    () => (viewerEmail ? normEmail(viewerEmail) ?? viewerEmail.trim().toLowerCase() : null),
    [viewerEmail],
  );
  const [acPeers, setAcPeers] = useState<PayrollLivePeer[]>([]);
  const [plPeers, setPlPeers] = useState<PayrollLivePeer[]>([]);

  useEffect(() => {
    if (!enabled) {
      setAcPeers([]);
      setPlPeers([]);
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !normSelf) return;

    const ac = supabase.channel('accounting-collab', {
      config: { presence: { key: normSelf }, broadcast: { self: false } },
    });
    const syncAc = () => {
      const state = ac.presenceState<AccountingPresence>();
      const list: PayrollLivePeer[] = [];
      for (const k of Object.keys(state)) {
        const m = state[k]?.[0];
        if (!m) continue;
        const email = normEmail(m.email ?? k) ?? (m.email ?? k).trim().toLowerCase();
        if (!email || email === 'anon') continue;
        const meta = PAYROLL_SECTIONS[m.section ?? ''];
        if (!meta) continue; // not on a payroll surface right now
        list.push({
          email,
          name: m.name ?? null,
          avatarUrl: m.avatarUrl ?? null,
          surface: meta.surface,
          activity: meta.activity,
          online_at: '',
        });
      }
      setAcPeers(list);
    };
    ac.on('presence', { event: 'sync' }, syncAc)
      .on('presence', { event: 'join' }, syncAc)
      .on('presence', { event: 'leave' }, syncAc)
      .subscribe();

    const pl = supabase.channel('payroll-live', { config: { presence: { key: normSelf } } });
    const syncPl = () => {
      const state = pl.presenceState<PayrollLivePresence>();
      const list: PayrollLivePeer[] = [];
      for (const k of Object.keys(state)) {
        const m = state[k]?.[0];
        if (!m) continue;
        const email = normEmail(m.email ?? k) ?? (m.email ?? k).trim().toLowerCase();
        if (!email || email === 'anon') continue;
        list.push({
          email,
          name: m.name ?? null,
          avatarUrl: m.avatarUrl ?? null,
          surface: m.surface ?? 'dispatch',
          activity: m.activity ?? null,
          online_at: m.online_at ?? '',
        });
      }
      setPlPeers(list);
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
    const byEmail = new Map<string, PayrollLivePeer>();
    for (const p of acPeers) byEmail.set(p.email, p);
    for (const p of plPeers) byEmail.set(p.email, p);
    return Array.from(byEmail.values()).sort((a, b) => a.email.localeCompare(b.email));
  }, [acPeers, plPeers]);
}

function PovAvatar({ peer }: { peer: PayrollLivePeer }) {
  const [failed, setFailed] = useState(false);
  const url = peer.avatarUrl?.trim();
  const show = !!url && !failed;
  const { accent } = surfaceMeta(peer.surface);
  return (
    <div
      className="relative h-11 w-11 shrink-0 overflow-hidden rounded-full bg-white dark:bg-zinc-900"
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
          {initialsFor(peer.name, peer.email)}
        </div>
      )}
      <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center">
        <motion.span
          className="absolute inline-flex h-full w-full rounded-full bg-emerald-400"
          initial={{ opacity: 0.55, scale: 1 }}
          animate={{ opacity: 0, scale: 2.1 }}
          transition={{ duration: 1.9, repeat: Infinity, ease: 'easeOut' }}
        />
        <span className="relative h-3.5 w-3.5 rounded-full border-2 border-white bg-emerald-500 dark:border-zinc-950" />
      </span>
    </div>
  );
}

interface Props {
  viewerEmail: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Global dispatch lock — whether accounting has started processing. */
  locked: boolean;
}

export default function CeoPayrollLive({ viewerEmail, open, onOpenChange, locked }: Props) {
  // Roster merged from the accounting avatar-rail channel (accounting-collab,
  // payroll surfaces) + payroll-live (covers the standalone payroll clerk).
  // Only subscribes while the modal is open.
  const peers = usePayrollWatchRoster(viewerEmail, open);

  const normSelf = useMemo(
    () => (viewerEmail ? normEmail(viewerEmail) ?? viewerEmail.trim().toLowerCase() : null),
    [viewerEmail],
  );
  // Never list the CEO themselves (in case they hold a role that also publishes).
  const roster = useMemo(() => peers.filter((p) => p.email !== normSelf), [peers, normSelf]);

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
    if (observedEmail && roster.length > 0 && !roster.some((p) => p.email === observedEmail)) {
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
  const observedAccent = observedPeer ? surfaceMeta(observedPeer.surface).accent : '#f59e0b';

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
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
                {canWatch
                  ? roster.length > 0
                    ? `${roster.length} ${roster.length === 1 ? 'person is' : 'people are'} processing payroll right now — pick whose screen to watch.`
                    : 'Processing has started — waiting for someone to open the Payroll Wizard or Payment Dispatch…'
                  : stoppedNotice
                    ? 'Payroll processing has been stopped. The live view is closed.'
                    : 'Accounting hasn’t started payment processing yet — there’s nothing to watch. This unlocks the moment they hit “Start processing.”'}
              </DialogDescription>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {!canWatch ? (
                <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                  <div
                    className={
                      'flex h-12 w-12 items-center justify-center rounded-full ' +
                      (stoppedNotice
                        ? 'bg-rose-100 text-rose-500 dark:bg-rose-950/40 dark:text-rose-400'
                        : 'bg-zinc-100 text-zinc-400 dark:bg-zinc-900')
                    }
                  >
                    {stoppedNotice ? <Lock className="h-6 w-6" /> : <Radio className="h-6 w-6" />}
                  </div>
                  <p className="text-[14px] font-semibold text-zinc-900 dark:text-zinc-100">
                    {stoppedNotice ? 'Payroll processing has been stopped' : 'Processing hasn’t started'}
                  </p>
                  <p className="max-w-xs text-[12.5px] text-zinc-500 dark:text-zinc-400">
                    {stoppedNotice
                      ? 'Accounting ended the payment run, so the live view has been closed. It reopens here when they start processing again.'
                      : 'You can watch the team operate live once accounting hits “Start processing” in Payment Dispatch.'}
                  </p>
                </div>
              ) : roster.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 text-zinc-400 dark:bg-zinc-900">
                    <Users className="h-6 w-6" />
                  </div>
                  <p className="max-w-xs text-[13px] text-zinc-500 dark:text-zinc-400">
                    Waiting for an accountant or the payroll clerk to open the Payroll Wizard or
                    Payment Dispatch. Their screen will appear here to watch.
                  </p>
                </div>
              ) : (
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <AnimatePresence initial={false}>
                    {roster.map((peer) => {
                      const { label, Icon, accent } = surfaceMeta(peer.surface);
                      const display = (peer.name && peer.name.trim()) || toLabel(peer.email);
                      const watching = observedEmail === peer.email;
                      return (
                        <motion.div
                          key={peer.email}
                          layout
                          initial={{ opacity: 0, y: 8, scale: 0.98 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
                          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                          className={
                            'flex items-center gap-3 rounded-xl border p-3 transition-colors ' +
                            (watching
                              ? 'border-rose-300 bg-rose-50/60 dark:border-rose-900/60 dark:bg-rose-950/20'
                              : 'border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700')
                          }
                        >
                          <PovAvatar peer={peer} />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
                              {display}
                            </div>
                            <div
                              className="mt-0.5 flex items-center gap-1 text-[11px] font-medium"
                              style={{ color: accent }}
                            >
                              <Icon className="h-3 w-3 shrink-0" />
                              <span className="truncate">{label}</span>
                            </div>
                            {peer.activity && (
                              <div className="truncate text-[11px] text-zinc-400 dark:text-zinc-500">
                                {peer.activity}
                              </div>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => setObservedEmail(watching ? null : peer.email)}
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
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
              )}
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
