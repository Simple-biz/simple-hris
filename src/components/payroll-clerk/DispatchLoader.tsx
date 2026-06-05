'use client';

import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Branded loading box for the Payment Dispatch queue. While `computeCurrentPay`
 * and the rates/ids/dispatches fetches resolve, this shows a cycling status
 * line (one payroll-wizard concept at a time) plus the roster of pay processors
 * animating in — so the wait reads as "assembling the whole payroll" rather than
 * a blank stall.
 */

// Each line names a slice of what the dispatch computation pulls together —
// roughly mirrors the Payroll Wizard's tabs so the operator recognises them.
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

// Visual identity for each processor chip. Monogram + gradient only — no asset
// fetches, so the loader never waits on anything itself.
const PROCESSOR_CHIPS: Array<{ label: string; monogram: string; gradient: string }> = [
  { label: 'Hurupay', monogram: 'Hu', gradient: 'from-orange-500 to-amber-500' },
  { label: 'Wepay', monogram: 'We', gradient: 'from-sky-500 to-blue-600' },
  { label: 'Higlobe', monogram: 'Hi', gradient: 'from-violet-500 to-fuchsia-500' },
  { label: 'Wise', monogram: 'Wi', gradient: 'from-emerald-500 to-teal-600' },
  { label: 'Jeeves', monogram: 'Je', gradient: 'from-rose-500 to-pink-600' },
  { label: 'Wires', monogram: 'Wr', gradient: 'from-zinc-500 to-slate-600' },
];

const CYCLE_MS = 1500;
const TICK_MS = 120;
// The dispatch load is expected to take roughly this long, so we pace the bar
// to reach ~99% right around the 20s mark — it climbs steadily instead of
// sprinting to 99% and parking there. If the load overruns, the bar holds at
// 99% (never a fake 100%) until the data lands and the loader unmounts.
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

  // Time-based linear climb: elapsed / EXPECTED_MS maps to 0 → 99%.
  useEffect(() => {
    let elapsed = 0;
    const id = setInterval(() => {
      elapsed += TICK_MS;
      setPercent(Math.min(99, (elapsed / EXPECTED_MS) * 99));
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-gradient-to-b from-white via-orange-50/30 to-white px-6 py-10 dark:from-[#0d1117] dark:via-[#0d1117] dark:to-[#0d1117]">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="w-full max-w-md rounded-2xl border border-orange-100/80 bg-white/90 p-8 shadow-[0_8px_40px_-12px_rgba(234,88,12,0.25)] backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/80 dark:shadow-[0_8px_40px_-12px_rgba(0,0,0,0.6)]"
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

        {/* Determinate progress 0% → 100% */}
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
              {/* travelling sheen over the filled portion */}
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
  );
}
