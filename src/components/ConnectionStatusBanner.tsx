'use client';

import type { ResourceStatus } from '@/hooks/useResilientResource';
import { cleanErrorMessage } from '@/lib/clean-error-message';

interface ConnectionStatusBannerProps {
  status: ResourceStatus;
  /** epoch ms of last successful load — shown as "as of HH:MM". */
  lastUpdatedAt?: number | null;
  /** Message from the failed attempt (shown only in the hard-error state). */
  error?: string | null;
  /** Wire to the resource's `refresh`. */
  onRetry?: () => void;
  className?: string;
}

function fmtTime(ms: number | null | undefined): string | null {
  if (!ms) return null;
  try {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return null;
  }
}

/**
 * Slim status bar for a resilient resource. Renders nothing while things are
 * healthy ('ready') or on a cold load ('loading'). On 'stale' it reassures the
 * user the screen is showing last-known data and reconnecting; on 'error' (a
 * cold-start failure with nothing to show) it surfaces the problem + Retry.
 * Pair with {@link useResilientResource}.
 */
export function ConnectionStatusBanner({
  status,
  lastUpdatedAt,
  error,
  onRetry,
  className,
}: ConnectionStatusBannerProps) {
  if (status === 'ready' || status === 'loading') return null;

  const stale = status === 'stale';
  const when = fmtTime(lastUpdatedAt);

  const tone = stale
    ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'
    : 'border-red-300 bg-red-50 text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200';
  const dot = stale ? 'bg-amber-500' : 'bg-red-500';

  const message = stale
    ? `Can't reach the server — showing data${when ? ` from ${when}` : ''}. Reconnecting…`
    : `Can't reach the server${error ? ` (${cleanErrorMessage(error)})` : ''}.`;

  return (
    <div
      role={stale ? 'status' : 'alert'}
      aria-live="polite"
      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${tone}${className ? ` ${className}` : ''}`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot} ${stale ? 'animate-pulse' : ''}`} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-md border border-current/30 px-2 py-0.5 text-xs font-medium transition hover:bg-black/5 dark:hover:bg-white/10"
        >
          Retry
        </button>
      )}
    </div>
  );
}
