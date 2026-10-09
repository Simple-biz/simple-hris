'use client';

/**
 * The Overview's database signal (Kane, 2026-10-09: *"a 3 bar signal and an MS on our DATABASE connection 3rd bar in
 * green should be blinking"*, *"1 bar being red and 2 bar being orange"*). Three bars and the server's round trip to the
 * database in ms (db-signal.ts holds the lines; accounting-scoreboard.md § Database signal holds the rules).
 *
 * It pings only while it is on screen and the browser tab is visible: every 30 s, and once when the tab comes back. A
 * ping is one 1-row read, because the database's load grows with every open screen (item 416). Reduced motion keeps the
 * 3rd bar lit instead of blinking: the signal stays, only the motion stops (ui-standards).
 */

import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import {
  DB_PING_EVERY_MS,
  judgeDbPing,
  signalForFailedRoute,
  type DbPing,
  type DbSignal as Signal,
  type DbTone,
} from '@/lib/accounting-scoreboard/db-signal';
import { api } from './shared';

/** The browser gives up on a ping here (the server already stops waiting on the database at 3 s). */
const BROWSER_TIMEOUT_MS = 8000;

const BAR_HEIGHT = ['h-1.5', 'h-2.5', 'h-3.5'] as const;

const LIT: Record<DbTone, string> = {
  green: 'bg-emerald-500 dark:bg-emerald-400',
  orange: 'bg-orange-500 dark:bg-orange-400',
  red: 'bg-red-500 dark:bg-red-400',
};
const TEXT: Record<DbTone, string> = {
  green: 'text-emerald-700 dark:text-emerald-400',
  orange: 'text-orange-700 dark:text-orange-300',
  red: 'text-red-700 dark:text-red-400',
};

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' });

export function DbSignal({ className }: { className?: string }) {
  const reduce = useReducedMotion() ?? false;
  const [signal, setSignal] = useState<Signal | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let inFlight: AbortController | null = null;

    async function ping() {
      if (document.visibilityState !== 'visible') return;
      inFlight?.abort();
      const ctrl = new AbortController();
      inFlight = ctrl;
      const giveUp = window.setTimeout(() => ctrl.abort(), BROWSER_TIMEOUT_MS);
      const res = await api<DbPing>('/api/accounting-scoreboard/ping', { signal: ctrl.signal });
      window.clearTimeout(giveUp);
      // Unmounted, or superseded by a newer ping: this answer is no one's.
      if (!alive || inFlight !== ctrl) return;
      if (res.ok) {
        setSignal(judgeDbPing(res.data));
        setCheckedAt(res.data.checkedAt);
      } else {
        setSignal(signalForFailedRoute(res.status));
        setCheckedAt(new Date().toISOString());
      }
    }

    void ping();
    const every = window.setInterval(() => void ping(), DB_PING_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void ping();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      inFlight?.abort();
      window.clearInterval(every);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const tone = signal?.tone ?? null;
  const reading = signal ? (signal.ms !== null ? `${signal.ms} ms` : signal.word) : 'Checking…';
  const title = signal
    ? `${signal.sentence}${checkedAt ? ` Checked ${TIME.format(new Date(checkedAt))} ET, every 30 seconds.` : ''}`
    : 'Checking the database connection…';

  return (
    <div
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center gap-2 rounded-full border border-zinc-200 bg-white/80 px-2.5 py-1 text-[11px] dark:border-zinc-800 dark:bg-zinc-900/60',
        className,
      )}
    >
      {/* Screen readers hear the state when it changes, never every 30 s tick of the ms. */}
      <span className="sr-only" aria-live="polite">
        {signal ? `Database connection: ${signal.word}.` : 'Checking the database connection.'}
      </span>
      <span aria-hidden className="flex h-3.5 items-end gap-[2px]">
        {BAR_HEIGHT.map((height, i) => {
          const lit = signal !== null && i < signal.bars;
          const cls = cn('block w-[3px] rounded-[1px] transition-colors duration-300', height, lit && tone ? LIT[tone] : 'bg-zinc-300 dark:bg-zinc-700');
          // The 3rd bar blinks only when all three are lit (green): the live, healthy heartbeat.
          if (signal?.bars === 3 && i === 2 && !reduce) return <BlinkingBar key={i} className={cls} />;
          return <span key={i} className={cls} />;
        })}
      </span>
      <span aria-hidden className="font-medium text-zinc-600 dark:text-zinc-300">Database</span>
      <span aria-hidden className={cn('font-semibold tabular-nums', tone ? TEXT[tone] : 'text-zinc-400')}>{reading}</span>
    </div>
  );
}

/**
 * The healthy heartbeat: one Web Animation (the board's own tool for its flashes, `sweep` in shared.tsx), cancelled when
 * the bar stops being the 3rd of three green bars. Never mounted under reduced motion.
 */
function BlinkingBar({ className }: { className: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.animate !== 'function') return;
    const blink = el.animate([{ opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }], {
      duration: 1200,
      iterations: Infinity,
      easing: 'ease-in-out',
    });
    return () => blink.cancel();
  }, []);
  return <span ref={ref} className={className} />;
}
