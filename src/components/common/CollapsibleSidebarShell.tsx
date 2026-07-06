'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import SidebarCollapseToggle from './SidebarCollapseToggle';

interface CollapsibleSidebarShellProps {
  collapsed: boolean;
  onToggle: () => void;
  /**
   * The rail's own className (theme colours, borders, mobile drawer width,
   * fixed/translate positioning, and a transition list that INCLUDES `width`).
   * The shell layers on `md:relative` (positioning context for the pull-tab and
   * the clip layer) and the collapsed rail width.
   */
  className?: string;
  /**
   * Desktop expanded width for the inner panel — must match the rail's expanded
   * width, e.g. `md:w-[220px]` (compact rails) or `md:w-64` (padded rails). The
   * panel keeps this fixed width at md+ so its contents never re-flow while the
   * rail animates; the rail simply clips it.
   */
  innerWidthClassName: string;
  /** Accent classes for the pull-tab handle. */
  accentClassName?: string;
  /** Rendered element — most rails use <aside>; the Accounting rail is a <div>. */
  as?: 'aside' | 'div';
  id?: string;
  ariaLabel?: string;
  children: React.ReactNode;
}

/**
 * Smooth collapsible rail shell shared by every dashboard sidebar.
 *
 * Why it's smooth: the animated element (the rail) only changes `width`, while
 * ALL of its content lives in a fixed-width inner panel that is clipped by the
 * rail. Because the panel's width never changes, nothing inside it re-lays-out
 * during the animation — the browser just moves a clip rectangle and composites.
 * Labels then fade with `opacity` (compositor-only) rather than `display:none`,
 * so they slide away instead of popping. Icons sit at the panel's left edge and
 * stay put, so they remain visible in the collapsed rail.
 *
 * Collapse is desktop-only: on mobile the rail is a full-width drawer, so the
 * collapsed width and every `md:opacity-0` label fade are scoped to `md:` and
 * have no effect below that breakpoint.
 */
export default function CollapsibleSidebarShell({
  collapsed,
  onToggle,
  className,
  innerWidthClassName,
  accentClassName,
  as = 'aside',
  id,
  ariaLabel,
  children,
}: CollapsibleSidebarShellProps) {
  const Tag = as;
  return (
    <Tag
      id={id}
      role="navigation"
      aria-label={ariaLabel}
      data-collapsible-rail=""
      data-collapsed={collapsed ? 'true' : 'false'}
      className={cn(
        className,
        // Positioning context (so the absolute pull-tab + clip layer anchor here)
        // and let the pull-tab overhang the right border without being clipped.
        'overflow-visible md:relative',
        // Lift the whole rail above the adjacent <main> on desktop. The rail is
        // its own stacking context (transform-gpu), so the pull-tab's own z-index
        // is trapped inside it and can't beat <main>'s content (its animated tab
        // panels each form a stacking context that would otherwise paint over the
        // 12px overhang). Raising the rail itself is what keeps the handle visible.
        // Mobile keeps its higher drawer z-index (the rail's own base `z-50`).
        'md:z-30',
        // Desktop rail slide timing — overrides the per-rail base duration/easing
        // (kept for the mobile drawer) with the shared, gently-eased collapse feel.
        'md:duration-[var(--sb-collapse-ms)] md:ease-[var(--sb-collapse-ease)]',
        // Collapsed rail width — desktop only.
        collapsed && 'md:w-16',
      )}
    >
      <SidebarCollapseToggle collapsed={collapsed} onToggle={onToggle} className={accentClassName} />
      <div className="absolute inset-0 overflow-hidden">
        <div className={cn('flex h-full min-h-0 w-full flex-col', innerWidthClassName)}>
          {children}
        </div>
      </div>
    </Tag>
  );
}
