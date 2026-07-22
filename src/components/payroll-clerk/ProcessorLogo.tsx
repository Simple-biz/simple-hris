'use client';

import React from 'react';
import { cn } from '@/lib/utils';

interface ProcessorLogoProps {
  /** Single-letter or two-letter monogram for the tile. */
  monogram: string;
  /** Tailwind gradient classes for the tile (e.g. "from-violet-500 to-fuchsia-500"). */
  gradient: string;
  FallbackIcon: React.ComponentType<{ className?: string }>;
  /**
   * Real brand logo (e.g. "/wise.png"). When present, the tile becomes a white
   * box holding the logo (object-contain, blend-out the logo's white bg) — the
   * same treatment used in the employee payout picker / contractor invoices. If
   * the image fails to load, we fall back to the gradient monogram/icon tile so
   * a broken asset never leaves an empty white square.
   */
  logoSrc?: string;
  /** Wrapper sizing/shape classes (e.g. "h-9 w-9 rounded-xl"). */
  className?: string;
  /** Monogram-on-gradient OR icon-on-gradient. */
  fallback?: 'monogram' | 'icon';
  /** Extra classes for the rendered fallback icon (e.g. an urgent pulse). */
  iconClassName?: string;
}

/**
 * Brand logo (when available) or a gradient monogram/icon tile — consistent
 * visuals for all processor cards.
 */
export default function ProcessorLogo({
  monogram,
  gradient,
  FallbackIcon,
  logoSrc,
  className,
  fallback = 'monogram',
  iconClassName,
}: ProcessorLogoProps) {
  // Track a load error so a missing/broken logo drops back to the gradient tile.
  const [logoFailed, setLogoFailed] = React.useState(false);
  const showLogo = Boolean(logoSrc) && !logoFailed;

  if (showLogo) {
    return (
      <div
        className={cn(
          'flex items-center justify-center overflow-hidden rounded-xl bg-white shadow-sm',
          className,
        )}
      >
        <img
          src={logoSrc}
          alt=""
          className="h-full w-full object-contain mix-blend-multiply dark:mix-blend-normal"
          onError={() => setLogoFailed(true)}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm',
        gradient,
        className,
      )}
    >
      {fallback === 'monogram' ? (
        <span className="text-[13px] font-bold tracking-tight">{monogram}</span>
      ) : (
        <FallbackIcon className={cn('h-4 w-4', iconClassName)} />
      )}
    </div>
  );
}
