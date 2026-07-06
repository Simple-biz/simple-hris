'use client';

import React from 'react';
import { cn } from '@/lib/utils';

/**
 * The compact brand mark shown in the collapsed rail in place of the full
 * wordmark logo — the Penny AI heart (our orange company heart mark, the same
 * `/chatbubble.png` used by the Penny AI chat bubble). Shared by every dashboard
 * rail so the collapsed brand reads identically everywhere.
 *
 * `SidebarLogoHeader` fades the wordmark out and fades + scales this in, so the
 * expanded → collapsed change reads as a morph. The idle heartbeat only runs
 * once the mark has settled (`beat` + an animation delay past the morph), so it
 * never fights the entrance — otherwise the beat and the scale-in compound into
 * a jittery, un-smooth morph. Honours `prefers-reduced-motion`.
 *
 * `className` is positioning only (passed by the morph layer); the heart is
 * self-coloured, so no per-rail accent is applied here.
 */
export default function SidebarBrandMark({
  className,
  /** Run the idle heartbeat (only true once the rail is collapsed). */
  beat = false,
}: {
  className?: string;
  beat?: boolean;
}) {
  return (
    <span aria-hidden className={cn('flex h-9 w-9 items-center justify-center', className)}>
      <style>{`
        @keyframes sidebarHeartBeat {
          0%, 26%, 60%, 100% { transform: scale(1); }
          13% { transform: scale(1.13); }
          38% { transform: scale(1.05); }
        }
        @media (prefers-reduced-motion: reduce) {
          .sidebar-brand-heart { animation: none !important; }
        }
      `}</style>
      <img
        src="/chatbubble.png"
        alt=""
        draggable={false}
        className="sidebar-brand-heart h-8 w-8 object-contain drop-shadow-sm"
        // Delay past the collapse morph so the entrance stays a clean fade+scale;
        // the gentle beat only kicks in once the heart has landed.
        style={beat ? { animation: 'sidebarHeartBeat 3.2s ease-in-out 800ms infinite', transformOrigin: 'center' } : undefined}
      />
    </span>
  );
}
