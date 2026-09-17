'use client';

import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
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
  /**
   * Real brand logo (e.g. "/wise.png"). When set, the tile shows the logo on a
   * white box; otherwise it falls back to the gradient monogram/icon tile.
   */
  logoSrc?: string;
  /**
   * Spell the rail's name out on the fallback tile instead of cutting the label
   * to two initials. For a rail that is OURS rather than a vendor's there is no
   * brand PNG to draw and no vendor whose initials mean anything — "Wires" as
   * "WI" reads like a truncation bug, so the name itself is the wordmark.
   * ProcessorLogo sizes it to the plate. Ignored when `logoSrc` loads.
   */
  wordmark?: string;
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
  /**
   * Squeeze the card down to its logo plate alone: the label, subtitle and
   * inline count fade out and the plate slides into the middle. Used when the
   * app sidebar is expanded and the rail's column is too narrow to carry text
   * as well (PayrollDispatch animates the grid track to match). The text stays
   * in the DOM at `opacity: 0` so the button keeps its accessible name, and the
   * pending count reappears as a corner badge on the plate so nothing is lost.
   *
   * Only the lg+ vertical rail compacts — the mobile strip has its own fixed
   * card width, so callers pass false below lg.
   */
  compact?: boolean;
}

/**
 * Shared easing for the compact/expanded transition. Exported so the grid track
 * that drives the card's width animates on exactly the same curve — two
 * constants would drift and the plate would visibly lag the column.
 */
export const RAIL_COMPACT_TRANSITION = { duration: 0.7, ease: [0.22, 1, 0.36, 1] as const };

/** Gap between the text column and the logo plate, in px. Cancelled by an
 *  animated negative margin when compact so the plate centres exactly. */
const TEXT_PLATE_GAP = 10;

export default function ProcessorCard({
  label,
  count,
  subtitle,
  Icon,
  logoSrc,
  wordmark,
  accent,
  glow,
  active,
  onClick,
  iconOnlyFallback,
  glowBorder,
  compact = false,
}: ProcessorCardProps) {
  const reduceMotion = useReducedMotion();
  const transition = reduceMotion ? { duration: 0 } : RAIL_COMPACT_TRANSITION;
  const monogram = wordmark ?? label.slice(0, 2).toUpperCase();
  const button = (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 400, damping: 28 }}
      className={cn(
        'group relative flex h-full min-h-[72px] w-full items-center overflow-hidden rounded-xl border p-3 text-left',
        'transition-colors duration-200',
        active
          ? 'border-transparent bg-white shadow-[0_6px_18px_-8px_rgba(0,0,0,0.18)] dark:bg-zinc-900'
          : 'border-orange-100 bg-white/70 hover:border-orange-200 hover:bg-white dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:bg-zinc-900',
        // Red glowing edge for the (Urgent) card, regardless of active state.
        glowBorder && '!border-red-400 dark:!border-red-500/70',
      )}
      aria-pressed={active}
      // Compact hides the label, and the icon-only cards (All pending, Done,
      // Excluded, …) have no wordmark to read in its place — so the name comes
      // back on hover. Redundant while the label is visible, hence compact-only.
      title={compact ? label : undefined}
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

      {/* Horizontal layout: text + count on the LEFT, logo tile on the RIGHT. */}
      <div className="relative z-10 flex w-full items-center" style={{ gap: TEXT_PLATE_GAP }}>
        {/* The text column is `flex-1 min-w-0` against a `shrink-0` plate, so it
            gives up its width to the plate as the card narrows — the column
            animation alone drives the squeeze and nothing here has to animate a
            width. It only has to stop being readable on the way, hence the
            opacity fade, and give back the gap it no longer separates anything
            across, hence the negative margin. Both ride the same curve as the
            grid track, so the plate glides instead of snapping at the end. */}
        <motion.div
          className="min-w-0 flex-1 leading-tight"
          initial={false}
          animate={{ opacity: compact ? 0 : 1, marginRight: compact ? -TEXT_PLATE_GAP : 0 }}
          transition={transition}
        >
          <div className="flex items-center gap-1.5">
            <div
              className={cn(
                'truncate text-sm font-semibold tracking-tight',
                active ? 'text-zinc-900 dark:text-white' : 'text-zinc-800 dark:text-zinc-200',
              )}
            >
              {label}
            </div>
            {count !== undefined && (
              <div
                className={cn(
                  'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
                  glowBorder
                    ? 'bg-red-100 text-red-700 ring-1 ring-red-300/70 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/40'
                    : active
                      ? 'bg-white/80 text-zinc-900 backdrop-blur-sm dark:bg-zinc-800/80 dark:text-zinc-100'
                      : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
                )}
              >
                <AnimatedNumber value={count} />
              </div>
            )}
          </div>
          {subtitle && (
            <div
              className={cn(
                'mt-0.5 truncate text-[11px]',
                active ? 'text-zinc-600 dark:text-zinc-400' : 'text-zinc-400 dark:text-zinc-500',
              )}
            >
              {subtitle}
            </div>
          )}
        </motion.div>
        <div className="relative shrink-0">
          <ProcessorLogo
            monogram={monogram}
            gradient={accent}
            FallbackIcon={Icon}
            logoSrc={logoSrc}
            fallback={iconOnlyFallback ? 'icon' : 'monogram'}
            // Every card uses the same wide plate on the right — real wordmark
            // logos read at size, and the icon/monogram fallbacks match so the
            // whole rail stays uniform.
            className={cn('h-11 w-[80px]', glowBorder && 'shadow-[0_2px_10px_-2px_rgba(239,68,68,0.7)]')}
            iconClassName={glowBorder ? 'urgent-zap' : undefined}
          />
          {/* Compact parks the count on the plate's corner so the squeeze costs
              no information. Zero is left off on purpose — an empty bucket has
              nothing to report, and a rail of "0" pills would bury the one
              number that matters. The ring is the card's own surface colour, so
              the pill reads as sitting above the plate rather than on it. */}
          {count !== undefined && count > 0 && (
            <motion.span
              className={cn(
                'pointer-events-none absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none tabular-nums ring-2',
                glowBorder
                  ? 'bg-red-600 text-white ring-white dark:bg-red-500 dark:ring-zinc-900'
                  : 'bg-zinc-900 text-white ring-white dark:bg-white dark:text-zinc-900 dark:ring-zinc-900',
              )}
              initial={false}
              animate={{ opacity: compact ? 1 : 0, scale: compact ? 1 : 0.6 }}
              transition={transition}
              aria-hidden
            >
              <AnimatedNumber value={count} />
            </motion.span>
          )}
        </div>
      </div>

      {/* Urgent: continuous energy sheen sweeping across the surface. Lives inside
          the button so the overflow-hidden clip keeps it on-card. */}
      {glowBorder && (
        <span
          aria-hidden
          className="urgent-sheen pointer-events-none absolute inset-y-0 left-0 z-[5] w-1/3 bg-gradient-to-r from-transparent via-red-300/70 to-transparent blur-[2px] dark:via-red-400/25"
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
      {/* Soft red halo breathing behind the card. */}
      <span
        aria-hidden
        className="urgent-glow-pulse pointer-events-none absolute -inset-2 -z-10 rounded-2xl bg-red-500/60 blur-lg dark:bg-red-500/50 will-change-[opacity,transform]"
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
