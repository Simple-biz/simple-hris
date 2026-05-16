'use client';

import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface QueuePaginationProps {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  /** Optional label for the unit being paginated ("rows", "people", "records"). */
  label?: string;
  className?: string;
}

export default function QueuePagination({
  page,
  pageCount,
  total,
  pageSize,
  onPageChange,
  label = 'rows',
  className,
}: QueuePaginationProps) {
  if (pageCount <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200/70 px-3 py-2 text-[11px] text-zinc-500 dark:border-zinc-800/70 dark:text-zinc-400',
        className,
      )}
    >
      <span className="tabular-nums">
        {from}–{to} of {total} {label}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-3 w-3" />
          Prev
        </button>
        <span className="px-1.5 tabular-nums">
          {page} / {pageCount}
        </span>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          disabled={page >= pageCount}
          onClick={() => onPageChange(Math.min(pageCount, page + 1))}
          aria-label="Next page"
        >
          Next
          <ChevronRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
