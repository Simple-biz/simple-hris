'use client';

import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
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
        'group/collapse absolute -right-3 top-[70px] z-50 hidden h-6 w-6 items-center justify-center',
        'rounded-full border bg-white text-zinc-500 shadow-md ring-1 ring-black/5',
        'transition-all duration-200 ease-out hover:scale-110 hover:text-zinc-900 hover:shadow-lg',
        'focus-visible:outline-none focus-visible:ring-2 md:flex',
        'dark:bg-zinc-900 dark:text-zinc-400 dark:ring-white/10 dark:hover:text-zinc-100',
        className,
      )}
    >
      {collapsed ? (
        <ChevronRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover/collapse:translate-x-px" />
      ) : (
        <ChevronLeft className="h-3.5 w-3.5 transition-transform duration-200 group-hover/collapse:-translate-x-px" />
      )}
    </button>
  );
}
