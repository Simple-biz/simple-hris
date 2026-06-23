'use client';

import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The "AI Magic" logo badge for Penny AI — a gradient gem with a sparkle and a
 * slow shimmer sweep. Shared across the sidebar nav item (sm), the tab header
 * (md), and the empty-state hero (lg) so the brand reads identically everywhere.
 */

type BadgeSize = 'sm' | 'md' | 'lg';

const SIZES: Record<BadgeSize, { box: string; icon: string; radius: string; spark: string }> = {
  sm: { box: 'h-[18px] w-[18px]', icon: 'h-2.5 w-2.5', radius: 'rounded-[6px]', spark: 'h-1.5 w-1.5' },
  md: { box: 'h-9 w-9', icon: 'h-5 w-5', radius: 'rounded-xl', spark: 'h-2 w-2' },
  lg: { box: 'h-16 w-16', icon: 'h-8 w-8', radius: 'rounded-2xl', spark: 'h-3 w-3' },
};

export default function BizAiBadge({
  size = 'md',
  className,
  active = false,
}: {
  size?: BadgeSize;
  className?: string;
  /** Boosts the glow/shimmer (used when the nav item is selected). */
  active?: boolean;
}) {
  const s = SIZES[size];
  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden',
        'bg-gradient-to-br from-violet-500 via-fuchsia-500 to-amber-400',
        'shadow-sm shadow-fuchsia-500/30 ring-1 ring-white/30',
        s.box,
        s.radius,
        active && 'shadow-md shadow-fuchsia-500/50',
        className,
      )}
      aria-hidden
    >
      <style>{`
        @keyframes bizAiShimmer {
          0%   { transform: translateX(-130%) skewX(-18deg); opacity: 0; }
          18%  { opacity: 0.85; }
          55%  { opacity: 0; }
          100% { transform: translateX(230%) skewX(-18deg); opacity: 0; }
        }
        @keyframes bizAiTwinkle {
          0%, 100% { opacity: 0.35; transform: scale(0.8); }
          50%      { opacity: 1;    transform: scale(1.15); }
        }
      `}</style>

      {/* shimmer sweep */}
      <span
        className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 bg-white/40 blur-[2px]"
        style={{ animation: 'bizAiShimmer 4.5s ease-in-out infinite' }}
      />

      <Sparkles className={cn('relative text-white drop-shadow-sm', s.icon)} strokeWidth={2.25} />

      {/* corner twinkle */}
      <Sparkles
        className={cn('absolute right-[1px] top-[1px] text-amber-100', s.spark)}
        strokeWidth={2.5}
        style={{ animation: 'bizAiTwinkle 2.8s ease-in-out infinite' }}
      />
    </span>
  );
}
