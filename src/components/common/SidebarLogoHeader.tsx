'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import SidebarBrandMark from './SidebarBrandMark';

interface SidebarLogoHeaderProps {
  /** Desktop rail is collapsed to an icon-only strip. */
  collapsed: boolean;
  /**
   * Gradient utility classes for the collapsed brand-mark icon, e.g.
   * `"from-orange-500 to-amber-600"`. Each rail passes its own accent.
   */
  accentClassName: string;
  /** Logo image alt text. */
  alt?: string;
  /** Delay (ms) before the first heartbeat pulse fires. */
  firstBeatDelayMs?: number;
}

/**
 * The brand header shared by every dashboard rail.
 *
 * Expanded: the full wordmark logo sits in its box (with the neon hover border
 * and the periodic slide-in "heartbeat").
 *
 * Collapsed (desktop only): the entire logo box — white panel, border, and
 * image — fades out and a single compact brand-mark icon fades in, aligned with
 * the nav icon column below. The box is faded as a whole (not just the image),
 * so no white slice or clipped wordmark bleeds into the 64px rail.
 *
 * The heartbeat only runs while expanded: its `forwards`-filled animation would
 * otherwise pin the image back to `opacity:1` and leak the cut-off logo into the
 * collapsed rail.
 */
export default function SidebarLogoHeader({
  collapsed,
  accentClassName,
  alt = 'Simple HRIS',
  firstBeatDelayMs = 1000,
}: SidebarLogoHeaderProps) {
  const [logoBeat, setLogoBeat] = React.useState(false);
  React.useEffect(() => {
    if (collapsed) return; // no pulse while collapsed — the rail is icon-only
    const fire = () => setLogoBeat(true);
    const first = setTimeout(fire, firstBeatDelayMs);
    const interval = setInterval(fire, 12000);
    return () => { clearTimeout(first); clearInterval(interval); };
  }, [collapsed, firstBeatDelayMs]);

  return (
    <div className="relative">
      {/* Expanded: full wordmark logo — the whole box fades out when collapsed. */}
      <a
        href="https://www.simple.biz/"
        target="_blank"
        rel="noopener noreferrer"
        onMouseEnter={() => { if (!collapsed && !logoBeat) setLogoBeat(true); }}
        className={cn(
          'logo-neon block transform-gpu will-change-[opacity] transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]',
          collapsed && 'md:pointer-events-none md:opacity-0',
        )}
      >
        <div className="logo-neon__inner overflow-hidden px-3 py-2 border border-zinc-200 dark:border-black dark:ring-1 dark:ring-white">
          <img
            src="/simple-logo.png"
            alt={alt}
            className={cn('h-10 w-full object-contain', logoBeat && !collapsed && 'logo-heartbeat')}
            onAnimationEnd={() => setLogoBeat(false)}
          />
        </div>
      </a>
      {/* Collapsed: just the brand-mark icon, lined up with the nav icons below.
          Fade-through: the wordmark above only fades, while this icon fades AND
          scales in — so mid-transition you never see both crisply overlapping.
          A short delay lets the wordmark clear out first before the icon lands. */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1 flex origin-left items-center opacity-0 scale-90 transform-gpu will-change-[opacity,transform] transition-[opacity,transform] duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]',
          // Entrance: a touch of delay so the wordmark clears first, then an
          // ease-out glide in — no bounce, no beat fighting it.
          collapsed && 'md:opacity-100 md:scale-100 md:delay-[calc(var(--sb-collapse-ms)/4)] md:duration-[calc(var(--sb-collapse-ms)*3/4)] md:ease-[cubic-bezier(0.22,1,0.36,1)]',
        )}
      >
        <SidebarBrandMark className={accentClassName} beat={collapsed} />
      </div>
    </div>
  );
}
