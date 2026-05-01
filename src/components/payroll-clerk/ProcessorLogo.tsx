'use client';

import React from 'react';
import { cn } from '@/lib/utils';

interface ProcessorLogoProps {
  /** Single-letter or two-letter monogram for the tile. */
  monogram: string;
  /** Tailwind gradient classes for the tile (e.g. "from-violet-500 to-fuchsia-500"). */
  gradient: string;
  FallbackIcon: React.ComponentType<{ className?: string }>;
  /** Wrapper sizing/shape classes (e.g. "h-9 w-9 rounded-xl"). */
  className?: string;
  /** Monogram-on-gradient OR icon-on-gradient. */
  fallback?: 'monogram' | 'icon';
}

/**
 * Gradient tile with monogram or icon — consistent visuals for all processor cards.
 */
export default function ProcessorLogo({
  monogram,
  gradient,
  FallbackIcon,
  className,
  fallback = 'monogram',
}: ProcessorLogoProps) {
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
        <FallbackIcon className="h-4 w-4" />
      )}
    </div>
  );
}
