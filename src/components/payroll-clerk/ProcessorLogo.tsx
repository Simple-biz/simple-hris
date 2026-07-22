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
   * Real brand logo (e.g. "/wise.png"). When present, the logo renders on a
   * WIDE white plate (see `logoClassName`) instead of the square icon tile —
   * these are horizontal wordmarks (Wise ~2.4:1, Hurupay/Higlobe ~3:1), so a
   * square + object-contain would shrink them to an unreadable sliver. If the
   * image fails to load, we fall back to the gradient monogram/icon tile so a
   * broken asset never leaves an empty box.
   */
  logoSrc?: string;
  /** Wrapper sizing/shape classes for the tile/plate (e.g. "h-11 w-[80px]"). */
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
          // Wide white plate with breathing room so the wordmark reads at size.
          // No mix-blend: these logos are dark-on-transparent and sit fine on
          // white; multiply washed the thin strokes out to near-white ("empty
          // box" bug). White plate stays white in dark mode on purpose — brand
          // wordmarks are drawn for a light background.
          'flex items-center justify-center overflow-hidden rounded-xl bg-white px-1.5 shadow-sm',
          className,
        )}
      >
        <img
          src={logoSrc}
          alt=""
          className="max-h-full max-w-full object-contain"
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
        <span className="text-base font-bold tracking-tight">{monogram}</span>
      ) : (
        <FallbackIcon className={cn('h-5 w-5', iconClassName)} />
      )}
    </div>
  );
}
