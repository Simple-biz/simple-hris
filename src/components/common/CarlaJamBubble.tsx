'use client';

import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Pause, Play, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isCarlaJamEmail } from '@/lib/sound/carla-jam-clock';
import {
  CARLA_JAM_ARTIST,
  CARLA_JAM_TITLE,
  armCarlaJam,
  closeCarlaJam,
  disarmCarlaJam,
  getCarlaJamProgress,
  getCarlaJamServerState,
  getCarlaJamState,
  playCarlaJam,
  subscribeCarlaJam,
  toggleCarlaJam,
} from '@/lib/sound/carla-jam';

/**
 * Carla's Jellyfish Jam bubble — mounted ONCE in the root layout, beside
 * `CarlaSongToast`, so it survives dashboard switches. For everyone but
 * carla@simple.biz it renders nothing and arms nothing.
 *
 * After every 5 active minutes a round jellyfish play button floats in on the
 * right edge. Pressing it plays the song and the bubble becomes a small
 * player (pause / play, ✕ to close). The ✕ on the bubble itself means "not
 * now". Either way the next bubble is 5 active minutes after this one closes.
 *
 * Right edge, vertically centred: bottom-right holds the Penny / Notes /
 * tutorial / cobrowse buttons, bottom-left the dispatch paid toasts,
 * top-centre the sign-in pill and top-right the sonner stack. z-[110] floats
 * above the dashboard switch loader (100) and below the collab chrome (120+).
 *
 * Governing doc: docs/features/carla-jellyfish-bubble.md.
 */
