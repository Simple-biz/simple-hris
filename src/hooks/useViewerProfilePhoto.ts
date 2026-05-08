'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';
import { normEmail } from '@/lib/email/norm-email';

/**
 * Mirrors what EmployeeApp does for the employee dashboard avatar:
 * - Fetches the uploaded Supabase photo for `viewerEmail` from /api/employee-profile-photo
 * - Returns the Google SSO `session.user.image` ONLY when the signed-in session email
 *   matches the viewer email — so impersonation paths (?email=other@simple.biz) don't
 *   show the wrong person's photo.
 *
 * Both values feed straight into <EmployeeAvatar photoUrl={...} googlePhotoUrl={...} />,
 * which prefers the Google image, falls back to the upload, then to initials.
 */
export function useViewerProfilePhoto(viewerEmail: string | null | undefined): {
  profilePhotoUrl: string | null;
  googlePhotoUrl: string | null;
} {
  const { data: session } = useSession();
  const [profilePhotoUrl, setProfilePhotoUrl] = useState<string | null>(null);

  const googlePhotoUrl = useMemo(() => {
    const sessionEmail = session?.user?.email?.trim().toLowerCase();
    const sessionImage = session?.user?.image?.trim();
    if (!sessionEmail || !sessionImage) return null;
    const subjectEmail =
      (normEmail(viewerEmail ?? '') ?? viewerEmail?.trim().toLowerCase()) || null;
    if (!subjectEmail) return null;
    return sessionEmail === subjectEmail ? sessionImage : null;
  }, [session?.user?.email, session?.user?.image, viewerEmail]);

  useEffect(() => {
    if (!viewerEmail) {
      setProfilePhotoUrl(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/employee-profile-photo?email=${encodeURIComponent(viewerEmail)}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as { profilePhotoUrl?: string | null };
        if (cancelled) return;
        setProfilePhotoUrl(json.profilePhotoUrl?.trim() || null);
      } catch {
        if (!cancelled) setProfilePhotoUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [viewerEmail]);

  return { profilePhotoUrl, googlePhotoUrl };
}
