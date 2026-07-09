'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';

const STATUS_MESSAGES = [
  'Loading Salaries & Wages',
  'Tallying Contractor payouts',
  'Gathering MESA contributions',
  'Applying PAB & Tech bonuses',
  'Reconciling Time Adjustments',
  'Checking Orphanage budgets',
  'Fetching Gift payments',
  'Computing current pay & FX rate',
];

const PROCESSOR_CHIPS: Array<{ label: string; monogram: string; gradient: string }> = [
  { label: 'Hurupay', monogram: 'Hu', gradient: 'from-orange-500 to-amber-500' },
  { label: 'Higlobe', monogram: 'Hi', gradient: 'from-violet-500 to-fuchsia-500' },
  { label: 'Wise', monogram: 'Wi', gradient: 'from-emerald-500 to-teal-600' },
  { label: 'Jeeves', monogram: 'Je', gradient: 'from-rose-500 to-pink-600' },
  { label: 'Wires', monogram: 'Wr', gradient: 'from-zinc-500 to-slate-600' },
];

// Deterministic width pairs (name, email) — keeps SSR and client renders identical.
const SKELETON_ROWS: Array<[number, number]> = [
  [104, 168],
  [136, 200],
  [120, 152],
  [152, 184],
  [112, 176],
  [128, 160],
  [144, 192],
];

const CYCLE_MS = 1500;
const TICK_MS = 120;
const EXPECTED_MS = 20_000;

