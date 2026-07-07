'use client';

import { Construction } from 'lucide-react';

/**
 * Slim "still under construction" banner shown at the top of a page that an
 * admin is viewing via the admin bypass (see {@link file://../../hooks/usePagesVisibility.ts}).
 *
 * Non-admins never see this — they get the full {@link ./UnderConstruction}
 * placeholder instead. This is purely the reminder that, while the admin can see
 * the real page, it is NOT yet live for everyone else.
 */
export default function ConstructionBanner({ title }: { title?: string }) {
  return (
    <div
      role="status"
      className="sticky top-0 z-20 flex shrink-0 items-center gap-2.5 border-b border-amber-300/70 bg-amber-50/95 px-4 py-1.5 backdrop-blur-sm dark:border-amber-500/25 dark:bg-amber-950/40"
    >
      {/* Hazard-stripe chip echoing the full UnderConstruction graphic */}
      <span
        className="h-2.5 w-7 shrink-0 rounded-[2px]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(45deg, #f59e0b 0, #f59e0b 5px, #18181b 5px, #18181b 10px)',
        }}
        aria-hidden
      />
      <Construction className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <p className="min-w-0 truncate text-[12px] text-amber-900 dark:text-amber-200">
        <span className="font-semibold">Under construction</span>
        {title ? <> — &ldquo;{title}&rdquo; isn&apos;t live for others yet.</> : ' — not live for others yet.'}{' '}
        <span className="text-amber-700/90 dark:text-amber-300/80">You can see it because you&apos;re an admin.</span>
      </p>
    </div>
  );
}
