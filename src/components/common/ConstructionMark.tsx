'use client';

import { Construction } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Small amber marker rendered next to a sidebar nav item whose page an admin
 * marked `construction` in Pages settings (see
 * {@link file://../../lib/pages/visibility.ts}). Signals the tab is still
 * reachable but shows an "Under Construction" placeholder when opened.
 *
 * `active` should be true when the nav item is the selected tab so the marker
 * reads against the highlighted (usually white-on-accent) background.
 */
export default function ConstructionMark({ active = false }: { active?: boolean }) {
  return (
    <span
      className={cn(
        'ml-1 inline-flex shrink-0 items-center',
        active ? 'text-white/85' : 'text-amber-500 dark:text-amber-400',
      )}
      title="Under construction"
      aria-label="Under construction"
    >
      <Construction className="h-3.5 w-3.5" />
    </span>
  );
}
