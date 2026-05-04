'use client';

import React from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import AnimatedNumber from './AnimatedNumber';
import ProcessorLogo from './ProcessorLogo';

export interface ProcessorCardProps {
  label: string;
  /** When omitted, the count badge is hidden — useful for nav-only cards. */
  count?: number;
  /** Subtle blurb under the label. */
  subtitle?: string;
  Icon: React.ComponentType<{ className?: string }>;
  /** Tailwind classes to colour the icon and accent (e.g. "from-orange-500 to-rose-500"). */
  accent: string;
  /** Lighter accent for the active glow. */
  glow: string;
  active: boolean;
  onClick: () => void;
  /**
   * If true, render the passed Icon instead of a letter monogram.
   * Useful for nav cards like "All pending" / "History".
   */
  iconOnlyFallback?: boolean;
}

export default function ProcessorCard({
  label,
  count,
  subtitle,
  Icon,
  accent,
  glow,
  active,
  onClick,
  iconOnlyFallback,
}: ProcessorCardProps) {
  const monogram = label.slice(0, 2).toUpperCase();
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 400, damping: 28 }}
      className={cn(
        'group relative flex h-full min-h-[80px] w-full flex-col items-start gap-1.5 overflow-hidden rounded-xl border p-2.5 text-left',
        'transition-colors duration-200',
        active
          ? 'border-transparent bg-white shadow-[0_6px_18px_-8px_rgba(0,0,0,0.18)] dark:bg-zinc-900'
          : 'border-orange-100 bg-white/70 hover:border-orange-200 hover:bg-white dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:bg-zinc-900',
      )}
      aria-pressed={active}
    >
      {/* Active layout-shared glow */}
      {active && (
        <motion.div
          layoutId="processor-card-glow"
          className={cn(
            'pointer-events-none absolute inset-0 rounded-xl opacity-90',
            'bg-gradient-to-br',
            glow,
          )}
          transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          aria-hidden
        />
      )}
      {active && (
        <motion.div
          layoutId="processor-card-ring"
          className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-inset ring-white/60 dark:ring-zinc-700/60"
          transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          aria-hidden
        />
      )}

      <div className="relative z-10 flex w-full items-center justify-between gap-1.5">
        <ProcessorLogo
          monogram={monogram}
          gradient={accent}
          FallbackIcon={Icon}
          fallback={iconOnlyFallback ? 'icon' : 'monogram'}
          className="h-8 w-8"
        />
        {count !== undefined && (
          <div
            className={cn(
              'rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
              active
                ? 'bg-white/80 text-zinc-900 backdrop-blur-sm dark:bg-zinc-800/80 dark:text-zinc-100'
                : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
            )}
          >
            <AnimatedNumber value={count} />
          </div>
        )}
      </div>

      <div className="relative z-10 min-w-0 leading-tight">
        <div
          className={cn(
            'truncate text-[13px] font-semibold tracking-tight',
            active ? 'text-zinc-900 dark:text-white' : 'text-zinc-800 dark:text-zinc-200',
          )}
        >
          {label}
        </div>
        {subtitle && (
          <div
            className={cn(
              'mt-0.5 truncate text-[10px]',
              active ? 'text-zinc-600 dark:text-zinc-400' : 'text-zinc-400 dark:text-zinc-500',
            )}
          >
            {subtitle}
          </div>
        )}
      </div>

      {/* Subtle hover sheen */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute -inset-x-10 -top-12 h-24 origin-top rotate-12 rounded-full bg-gradient-to-r from-white/0 via-white/40 to-white/0 opacity-0 blur-xl transition-opacity duration-300 group-hover:opacity-60 dark:via-white/10',
        )}
      />
    </motion.button>
  );
}
