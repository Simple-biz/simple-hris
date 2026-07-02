'use client';

import React from 'react';
import { Building2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The compact brand mark shown in the collapsed rail in place of the full
 * wordmark logo — an icon, not an image. Each rail passes its own gradient (and
 * positioning / fade) via `className`; change the glyph here to change it on
 * every dashboard at once.
 */
export default function SidebarBrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-sm ring-1 ring-black/5',
        className,
      )}
    >
      <Building2 className="h-[18px] w-[18px]" strokeWidth={2.25} />
    </span>
  );
}
