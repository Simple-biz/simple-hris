'use client';

/**
 * The search box every My Team Rankings view carries (Kane, 2026-09-27: *"search names
 * and work emails"*). Compact (26px) so it sits in a row with the segmented toggles
 * and the KPI picker. Matching lives in `src/lib/manager/rankings-search.ts`: names and
 * WORK emails only, never a personal address, and filtering never re-ranks.
 */
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export function RankingsSearch({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      <Search
        className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400"
        aria-hidden
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            onChange('');
          }
        }}
        placeholder="Search name or work email"
        aria-label="Search rankings by name or work email"
        autoComplete="off"
        spellCheck={false}
        className={cn(
          'h-[26px] w-full rounded-md border border-zinc-200 bg-white pl-7 text-[11.5px] text-zinc-800 shadow-sm transition-colors',
          'placeholder:text-zinc-400 hover:border-blue-300',
          'focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20',
          'dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-200 dark:hover:border-blue-800 dark:focus:border-blue-700',
          '[&::-webkit-search-cancel-button]:hidden',
          value ? 'pr-7' : 'pr-2',
        )}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-1 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      )}
    </div>
  );
}

/** The "no one matches" state, shared so every view says it the same way. */
export function RankingsNoMatch({ query }: { query: string }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-zinc-300 bg-white py-10 text-center dark:border-blue-950/60 dark:bg-[#0d1117]">
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        No one on this board matches &ldquo;{query.trim()}&rdquo;.
      </p>
      <p className="text-xs text-zinc-500">Search looks at names and work emails.</p>
    </div>
  );
}