export default function CarlaJamBubble() {
  const { data: session, status } = useSession();
  const pathname = usePathname() ?? '';
  const eligible =
    status === 'authenticated' && isCarlaJamEmail(session?.user?.email) && !pathname.startsWith('/login');

  useEffect(() => {
    if (status === 'loading') return;
    if (eligible) {
      armCarlaJam();
      return () => disarmCarlaJam();
    }
    // Signed out, someone else on this tab, or /login: silence it and wipe this tab's clock.
    disarmCarlaJam({ forget: true });
  }, [eligible, status]);

  const { phase } = useSyncExternalStore(subscribeCarlaJam, getCarlaJamState, getCarlaJamServerState);
  const up = eligible && phase !== 'counting';

  // Keep the last view in the DOM briefly so it can float away instead of popping.
  const [shown, setShown] = useState<'offer' | 'player' | null>(null);
  const [leaving, setLeaving] = useState(false);
  const view = phase === 'offer' ? 'offer' : 'player';
  useEffect(() => {
    if (up) {
      setShown(view);
      setLeaving(false);
      return;
    }
    if (!shown) return;
    setLeaving(true);
    const t = window.setTimeout(() => {
      setShown(null);
      setLeaving(false);
    }, 320);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [up, view]);

  // The live phase drives what renders; `shown` only holds the last view while it floats away.
  const current = up ? view : shown;

  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (current !== 'player') return;
    const read = () => {
      const { elapsed, duration } = getCarlaJamProgress();
      setProgress(duration > 0 ? elapsed / duration : 0);
    };
    read();
    if (phase !== 'playing') return;
    const t = window.setInterval(read, 250);
    return () => window.clearInterval(t);
  }, [current, phase]);

  if (!current) return null;

  const playing = phase === 'playing';
  const exiting = !up && leaving;

  return (
    <div className="pointer-events-none fixed right-4 top-1/2 z-[110] -translate-y-1/2">
      {current === 'offer' ? (
        <div className={cn('jam-arrive pointer-events-auto relative', exiting && 'jam-leave')}>
          <div className="jam-bob relative">
            <span className="jam-ripple" aria-hidden />
            <button
              type="button"
              onClick={playCarlaJam}
              aria-label={`Play ${CARLA_JAM_TITLE}`}
              title={`Play ${CARLA_JAM_TITLE}`}
              className="jam-bubble relative flex h-16 w-16 items-center justify-center overflow-hidden rounded-full border-2 border-white/80 shadow-[0_14px_36px_rgba(8,47,73,0.35)] outline-none transition-transform duration-200 ease-out hover:scale-105 focus-visible:ring-4 focus-visible:ring-pink-300/70 active:scale-95 dark:border-white/20"
            >
              <span className="jam-air jam-air-1" aria-hidden />
              <span className="jam-air jam-air-2" aria-hidden />
              <JellyfishIcon className="relative h-11 w-11 -translate-y-0.5" />
              <span
                className="absolute bottom-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-white shadow-md ring-1 ring-pink-200"
                aria-hidden
              >
                <Play className="h-2.5 w-2.5 translate-x-[0.5px] fill-pink-600 text-pink-600" />
              </span>
            </button>
            <button
              type="button"
              onClick={closeCarlaJam}
              aria-label="Not now"
              title="Not now"
              className="absolute -left-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-500 shadow-sm transition hover:bg-zinc-100 hover:text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      ) : (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            'jam-arrive pointer-events-auto relative flex w-[min(20rem,calc(100vw-2rem))] items-center gap-3 overflow-hidden rounded-2xl border border-white/70 bg-white/85 py-2.5 pl-2.5 pr-2 shadow-[0_18px_50px_rgba(15,23,42,0.18)] backdrop-blur-xl dark:border-white/10 dark:bg-zinc-900/85',
            exiting && 'jam-leave',
          )}
        >
          <div className="jam-bubble flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl">
            <JellyfishIcon className={cn('h-8 w-8', playing && 'jam-wobble')} />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-400 dark:text-zinc-500">
              {playing ? 'Now playing' : 'Paused'}
              <span className="jam-eq" data-paused={playing ? 'false' : 'true'} aria-hidden>
                <span />
                <span />
                <span />
              </span>
            </div>
            <div className="truncate text-[13px] font-semibold leading-5 text-zinc-900 dark:text-zinc-50">
              {CARLA_JAM_TITLE}
              <span className="font-normal text-zinc-500 dark:text-zinc-400"> · {CARLA_JAM_ARTIST}</span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={toggleCarlaJam}
              aria-label={playing ? 'Pause song' : 'Play song'}
              title={playing ? 'Pause' : 'Play'}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-pink-200 bg-pink-50 text-pink-600 transition hover:bg-pink-100 dark:border-pink-900/60 dark:bg-pink-950/40 dark:text-pink-400"
            >
              {playing ? (
                <Pause className="h-3.5 w-3.5 fill-current" />
              ) : (
                <Play className="h-3.5 w-3.5 translate-x-[1px] fill-current" />
              )}
            </button>
            <button
              type="button"
              onClick={closeCarlaJam}
              aria-label="Close player"
              title="Close"
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Progress along the bottom edge. scaleX (not width) keeps the 4×/sec updates compositor-only. */}
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-zinc-200/50 dark:bg-zinc-700/50" aria-hidden>
            <div
              className="h-full w-full origin-left bg-gradient-to-r from-pink-400 to-fuchsia-500 transition-transform duration-300 ease-linear"
              style={{ transform: `scaleX(${Math.min(1, Math.max(0, progress))})` }}
            />
          </div>
        </div>
      )}

      <style jsx>{`
        .jam-bubble {
          background: radial-gradient(circle at 32% 26%, #7dd3fc 0%, #0ea5e9 45%, #0e7490 100%);
        }
        .jam-leave {
          opacity: 0;
          transform: translateX(12px);
          transition: opacity 0.3s ease-out, transform 0.3s ease-out;
        }
        .jam-ripple {
          position: absolute;
          inset: 0;
          border-radius: 9999px;
          border: 2px solid rgba(244, 114, 182, 0.55);
          opacity: 0;
        }
        .jam-air {
          position: absolute;
          border-radius: 9999px;
          border: 1px solid rgba(255, 255, 255, 0.75);
          background: rgba(255, 255, 255, 0.25);
          opacity: 0.8;
        }
        .jam-air-1 {
          left: 12px;
          bottom: 14px;
          width: 6px;
          height: 6px;
        }
        .jam-air-2 {
          right: 14px;
          top: 12px;
          width: 4px;
          height: 4px;
        }
        .jam-eq {
          display: inline-flex;
          align-items: flex-end;
          gap: 2px;
          height: 10px;
        }
        /* Fixed-height bars scaled from the baseline: compositor-only. */
        .jam-eq span {
          width: 2.5px;
          height: 10px;
          border-radius: 1px;
          background: linear-gradient(180deg, #f472b6, #db2777);
          transform: scaleY(0.3);
          transform-origin: bottom;
        }
        .jam-eq[data-paused='true'] span {
          opacity: 0.35;
        }
        @media (prefers-reduced-motion: no-preference) {
          .jam-arrive {
            animation: jam-in 0.45s cubic-bezier(0.22, 1, 0.36, 1);
          }
          .jam-bob {
            animation: jam-bob 3.2s ease-in-out infinite;
          }
          .jam-ripple {
            animation: jam-ripple 2.4s ease-out infinite;
          }
          .jam-air-1 {
            animation: jam-air 3s ease-in infinite;
          }
          .jam-air-2 {
            animation: jam-air 3s ease-in 1.4s infinite;
          }
          .jam-eq[data-paused='false'] span {
            animation: jam-eq 0.9s ease-in-out infinite;
          }
          .jam-eq span:nth-child(2) {
            animation-delay: 0.18s;
          }
          .jam-eq span:nth-child(3) {
            animation-delay: 0.36s;
          }
          :global(.jam-wobble) {
            animation: jam-wobble 1.1s ease-in-out infinite;
            transform-origin: 50% 40%;
          }
        }
        @keyframes jam-in {
          from {
            opacity: 0;
            transform: translateX(24px) scale(0.9);
          }
          to {
            opacity: 1;
            transform: translateX(0) scale(1);
          }
        }
        @keyframes jam-bob {
          0%,
          100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-6px);
          }
        }
        @keyframes jam-ripple {
          0% {
            opacity: 0.8;
            transform: scale(1);
          }
          100% {
            opacity: 0;
            transform: scale(1.55);
          }
        }
        @keyframes jam-air {
          0% {
            opacity: 0;
            transform: translateY(6px);
          }
          30% {
            opacity: 0.85;
          }
          100% {
            opacity: 0;
            transform: translateY(-22px);
          }
        }
        @keyframes jam-eq {
          0%,
          100% {
            transform: scaleY(0.3);
          }
          50% {
            transform: scaleY(1);
          }
        }
        @keyframes jam-wobble {
          0%,
          100% {
            transform: translateY(0) scaleY(1);
          }
          50% {
            transform: translateY(-1.5px) scaleY(0.92);
          }
        }
      `}</style>
    </div>
  );
}

