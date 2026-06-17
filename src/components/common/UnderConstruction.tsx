'use client';

import { motion } from 'motion/react';
import { Construction, HardHat, Wrench } from 'lucide-react';

interface UnderConstructionProps {
  /** The page/tab name, e.g. "Payment Dispatch". */
  title?: string;
  /** Optional sub-message; a sensible default is used when omitted. */
  note?: string;
}

/**
 * Full-bleed "this page is under construction" placeholder shown in place of a
 * dashboard tab that an admin marked `construction` in the Pages settings
 * (see {@link file://../../lib/pages/visibility.ts}). Self-contained, light-first
 * with dark variants, and uses only hardcoded palette utilities (the app's
 * semantic Tailwind tokens are not wired).
 */
export default function UnderConstruction({ title, note }: UnderConstructionProps) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-[#fafaf8] px-6 py-12 dark:bg-[#0d1117]">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-md overflow-hidden rounded-3xl border border-amber-200/80 bg-white shadow-xl shadow-amber-600/10 dark:border-amber-500/20 dark:bg-zinc-950"
      >
        {/* Hazard-stripe header band */}
        <div
          className="h-3 w-full"
          style={{
            backgroundImage:
              'repeating-linear-gradient(45deg, #f59e0b 0, #f59e0b 14px, #18181b 14px, #18181b 28px)',
          }}
          aria-hidden
        />

        <div className="relative px-8 py-10 text-center">
          {/* Soft glow blobs */}
          <div
            className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-amber-300/25 blur-3xl dark:bg-amber-500/10"
            aria-hidden
          />
          <div
            className="pointer-events-none absolute -bottom-16 -left-10 h-40 w-40 rounded-full bg-orange-200/30 blur-3xl dark:bg-orange-500/10"
            aria-hidden
          />

          {/* Animated badge */}
          <div className="relative mx-auto mb-6 flex h-24 w-24 items-center justify-center">
            <motion.span
              className="absolute inset-0 rounded-2xl bg-amber-400/20 dark:bg-amber-500/15"
              animate={{ scale: [1, 1.12, 1], opacity: [0.6, 0.25, 0.6] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
              aria-hidden
            />
            <div className="relative flex h-20 w-20 items-center justify-center rounded-2xl border border-amber-300/70 bg-gradient-to-br from-amber-400 to-orange-500 shadow-lg shadow-amber-600/30">
              <motion.div
                animate={{ rotate: [-9, 9, -9] }}
                transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
              >
                <HardHat className="h-10 w-10 text-white" strokeWidth={1.75} />
              </motion.div>
            </div>
            {/* Spinning wrench accent */}
            <motion.div
              className="absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-full border border-amber-200 bg-white shadow-md dark:border-amber-500/30 dark:bg-zinc-900"
              animate={{ rotate: 360 }}
              transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
              aria-hidden
            >
              <Wrench className="h-4 w-4 text-amber-500" />
            </motion.div>
          </div>

          <div className="relative">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
              <Construction className="h-3 w-3" />
              Under Construction
            </span>

            <h2 className="mt-4 text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
              {title ? title : 'This page'} is being built
            </h2>

            <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
              {note ??
                "We're putting the finishing touches on this section. It'll be back online shortly — thanks for your patience."}
            </p>
          </div>

          {/* Indeterminate progress shimmer */}
          <div className="relative mx-auto mt-7 h-1.5 w-48 overflow-hidden rounded-full bg-amber-100 dark:bg-amber-500/10">
            <motion.div
              className="h-full w-1/3 rounded-full bg-gradient-to-r from-amber-400 to-orange-500"
              animate={{ x: ['-110%', '320%'] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
            />
          </div>
        </div>
      </motion.div>
    </div>
  );
}
