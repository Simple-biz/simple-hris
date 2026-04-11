'use client';

import React, { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

type EmployeeAvatarProps = {
  /** Supabase Storage URL when set — shown first. */
  photoUrl?: string | null | undefined;
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
 * Order: uploaded photo → Gravatar → initials.
 */
export default function EmployeeAvatar({
  photoUrl,
  email,
  initials,
  className = 'h-8 w-8',
  pixelSize = 64,
}: EmployeeAvatarProps) {
  const [failedUploaded, setFailedUploaded] = useState(false);
  const [failedGravatar, setFailedGravatar] = useState(false);
  const trimmed = email?.trim();
  const uploaded = photoUrl?.trim();

  useEffect(() => {
    setFailedUploaded(false);
    setFailedGravatar(false);
  }, [uploaded, trimmed]);

  const showInitials =
    (!uploaded || failedUploaded) && (!trimmed || failedGravatar);

  if (showInitials) {
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

  if (uploaded && !failedUploaded) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- Supabase public URL
      <img
        src={uploaded}
        alt=""
        className={cn('shrink-0 rounded-full object-cover', className)}
        onError={() => setFailedUploaded(true)}
      />
    );
  }

  const src = `/api/avatar?email=${encodeURIComponent(trimmed!)}&s=${pixelSize}&d=404`;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- same-origin /api/avatar → Gravatar redirect
    <img
      src={src}
      alt=""
      className={cn('shrink-0 rounded-full object-cover', className)}
      onError={() => setFailedGravatar(true)}
    />
  );
}
