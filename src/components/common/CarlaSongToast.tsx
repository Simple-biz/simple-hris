'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Volume2, VolumeX, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  CARLA_SONG_ARTIST,
  CARLA_SONG_TITLE,
  CARLA_SONG_TOTAL_SECONDS,
  getCarlaSongElapsedSeconds,
  getCarlaSongServerState,
  getCarlaSongState,
  stopCarlaSong,
  subscribeCarlaSong,
  toggleCarlaSongMuted,
} from '@/lib/sound/carla-song';

// Real cover art can be dropped at public/carla-song-thumb.jpg; until then the
// committed retro-sunset SVG stands in (and also covers a failed jpg load).
const THUMB_PRIMARY = '/carla-song-thumb.jpg';
const THUMB_FALLBACK = '/carla-song-thumb.svg';

/**
 * "Now playing" pill for Carla's sign-in song — mounted ONCE in the root
 * layout so it survives dashboard switches (client-side navigations never
 * remount the root layout). Renders nothing until the carla-song module
 * actually starts playing, then floats top-center above every dashboard,
 * including the full-screen switch loader (z-[100]) and the collab chrome
 * (z-[120]). Sound is on by default; the speaker button mutes/unmutes and
 * the ✕ stops the song outright.
 *
 * Deliberately NOT a sonner toast: each dashboard mounts its own <Toaster>
 * on top of the root one, so a sonner toast would render duplicated — and
 * none of them would outlive a route change.
 */
export default function CarlaSongToast() {
  const state = useSyncExternalStore(subscribeCarlaSong, getCarlaSongState, getCarlaSongServerState);
  const active = state.status === 'playing' || state.status === 'blocked';

  // Keep the pill in the DOM briefly after the song ends so it can fade out
  // instead of popping away.
  const [shown, setShown] = useState(false);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (active) {
      setShown(true);
      setLeaving(false);
      return;
    }
    if (!shown) return;
    setLeaving(true);
    const t = window.setTimeout(() => {
      setShown(false);
      setLeaving(false);
    }, 380);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Progress bar drive — poll the audio element while playing.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (state.status !== 'playing') return;
    setElapsed(getCarlaSongElapsedSeconds());
    const t = window.setInterval(() => setElapsed(getCarlaSongElapsedSeconds()), 250);
    return () => window.clearInterval(t);
  }, [state.status]);

  const [thumbSrc, setThumbSrc] = useState(THUMB_PRIMARY);

  if (!shown) return null;

  const blocked = state.status === 'blocked';
  const progressPct = Math.min(100, (elapsed / CARLA_SONG_TOTAL_SECONDS) * 100);

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[200] flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        className={cn(
          'carla-song-pill pointer-events-auto relative flex max-w-[92vw] items-center gap-3 overflow-hidden rounded-2xl border border-white/70 bg-white/85 py-2.5 pl-3 pr-2 shadow-[0_18px_50px_rgba(15,23,42,0.18)] backdrop-blur-xl transition-all duration-300 ease-out dark:border-white/10 dark:bg-zinc-900/85',
          leaving && '-translate-y-2 opacity-0',
        )}
      >
        <img
          src={thumbSrc}
          alt={`${CARLA_SONG_TITLE} cover art`}
          className="h-10 w-10 shrink-0 rounded-lg object-cover ring-1 ring-black/5 dark:ring-white/10"
          onError={() => {
            if (thumbSrc !== THUMB_FALLBACK) setThumbSrc(THUMB_FALLBACK);
          }}
        />

        <div className="min-w-0">
          <div
            className={cn(
              'flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.18em]',
              blocked ? 'text-orange-500' : 'text-zinc-400 dark:text-zinc-500',
            )}
          >
            {blocked ? 'Tap anywhere for sound' : 'Now playing'}
            {!blocked && (
              <span className="carla-eq" data-paused={state.muted ? 'true' : 'false'} aria-hidden>
                <span />
                <span />
                <span />
              </span>
            )}
          </div>
          <div className="truncate text-[13px] font-semibold leading-5 text-zinc-900 dark:text-zinc-50">
            {CARLA_SONG_TITLE}
            <span className="font-normal text-zinc-500 dark:text-zinc-400"> · {CARLA_SONG_ARTIST}</span>
          </div>
        </div>

        <div className="ml-1 flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={toggleCarlaSongMuted}
            aria-label={state.muted ? 'Unmute song' : 'Mute song'}
            title={state.muted ? 'Unmute' : 'Mute'}
            className={cn(
              'inline-flex h-8 w-8 items-center justify-center rounded-full border transition',
              state.muted
                ? 'border-zinc-200 bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400'
                : 'border-orange-200 bg-orange-50 text-orange-600 hover:bg-orange-100 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-400',
            )}
          >
            {state.muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={stopCarlaSong}
            aria-label="Stop song"
            title="Stop"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* 30-second progress line along the bottom edge of the pill.
            scaleX (not width) so the 4×/sec updates stay compositor-only. */}
        <div className="absolute inset-x-0 bottom-0 h-[3px] bg-zinc-200/50 dark:bg-zinc-700/50" aria-hidden>
          <div
            className="h-full w-full origin-left bg-gradient-to-r from-orange-400 to-orange-500 transition-transform duration-300 ease-linear"
            style={{ transform: `scaleX(${progressPct / 100})` }}
          />
        </div>
      </div>

      <style jsx>{`
        .carla-eq {
          display: inline-flex;
          align-items: flex-end;
          gap: 2px;
          height: 10px;
        }
        /* Meter bars keep a fixed height and oscillate via scaleY from the
           baseline — compositor-only, no layout work per frame. */
        .carla-eq span {
          width: 2.5px;
          height: 10px;
          border-radius: 1px;
          background: linear-gradient(180deg, #fb923c, #f97316);
          transform: scaleY(0.3);
          transform-origin: bottom;
        }
        .carla-eq[data-paused='true'] span {
          opacity: 0.35;
        }
        @media (prefers-reduced-motion: no-preference) {
          .carla-song-pill {
            animation: carla-toast-in 0.42s cubic-bezier(0.22, 1, 0.36, 1);
          }
          .carla-eq[data-paused='false'] span {
            animation: carla-eq-play 0.9s ease-in-out infinite;
          }
          .carla-eq span:nth-child(2) {
            animation-delay: 0.18s;
          }
          .carla-eq span:nth-child(3) {
            animation-delay: 0.36s;
          }
        }
        @keyframes carla-toast-in {
          from {
            opacity: 0;
            transform: translateY(-10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes carla-eq-play {
          0%,
          100% {
            transform: scaleY(0.3);
          }
          50% {
            transform: scaleY(1);
          }
        }
      `}</style>
    </div>
  );
}
