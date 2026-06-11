import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Low-level shimmer block. Compose these to mirror real layout while data loads.
 * Uses hardcoded zinc palette (semantic tokens like bg-muted don't compile in
 * this project — @theme is fonts-only). Light-first with a dark: variant.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded-md bg-zinc-200/80 dark:bg-zinc-800/70', className)}
      {...props}
    />
  );
}

export { Skeleton };
