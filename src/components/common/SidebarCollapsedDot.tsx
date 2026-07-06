'use client';

import React from 'react';
import { cn } from '@/lib/utils';

/**
 * A compact attention dot for a *collapsed* rail's nav icon.
 *
 * When the rail narrows to 64px, the full inline badge (unread count, setup
 * count, lock pip, …) sits at the far right of the still-256px-wide row and is
 * clipped away with everything else past the rail edge — so it silently
 * vanishes. This dot stands in for it: pin it to the top-right corner of the
 * leading icon and it survives the collapse.
 *
 * Visible ONLY at md+ while the rail is collapsed. Below md the rail is a
 * full-width drawer (never truly collapsed), so the full badge shows and this
 * dot stays hidden.
 *
 * Anchor by wrapping the nav icon in a `relative` element:
 *   <span className="relative shrink-0">
 *     <Bell className="h-4 w-4" />
 *     <SidebarCollapsedDot collapsed={collapsed} show={unread > 0} />
 *   </span>
 */
export default function SidebarCollapsedDot({
  collapsed,
  show = true,
  /** Tailwind `bg-*` class for the dot fill (and its ping halo). */
  tone = 'bg-rose-500',
  pulse = true,
  /** Position/size overrides (win over the defaults via tailwind-merge). */
  className,
}: {
  collapsed: boolean;
  show?: boolean;
  tone?: string;
  pulse?: boolean;
  className?: string;
}) {
  if (!show) return null;
  return (
    <span
      aria-hidden
      className={cn(
        // Fade with the rail (opacity, not display, so it crossfades with the
        // outgoing full badge instead of popping). Hidden until collapsed, and
        // only at md+ — the mobile drawer shows the real badge.
        'pointer-events-none absolute -right-1 -top-1 h-2.5 w-2.5 opacity-0 transition-opacity duration-[var(--sb-collapse-ms)] ease-[var(--sb-collapse-ease)]',
        collapsed && 'md:opacity-100',
        className,
      )}
    >
      {pulse && (
        <span className={cn('absolute inset-0 animate-ping rounded-full opacity-70', tone)} />
      )}
      <span className={cn('absolute inset-0 rounded-full ring-2 ring-white dark:ring-[#0d1117]', tone)} />
    </span>
  );
}
