'use client';

import { Bell, X } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Teal-green themed notification toast rendered via `toast.custom`. Used by
 * useNotificationChime so the live alert matches the HR dashboard's teal/emerald
 * palette. The close (X) button sits in the upper-right corner and dismisses the
 * toast by id. When several notifications arrive at once, `count` adds a "+N"
 * badge so it stays a single toast.
 */
export function renderNotificationToast(opts: {
  id: string | number;
  title: string;
  message?: string | null;
  count?: number;
}) {
  const { id, title, message, count = 1 } = opts;
  return (
    <div className="relative w-[356px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-teal-200/70 bg-white shadow-lg shadow-teal-950/10 dark:border-teal-800/50 dark:bg-zinc-900 dark:shadow-black/40">
      {/* Teal accent stripe */}
      <div className="absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b from-teal-400 via-teal-500 to-emerald-600" />

      {/* Close — upper-right corner */}
      <button
        type="button"
        onClick={() => toast.dismiss(id)}
        aria-label="Dismiss notification"
        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition hover:bg-teal-50 hover:text-teal-700 dark:text-zinc-500 dark:hover:bg-teal-950/40 dark:hover:text-teal-300"
      >
        <X className="h-3.5 w-3.5" />
      </button>

      <div className="flex items-start gap-3 py-3.5 pl-5 pr-9">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal-50 ring-1 ring-teal-200 dark:bg-teal-950/40 dark:ring-teal-800/70">
          <Bell className="h-[18px] w-[18px] text-teal-600 dark:text-teal-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[13.5px] font-semibold leading-tight text-zinc-900 dark:text-zinc-100">
              {title}
            </p>
            {count > 1 && (
              <span className="shrink-0 rounded-full bg-teal-100 px-1.5 py-px text-[10px] font-bold tabular-nums text-teal-700 dark:bg-teal-900/50 dark:text-teal-300">
                +{count - 1}
              </span>
            )}
          </div>
          {message && (
            <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              {message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
