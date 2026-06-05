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
  /**
   * When true, the card is wrapped with a pulsing amber halo to flag it as
   * attention-worthy (used by the Urgent tab). The halo is a blurred sibling
   * layer behind the button (outside its `overflow-hidden` clip) animated on
   * opacity + scale, so the pulse stays GPU-composited and smooth at 60fps.
   */
  glowBorder?: boolean;
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
  glowBorder,
}: ProcessorCardProps) {
  const monogram = label.slice(0, 2).toUpperCase();
  const button = (
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
        // Amber edge for the glowing (Urgent) card, regardless of active state.
        glowBorder && '!border-amber-300 dark:!border-amber-500/60',
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
          className={cn('h-8 w-8', glowBorder && 'shadow-[0_2px_10px_-2px_rgba(245,158,11,0.7)]')}
          iconClassName={glowBorder ? 'urgent-zap' : undefined}
        />
        {count !== undefined && (
          <div
            className={cn(
              'rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
              glowBorder
                ? 'bg-amber-100 text-amber-700 ring-1 ring-amber-300/70 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/40'
                : active
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

      {/* Urgent: continuous energy sheen sweeping across the surface. Lives inside
          the button so the overflow-hidden clip keeps it on-card. */}
      {glowBorder && (
        <span
          aria-hidden
          className="urgent-sheen pointer-events-none absolute inset-y-0 left-0 z-[5] w-1/3 bg-gradient-to-r from-transparent via-amber-200/70 to-transparent blur-[2px] dark:via-amber-300/25"
        />
      )}

      {/* Subtle hover sheen */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute -inset-x-10 -top-12 h-24 origin-top rotate-12 rounded-full bg-gradient-to-r from-white/0 via-white/40 to-white/0 opacity-0 blur-xl transition-opacity duration-300 group-hover:opacity-60 dark:via-white/10',
        )}
      />
    </motion.button>
  );

  if (!glowBorder) return button;

  // Pulsing amber halo for the Urgent card. Sits behind the button as a sibling
  // (so the card's own overflow-hidden never clips it). The pulse is a CSS
  // keyframe animation, not motion's JS one: a parent re-render would hand motion
  // a fresh `animate` object every render and restart the loop from frame 0,
  // which made it look frozen. CSS runs on the compositor, immune to re-renders.
  return (
    <span className="relative block h-full w-full">
      {/* Soft amber halo breathing behind the card. */}
      <span
        aria-hidden
        className="urgent-glow-pulse pointer-events-none absolute -inset-2 -z-10 rounded-2xl bg-amber-400/60 blur-lg dark:bg-amber-500/50 will-change-[opacity,transform]"
      />
      {button}
      {/* Rotating conic rim, overlaid on the card's edge (masked to a 1.5px band). */}
      <span
        aria-hidden
        className="urgent-ring pointer-events-none absolute inset-0 rounded-xl will-change-[background]"
      />
    </span>
  );
}
