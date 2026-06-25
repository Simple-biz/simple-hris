'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { usePayrollLivePresence, type PayrollSurface } from '@/hooks/usePayrollLivePresence';
import { useCobrowse } from '@/hooks/useCobrowse';

/**
 * Mounted on every payroll-processing surface. It does two things, both
 * passive (renders nothing):
 *
 *  1. Advertises this worker into the `payroll-live` presence roster so the CEO
 *     Overview can list them as a watchable POV ("who's processing payroll").
 *
 *  2. When `withCobrowseDriver` is set, runs the rrweb DRIVER half so the
 *     person's screen can be live-mirrored on demand. The Accounting dashboard
 *     already runs a driver via AccountingCollabLayer, so it passes this false
 *     to avoid a duplicate recorder on the same channel; the standalone
 *     /payroll-clerk dashboard has no collab layer, so it passes true.
 */
export default function PayrollLivePublisher({
  selfEmail,
  surface,
  activity,
  withCobrowseDriver = false,
}: {
  selfEmail: string | null | undefined;
  surface: PayrollSurface;
  activity?: string | null;
  withCobrowseDriver?: boolean;
}) {
  const { data: session } = useSession();
  const [photo, setPhoto] = useState<string | null>(null);
  const [resolvedName, setResolvedName] = useState<string | null>(null);

  const email = (selfEmail ?? '').trim().toLowerCase() || null;

  // Best-effort name + avatar so the CEO roster shows a real face, not just an
  // email. Both are non-fatal — the roster falls back to initials / email.
  useEffect(() => {
    if (!email) return;
    let alive = true;
    fetch(`/api/employee-profile-photo?email=${encodeURIComponent(email)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { profilePhotoUrl?: string | null } | null) => {
        if (alive) setPhoto(j?.profilePhotoUrl ?? null);
      })
      .catch(() => {});
    fetch(`/api/employees?email=${encodeURIComponent(email)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { employees?: { name?: string | null }[] } | null) => {
        const n = j?.employees?.[0]?.name;
        if (alive && typeof n === 'string' && n.trim()) setResolvedName(n.trim());
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [email]);

  const name = resolvedName ?? session?.user?.name ?? null;
  const avatarUrl = (photo && photo.trim()) || session?.user?.image || null;

  usePayrollLivePresence({
    selfEmail: email,
    publish: !!email,
    name,
    avatarUrl,
    surface,
    activity: activity ?? null,
  });

  // Driver half: records + streams this screen only while someone is watching,
  // so there's zero cost when the CEO isn't observing. Always called (hooks
  // can't be conditional); observedEmail stays null so the OBSERVER half is
  // inert. Gated by withCobrowseDriver passing a null email when not wanted.
  useCobrowse({
    selfEmail: withCobrowseDriver ? email : null,
    observedEmail: null,
  });

  return null;
}
