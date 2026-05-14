'use client';

import React from 'react';
import { Bell, CheckCheck, Lock, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDispatchLock } from '@/hooks/useDispatchLock';

interface NotificationsPanelProps {
  viewerEmail?: string | null;
  accent?: 'orange' | 'blue' | 'emerald' | 'yellow' | 'zinc' | 'pink';
}

function formatLockedAt(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return null;
  }
}

export default function NotificationsPanel({
  viewerEmail: _viewerEmail,
  accent = 'orange',
}: NotificationsPanelProps) {
  const { state: lockState, loading } = useDispatchLock();

  const ring: Record<typeof accent, string> = {
    orange: 'ring-orange-200 dark:ring-orange-900/40',
    blue: 'ring-blue-200 dark:ring-blue-900/40',
    emerald: 'ring-emerald-200 dark:ring-emerald-900/40',
    yellow: 'ring-yellow-200 dark:ring-yellow-900/40',
    zinc: 'ring-zinc-200 dark:ring-zinc-800',
    pink: 'ring-pink-200 dark:ring-pink-900/40',
  };

  const iconBg: Record<typeof accent, string> = {
    orange: 'bg-orange-50 dark:bg-orange-950/30',
    blue: 'bg-blue-50 dark:bg-blue-950/30',
    emerald: 'bg-emerald-50 dark:bg-emerald-950/30',
    yellow: 'bg-yellow-50 dark:bg-yellow-950/30',
    zinc: 'bg-zinc-100 dark:bg-zinc-800/60',
    pink: 'bg-pink-50 dark:bg-pink-950/30',
  };

  const iconColor: Record<typeof accent, string> = {
    orange: 'text-orange-400 dark:text-orange-500',
    blue: 'text-blue-400 dark:text-blue-500',
    emerald: 'text-emerald-400 dark:text-emerald-500',
    yellow: 'text-yellow-400 dark:text-yellow-500',
    zinc: 'text-zinc-400 dark:text-zinc-500',
    pink: 'text-pink-400 dark:text-pink-500',
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-zinc-100 bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-zinc-800 dark:bg-[#0d1117]">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
          <h1 className="text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
            Notifications
          </h1>
          {lockState.locked && (
            <span className="ml-1 inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:bg-red-950/50 dark:text-red-400">
              1 active
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
          System alerts, approvals, and activity updates.
        </p>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-50/60 dark:bg-[#0d1117]">
        {loading ? (
          /* Loading skeleton */
          <div className="space-y-3 px-4 py-5 sm:px-6">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="animate-pulse rounded-xl border border-zinc-100 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/50"
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 h-8 w-8 shrink-0 rounded-full bg-zinc-100 dark:bg-zinc-800" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-2/3 rounded-full bg-zinc-100 dark:bg-zinc-800" />
                    <div className="h-2.5 w-full rounded-full bg-zinc-100 dark:bg-zinc-800" />
                    <div className="h-2.5 w-3/4 rounded-full bg-zinc-100 dark:bg-zinc-800" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : lockState.locked ? (
          /* Active payroll notification */
          <div className="px-4 py-5 sm:px-6">
            <div className="overflow-hidden rounded-xl border border-amber-200/80 bg-white shadow-sm dark:border-amber-900/40 dark:bg-zinc-900/80">
              {/* Coloured top stripe */}
              <div className="h-1 w-full bg-gradient-to-r from-amber-400 to-orange-500" />

              <div className="p-4 sm:p-5">
                <div className="flex items-start gap-3.5">
                  {/* Icon */}
                  <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-50 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:ring-amber-900/50">
                    <Lock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  </div>

                  <div className="min-w-0 flex-1">
                    {/* Title row */}
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[14px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">
                        Payroll Processing Started
                      </p>
                      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10.5px] font-semibold text-red-700 dark:bg-red-950/50 dark:text-red-400">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
                        Active
                      </span>
                    </div>

                    {/* Body */}
                    <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                      Payroll is currently being processed. The following actions are
                      temporarily paused:
                    </p>

                    {/* Paused items list */}
                    <ul className="mt-2.5 space-y-1.5">
                      {[
                        'Bank account changes',
                        'Leave request filing',
                        'PAB dispute submissions',
                      ].map((item) => (
                        <li
                          key={item}
                          className="flex items-center gap-2 text-[12.5px] text-zinc-500 dark:text-zinc-500"
                        >
                          <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
                          {item}
                        </li>
                      ))}
                    </ul>

                    {/* Meta — locked by / time */}
                    {(lockState.lockedBy || lockState.lockedAt) && (
                      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                        {lockState.lockedBy && (
                          <span className="text-[11.5px] text-zinc-400 dark:text-zinc-500">
                            Started by{' '}
                            <span className="font-medium text-zinc-600 dark:text-zinc-300">
                              {lockState.lockedBy}
                            </span>
                          </span>
                        )}
                        {lockState.lockedAt && (
                          <span className="text-[11.5px] text-zinc-400 dark:text-zinc-500">
                            {formatLockedAt(lockState.lockedAt)}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <p className="mt-3 px-1 text-[11.5px] text-zinc-400 dark:text-zinc-600">
              This notification will clear automatically when processing is complete.
            </p>
          </div>
        ) : (
          /* Empty state */
          <div className="flex h-full flex-col items-center justify-center gap-5 px-6 py-16 text-center">
            <div
              className={cn(
                'flex h-16 w-16 items-center justify-center rounded-full ring-1',
                iconBg[accent],
                ring[accent],
              )}
            >
              <Bell className={cn('h-7 w-7', iconColor[accent])} strokeWidth={1.5} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-center gap-1.5 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                <CheckCheck className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500" />
                All caught up
              </div>
              <p className="max-w-xs text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-500">
                No notifications right now. Approvals, disputes, and system alerts
                will appear here when they arrive.
              </p>
            </div>
            {/* Ghost skeleton */}
            <div className="mt-2 w-full max-w-sm space-y-2.5 opacity-25">
              {[80, 60, 70].map((w, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-700" />
                  <div className="flex-1 space-y-1.5">
                    <div
                      className="h-2.5 rounded-full bg-zinc-200 dark:bg-zinc-800"
                      style={{ width: `${w}%` }}
                    />
                    <div className="h-2 w-1/3 rounded-full bg-zinc-200 dark:bg-zinc-800" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
