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
   * WIDE white plate (see `logoClassName`) instead of the square icon tile.
   * Most of these are horizontal wordmarks (Wise ~2.4:1, HiGlobe ~3:1) and a
   * square + object-contain would shrink them to an unreadable sliver; Kolan is
   * a squarish brand MARK instead, which the plate detects from the decoded
   * aspect ratio and pads vertically so it sits on the plate rather than
   * filling it edge to edge. If the image fails to load, we fall back to the
   * gradient monogram/icon tile so a broken asset never leaves an empty box.
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
  // Until the wordmark PNG has actually decoded, the white plate is an empty
  // box — cover it with a soft pulse skeleton, then fade the logo in. Cached
  // images can be complete before React hydrates (onLoad never fires), so a
  // ref callback checks `complete` and skips the skeleton entirely.
  const [logoLoaded, setLogoLoaded] = React.useState(false);
  // Aspect ratio of the decoded logo, so the plate can tell a horizontal
  // WORDMARK (Wise, HiGlobe ~2.4-3:1) from a squarish BRAND MARK (Kolan). A
  // mark sized to the full plate height touches both edges and reads as a
  // cramped sticker, so it gets vertical breathing room the wordmarks don't
  // need. Null until decode — treated as a wordmark, which is the old behaviour.
  const [logoAspect, setLogoAspect] = React.useState<number | null>(null);
  const noteAspect = React.useCallback((el: HTMLImageElement | null) => {
    if (el && el.naturalWidth > 0 && el.naturalHeight > 0) {
      setLogoAspect(el.naturalWidth / el.naturalHeight);
    }
  }, []);
  const logoRef = React.useCallback(
    (el: HTMLImageElement | null) => {
      if (el?.complete && el.naturalWidth > 0) {
        setLogoLoaded(true);
        noteAspect(el);
      }
    },
    [noteAspect],
  );
  const isMark = logoAspect !== null && logoAspect < 1.5;
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
          'relative flex items-center justify-center overflow-hidden rounded-xl bg-white px-1.5 shadow-sm',
          // Square marks get vertical padding so they sit ON the plate rather
          // than filling it edge to edge; wordmarks keep the full height.
          isMark && 'py-1.5',
          className,
        )}
      >
        {/* Loading skeleton — a quiet wordmark-shaped pulse on the plate. The
            plate is white even in dark mode, so the block stays light-zinc
            (no dark: variant). Static for reduced-motion users. */}
        {!logoLoaded && (
          <span
            aria-hidden
            className="absolute inset-x-2 inset-y-3 animate-pulse rounded-md bg-zinc-200/80 motion-reduce:animate-none"
          />
        )}
        <img
          ref={logoRef}
          src={logoSrc}
          alt=""
          className={cn(
            'max-h-full max-w-full object-contain transition-opacity duration-200 ease-out motion-reduce:transition-none',
            logoLoaded ? 'opacity-100' : 'opacity-0',
          )}
          onLoad={(e) => {
            setLogoLoaded(true);
            noteAspect(e.currentTarget);
          }}
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