export default function DispatchLoader() {
  const [index, setIndex] = useState(0);
  const [percent, setPercent] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % STATUS_MESSAGES.length);
    }, CYCLE_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let elapsed = 0;
    const id = setInterval(() => {
      elapsed += TICK_MS;
      setPercent(Math.min(99, (elapsed / EXPECTED_MS) * 99));
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  return (
    // Positioning context. overflow-hidden clips skeleton rows that extend past
    // the panel height so they don't push the layout.
    <div className="relative h-full min-h-0 flex-1 overflow-hidden bg-gradient-to-b from-white via-orange-50/30 to-white dark:from-[#0d1117] dark:via-[#0d1117] dark:to-[#0d1117]">

      {/* ── Skeleton layer — fills the full panel behind the card ── */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="flex flex-col"
      >
        {/* Skeleton queue header */}
        <div className="border-b border-orange-100/80 bg-gradient-to-r from-white via-orange-50/40 to-white px-4 py-3 sm:px-6 sm:py-4 dark:border-zinc-800 dark:from-zinc-950 dark:via-zinc-950 dark:to-zinc-950">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-col gap-1.5">
              <div className="skeleton-shimmer h-4 w-44 rounded-full" />
              <div className="skeleton-shimmer h-3 w-64 rounded-full" />
            </div>
            <div className="flex items-center gap-2">
              <div className="skeleton-shimmer h-6 w-14 rounded-full" />
              <div className="skeleton-shimmer h-6 w-28 rounded-md" />
              <div className="skeleton-shimmer h-6 w-20 rounded-md" />
            </div>
          </div>
          <div className="mt-3">
            <div className="skeleton-shimmer h-8 w-full rounded-lg" />
          </div>
        </div>

        {/* Skeleton column header row — desktop only */}
        <div className="hidden items-center gap-3 border-b border-orange-100/80 bg-white/90 px-6 py-2 dark:border-zinc-800 dark:bg-zinc-950/90 md:flex">
          <div className="w-9 shrink-0" />
          <div className="skeleton-shimmer h-2.5 w-12 rounded-full" />
          <div className="ml-auto skeleton-shimmer h-2.5 w-20 rounded-full" />
          <div className="skeleton-shimmer h-2.5 w-12 rounded-full" />
          <div className="skeleton-shimmer h-2.5 w-24 rounded-full" />
        </div>

        {/* Skeleton rows */}
        {SKELETON_ROWS.map(([nameW, emailW], i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.25, delay: 0.1 + i * 0.055, ease: 'easeOut' }}
            className="flex items-center gap-3 border-b border-zinc-100/80 px-4 py-3 last:border-0 sm:px-6 dark:border-zinc-800/60"
          >
            <div className="skeleton-shimmer h-9 w-9 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-1.5">
              <div className="skeleton-shimmer h-3 rounded-full" style={{ width: nameW }} />
              <div className="skeleton-shimmer h-2.5 rounded-full" style={{ width: emailW }} />
            </div>
            <div className="hidden items-center sm:flex">
              <div className="skeleton-shimmer h-3 w-16 rounded-full" />
            </div>
            <div className="hidden items-center md:flex">
              <div className="skeleton-shimmer h-3 w-10 rounded-full" />
            </div>
            <div className="skeleton-shimmer h-7 w-24 rounded-lg" />
          </motion.div>
        ))}
      </motion.div>

      {/* ── Loading card — floats above the skeleton ── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-6 pt-8">
        <motion.div
          initial={{ opacity: 0, y: 12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="pointer-events-auto w-full max-w-md rounded-2xl border border-orange-100/80 bg-white/90 p-8 shadow-[0_8px_40px_-12px_rgba(234,88,12,0.25)] backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/80 dark:shadow-[0_8px_40px_-12px_rgba(0,0,0,0.6)]"
        >
          {/* Pulsing wallet emblem with concentric rings */}
          <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
            {[0, 1].map((ring) => (
              <motion.span
                key={ring}
                className="absolute inset-0 rounded-full border border-orange-300/60 dark:border-orange-500/40"
                initial={{ scale: 0.6, opacity: 0.7 }}
                animate={{ scale: 1.8, opacity: 0 }}
                transition={{
                  duration: 1.8,
                  repeat: Infinity,
                  ease: 'easeOut',
                  delay: ring * 0.9,
                }}
              />
            ))}
            <motion.div
              className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-orange-500 to-amber-500 text-white shadow-md"
              animate={{ scale: [1, 1.06, 1] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
            >
              <Wallet className="h-7 w-7" />
            </motion.div>
          </div>

          <h2 className="mt-5 text-center text-base font-semibold text-zinc-900 dark:text-zinc-100">
            Preparing the dispatch queue
          </h2>

          {/* Cycling status line */}
          <div className="relative mt-2 flex h-6 items-center justify-center overflow-hidden">
            <AnimatePresence mode="wait">
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="flex items-center gap-2 text-sm text-orange-600 dark:text-orange-400"
              >
                <span className="inline-flex gap-0.5">
                  {[0, 1, 2].map((d) => (
                    <motion.span
                      key={d}
                      className="h-1 w-1 rounded-full bg-orange-500 dark:bg-orange-400"
                      animate={{ opacity: [0.3, 1, 0.3] }}
                      transition={{
                        duration: 0.9,
                        repeat: Infinity,
                        ease: 'easeInOut',
                        delay: d * 0.15,
                      }}
                    />
                  ))}
                </span>
                <span className="font-medium">{STATUS_MESSAGES[index]}</span>
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Determinate progress bar */}
          <div className="mt-5">
            <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-zinc-400 dark:text-zinc-500">
              <span>Loading</span>
              <span className="tabular-nums text-orange-600 dark:text-orange-400">
                {Math.round(percent)}%
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-orange-100/70 dark:bg-zinc-800">
              <motion.div
                className="relative h-full rounded-full bg-gradient-to-r from-orange-400 to-amber-500"
                animate={{ width: `${percent}%` }}
                transition={{ duration: TICK_MS / 1000, ease: 'linear' }}
              >
                <motion.span
                  className="absolute inset-0 bg-gradient-to-r from-transparent via-white/50 to-transparent"
                  animate={{ x: ['-100%', '180%'] }}
                  transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
                />
              </motion.div>
            </div>
          </div>

          {/* Pay processors roster */}
          <div className="mt-6">
            <p className="text-center text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
              Loading pay processors
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              {PROCESSOR_CHIPS.map((p, i) => (
                <motion.div
                  key={p.label}
                  initial={{ opacity: 0, scale: 0.8, y: 6 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: 0.2 + i * 0.08, ease: 'easeOut' }}
                  className="flex items-center gap-1.5 rounded-full border border-zinc-200/80 bg-white py-1 pl-1 pr-2.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <motion.span
                    className={cn(
                      'flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br text-[9px] font-bold text-white',
                      p.gradient,
                    )}
                    animate={{ scale: [1, 1.12, 1] }}
                    transition={{
                      duration: 1.6,
                      repeat: Infinity,
                      ease: 'easeInOut',
                      delay: i * 0.18,
                    }}
                  >
                    {p.monogram}
                  </motion.span>
                  <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                    {p.label}
                  </span>
                </motion.div>
              ))}
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
