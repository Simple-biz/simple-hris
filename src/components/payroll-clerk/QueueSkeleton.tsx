'use client';

import React from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

/**
 * Skeleton placeholder for the dispatch queue while data is loading. Shape
 * mirrors `ProcessorQueue` (header + list of rows) so the swap-in is
 * imperceptible. Uses a sliding-gradient shimmer plus subtle row stagger.
 */
export default function QueueSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header skeleton */}
      <div className="shrink-0 border-b border-orange-100/80 bg-gradient-to-r from-white via-orange-50/40 to-white px-4 py-3 sm:px-6 sm:py-4 dark:border-zinc-800 dark:from-zinc-950 dark:via-zinc-950 dark:to-zinc-950">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-2">
            <Bar className="h-4 w-32 sm:w-40" />
            <Bar className="h-3 w-48 sm:w-64" delay={0.05} />
          </div>
          <div className="flex items-center gap-2">
            <Bar className="h-5 w-16 rounded-full sm:w-20" delay={0.1} />
            <Bar className="hidden h-5 w-16 rounded-full sm:block" delay={0.15} />
          </div>
        </div>
        <div className="mt-3">
          <Bar className="h-8 w-full max-w-sm rounded-md" delay={0.18} />
        </div>
      </div>

      {/* Rows skeleton */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-gradient-to-b from-white via-orange-50/10 to-white dark:from-[#0d1117] dark:via-[#0d1117] dark:to-[#0d1117]">
        {/* Column header — desktop only */}
        <div className="sticky top-0 z-10 hidden grid-cols-[auto_minmax(0,1.3fr)_140px_140px_120px_auto] items-center gap-3 border-b border-orange-100/80 bg-white/90 px-6 py-2 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/90 md:grid">
          <span className="w-9" aria-hidden />
          <Bar className="h-2.5 w-12 rounded" />
          <Bar className="h-2.5 w-20 rounded" delay={0.05} />
          <Bar className="ml-auto h-2.5 w-14 rounded" delay={0.1} />
          <Bar className="ml-auto h-2.5 w-10 rounded" delay={0.12} />
          <Bar className="ml-auto h-2.5 w-10 rounded" delay={0.15} />
        </div>

        <ul className="divide-y divide-orange-100/70 dark:divide-zinc-800">
          {Array.from({ length: rows }, (_, i) => (
            <li key={i} className="bg-white/90 dark:bg-zinc-950/90">
              {/* Mobile skeleton row */}
              <div className="flex flex-col gap-2.5 px-3 py-3 md:hidden">
                <div className="flex items-start gap-2.5">
                  <Bar className="h-9 w-9 shrink-0 rounded-full" delay={i * 0.04} />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Bar className={cn('h-3.5 rounded', widthFor(i, 'name'))} delay={i * 0.04 + 0.02} />
                    <Bar className={cn('h-3 rounded', widthFor(i, 'email'))} delay={i * 0.04 + 0.04} />
                  </div>
                  <div className="shrink-0 space-y-1.5 text-right">
                    <Bar className="ml-auto h-3.5 w-14 rounded" delay={i * 0.04 + 0.06} />
                    <Bar className="ml-auto h-2.5 w-16 rounded" delay={i * 0.04 + 0.08} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 pl-[2.875rem]">
                  <Bar className="h-4 w-24 rounded-full" delay={i * 0.04 + 0.05} />
                  <Bar className="h-8 w-24 rounded-md" delay={i * 0.04 + 0.11} />
                </div>
              </div>

              {/* Desktop skeleton row */}
              <div className="hidden grid-cols-[auto_minmax(0,1.3fr)_140px_140px_120px_auto] items-center gap-3 px-6 py-3.5 md:grid">
                <Bar className="h-9 w-9 rounded-full" delay={i * 0.04} />
                <div className="min-w-0 space-y-1.5">
                  <Bar className={cn('h-3.5 rounded', widthFor(i, 'name'))} delay={i * 0.04 + 0.02} />
                  <Bar className={cn('h-3 rounded', widthFor(i, 'email'))} delay={i * 0.04 + 0.04} />
                </div>
                <Bar className="h-5 w-20 rounded-full" delay={i * 0.04 + 0.05} />
                <div className="space-y-1.5 text-right">
                  <Bar className="ml-auto h-3.5 w-16 rounded" delay={i * 0.04 + 0.06} />
                  <Bar className="ml-auto h-2.5 w-20 rounded" delay={i * 0.04 + 0.08} />
                </div>
                <div className="space-y-1.5 text-right">
                  <Bar className="ml-auto h-3.5 w-12 rounded" delay={i * 0.04 + 0.07} />
                  <Bar className="ml-auto h-2.5 w-14 rounded" delay={i * 0.04 + 0.09} />
                </div>
                <Bar className="h-8 w-[7.5rem] rounded-md" delay={i * 0.04 + 0.11} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Single shimmer bar — a gradient sweep over a tinted base. */
function Bar({ className, delay = 0 }: { className?: string; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25, delay }}
      className={cn(
        'relative overflow-hidden bg-zinc-200/70 dark:bg-zinc-800/70',
        className,
      )}
    >
      <motion.div
        animate={{ x: ['-100%', '120%'] }}
        transition={{ duration: 1.6, repeat: Infinity, ease: 'linear', delay }}
        className="absolute inset-0 bg-gradient-to-r from-transparent via-white/70 to-transparent dark:via-zinc-700/60"
      />
    </motion.div>
  );
}

/** Vary the placeholder widths a bit so the skeleton doesn't look too uniform. */
function widthFor(i: number, kind: 'name' | 'email') {
  const nameWidths = ['w-32', 'w-44', 'w-36', 'w-40', 'w-28', 'w-48', 'w-36'];
  const emailWidths = ['w-48', 'w-40', 'w-56', 'w-44', 'w-52', 'w-36', 'w-48'];
  return (kind === 'name' ? nameWidths : emailWidths)[i % nameWidths.length];
}
