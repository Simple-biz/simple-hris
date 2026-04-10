'use client';

import React, { useState } from 'react';
import { cn } from '@/lib/utils';

type EmployeeAvatarProps = {
  /** Work or personal email — used for Gravatar (MD5). */
  email: string | null | undefined;
  /** Shown when email missing or image fails to load. */
  initials: string;
  /** Tailwind size class, e.g. h-8 w-8 */
  className?: string;
  /** Pixel size for Gravatar request (2× for retina). */
  pixelSize?: number;
};

/**
 * Tries Gravatar for the email (many users register work emails there).
 * On missing image (`d=404`) or error, shows initials in a gradient circle.
 */
export default function EmployeeAvatar({
  email,
  initials,
  className = 'h-8 w-8',
  pixelSize = 64,
}: EmployeeAvatarProps) {
  const [failed, setFailed] = useState(false);
  const trimmed = email?.trim();

  if (!trimmed || failed) {
    return (
      <div
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-orange-400 to-blue-500 text-xs font-bold text-white shadow-sm',
          className,
        )}
        aria-hidden
      >
        {initials.slice(0, 2).toUpperCase()}
      </div>
    );
  }

  const src = `/api/avatar?email=${encodeURIComponent(trimmed)}&s=${pixelSize}&d=404`;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- same-origin /api/avatar → Gravatar redirect
    <img
      src={src}
      alt=""
      className={cn('shrink-0 rounded-full object-cover', className)}
      onError={() => setFailed(true)}
    />
  );
}
