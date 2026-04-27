'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

interface ProcessorLogoProps {
  /** Processor id — also drives the lookup at `/processors/{id}.svg`. */
  id: string;
  /** Single-letter or two-letter monogram for the fallback tile. */
  monogram: string;
  /** Tailwind gradient classes for the fallback tile (e.g. "from-violet-500 to-fuchsia-500"). */
  gradient: string;
  /** Outer fallback icon when no logo asset exists yet. */
  FallbackIcon: React.ComponentType<{ className?: string }>;
  /** Wrapper sizing/shape classes (e.g. "h-9 w-9 rounded-xl"). */
  className?: string;
  /** Render mode: monogram-on-gradient OR icon-on-gradient when no logo found. */
  fallback?: 'monogram' | 'icon';
}

/**
 * Renders a brand logo from `/processors/{id}.svg` if the asset exists,
 * otherwise a polished gradient tile (monogram or icon) so the layout never
 * shows a broken-image cell. Keeps brand integrity for known processors and a
 * unified look for ones we haven't sourced yet.
 */
export default function ProcessorLogo({
  id,
  monogram,
  gradient,
  FallbackIcon,
  className,
  fallback = 'monogram',
}: ProcessorLogoProps) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'missing'>('loading');
  const src = `/processors/${id}.svg`;

  // HEAD probe — Next dev returns the SVG when present, 404 when absent. Doing
  // it once per mount keeps us out of an infinite onError loop and lets us
  // cleanly pick the right render branch.
  useEffect(() => {
    let cancelled = false;
    fetch(src, { method: 'HEAD' })
      .then((r) => {
        if (cancelled) return;
        setStatus(r.ok ? 'loaded' : 'missing');
      })
      .catch(() => {
        if (!cancelled) setStatus('missing');
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (status === 'loaded') {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        className={cn(
          'flex items-center justify-center overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-100',
          className,
        )}
      >
        {/* Plain <img>: SVG handles its own colours; we just constrain the box */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={`${id} logo`}
          className="h-[70%] w-[70%] object-contain"
          draggable={false}
        />
      </motion.div>
    );
  }

  // Loading and missing both render the fallback tile so layout doesn't shift
  // when the probe resolves quickly. Loading state is invisibly identical.
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
