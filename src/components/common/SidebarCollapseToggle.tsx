'use client';

import React from 'react';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SidebarCollapseToggleProps {
  collapsed: boolean;
  onToggle: () => void;
  /**
   * Accent classes for the pull-tab (border / hover / ring / focus colours) so
   * each dashboard's rail keeps its own identity. The parent `<aside>` must be a
   * positioning context on desktop (`md:relative`) for this to anchor correctly.
   */
  className?: string;
}

/**
 * The pull-tab that collapses / expands a dashboard sidebar. It hugs the rail's
 * right border (slightly overhanging) so it reads as a physical handle you can
 * pull the sidebar back and forth with. Desktop-only — the mobile drawer uses
 * the hamburger + overlay instead.
 */
export default function SidebarCollapseToggle({
  collapsed,
  onToggle,
  className,
}: SidebarCollapseToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      aria-pressed={collapsed}
      title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      className={cn(
        // Overhangs the rail's right border so it reads as a physical handle on
        // the seam, half over the rail and half over the content. The rail is
        // lifted above <main> (see CollapsibleSidebarShell), so this z-50 keeps
        // the handle above the rail's own contents and it never hides behind
        // adjacent content.
        'group/collapse absolute -right-3.5 top-[68px] z-50 hidden h-7 w-7 items-center justify-center',
        'rounded-full border bg-white text-zinc-500 shadow-lg ring-1 ring-black/5',
        // Scoped (not `transition-all`) so only the handle's own affordances ease
        // — nothing fights the rail's width slide.
        'transition-[transform,color,box-shadow] duration-200 ease-out motion-reduce:transition-none',
        'hover:scale-110 hover:text-zinc-900 hover:shadow-xl',
        'focus-visible:outline-none focus-visible:ring-2 md:flex',
        'dark:bg-zinc-900 dark:text-zinc-400 dark:ring-white/10 dark:hover:text-zinc-100',
        className,
      )}
    >
      {/* One chevron that rotates for direction, so the state flip eases in
          instead of the two-icon swap popping. Points left to collapse, right
          (rotated) to expand. */}
      <ChevronLeft
        aria-hidden
        className={cn(
          'h-4 w-4 transition-transform duration-200 ease-out motion-reduce:transition-none',
          collapsed && 'rotate-180',
        )}
      />
    </button>
  );
}
