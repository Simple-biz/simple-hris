'use client';

import React, { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

type EmployeeAvatarProps = {
  /** Supabase Storage URL when set — used as a fallback after Google SSO. */
  photoUrl?: string | null | undefined;
  /**
   * Google SSO profile picture URL (`session.user.image`). Shown FIRST when present.
   * Only meaningful for the currently logged-in user — callers must verify the
   * session email matches the avatar subject before passing.
   */
  googlePhotoUrl?: string | null | undefined;
  /** Email — kept for API compatibility, no longer used for image lookup. */
  email?: string | null | undefined;
  /** Shown when no photo source is available or every source failed to load. */
  initials: string;
  /** Tailwind size class, e.g. h-8 w-8 */
  className?: string;
  /** Pixel size hint — kept for caller compatibility. */
  pixelSize?: number;
};

/**
 * Order: Google SSO photo → uploaded photo → initials.
 *
 * The Gravatar layer was removed: this is an internal HRIS where ~nobody
 * has a Gravatar registered, so every avatar render fired a 404 (by design,
 * for the `<img onError>` fallback) and spammed the browser console. Initials
 * are the universal fallback now.
 */
export default function EmployeeAvatar({
  photoUrl,
  googlePhotoUrl,
  initials,
  className = 'h-8 w-8',
}: EmployeeAvatarProps) {
  const [failedGoogle, setFailedGoogle] = useState(false);
  const [failedUploaded, setFailedUploaded] = useState(false);
  const uploaded = photoUrl?.trim();
  const google = googlePhotoUrl?.trim();

  useEffect(() => {
    setFailedGoogle(false);
    setFailedUploaded(false);
  }, [google, uploaded]);

  const showInitials =
    (!google || failedGoogle) && (!uploaded || failedUploaded);

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

  if (google && !failedGoogle) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- googleusercontent.com (no Next image config needed for one-off avatar)
      <img
        src={google}
        alt=""
        referrerPolicy="no-referrer"
        className={cn('shrink-0 rounded-full object-cover', className)}
        onError={() => setFailedGoogle(true)}
      />
    );
  }

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