/**
 * A pink Bikini Bottom jellyfish: a dome bell with a scalloped rim, darker
 * spots, a highlight and four wavy tentacles. Inline because lucide has no
 * jellyfish. Gradient ids are per-instance so two icons on a page never share one.
 */
function JellyfishIcon({ className }: { className?: string }) {
  // useId's characters (":" in React 18, "«»" in 19) are not safe inside url(#…).
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const bell = `jam-bell-${id}`;
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden focusable="false">
      <defs>
        <linearGradient id={bell} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fbcfe8" />
          <stop offset="55%" stopColor="#f9a8d4" />
          <stop offset="100%" stopColor="#f472b6" />
        </linearGradient>
      </defs>
      <g fill="none" stroke="#fbcfe8" strokeWidth="2.2" strokeLinecap="round">
        <path d="M15 28c-2 3 2 5 0 8s2 5 0 7" />
        <path d="M21 29c-2 3 2 5 0 8s2 4 0 6" />
        <path d="M27 29c2 3-2 5 0 8s-2 4 0 6" />
        <path d="M33 28c2 3-2 5 0 8s-2 5 0 7" />
      </g>
      <path
        d="M7 26a17 17 0 0 1 34 0q-2.125 3-4.25 0q-2.125 3-4.25 0q-2.125 3-4.25 0q-2.125 3-4.25 0q-2.125 3-4.25 0q-2.125 3-4.25 0q-2.125 3-4.25 0q-2.125 3-4.25 0z"
        fill={`url(#${bell})`}
        stroke="#ec4899"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <g fill="#db2777" opacity="0.4">
        <circle cx="17" cy="18" r="2.4" />
        <circle cx="27" cy="13.5" r="1.8" />
        <circle cx="32.5" cy="20" r="2.2" />
        <circle cx="23" cy="22.5" r="1.5" />
      </g>
      <path d="M13 20c1.2-4 4.2-6.8 8-7.6" fill="none" stroke="#fff" strokeOpacity="0.8" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
