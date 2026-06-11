'use client';

import { Eye } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Wraps a dashboard tab's content and makes the whole subtree non-interactive
 * when the viewer only has `view` (not `edit`) access to that feature.
 *
 * Uses the native React-19 `inert` attribute, which neutralizes ALL
 * interaction in the subtree -- form controls, links, and custom `onClick`
 * divs alike -- so we don't have to thread a `disabled` prop through hundreds
 * of individual controls. A thin banner tells the user why nothing responds.
 *
 * `inert` only reaches nodes that are actually inside this subtree; dialogs
 * portaled to `document.body` escape it, so a read-only tab must also keep its
 * dialog trigger button inside this wrapper (the trigger then can't be clicked
 * to open the portal). The server-side feature check is the authoritative
 * guard regardless.
 */
export default function ReadOnlyTab({
  readOnly,
  children,
  className,
}: {
  readOnly: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  if (!readOnly) return <>{children}</>;
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-amber-200/80 bg-amber-50/90 px-4 py-2 text-[12px] font-medium text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
        <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden />
        View only &mdash; you don&apos;t have edit access to this tab.
      </div>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- inert is a valid React 19 boolean prop */}
      <div inert={true as any} aria-disabled className="flex min-h-0 flex-1 flex-col opacity-95">
        {children}
      </div>
    </div>
  );
}
