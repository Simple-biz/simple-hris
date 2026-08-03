'use client';

import CollabLayer, {
  type CollabLayerProps,
  type CollabAccent,
} from '@/components/collab/CollabLayer';
import { useCollabEnabled } from '@/hooks/useCollabEnabled';
import { COLLAB_HR_ENABLED_KEY } from '@/lib/collab/collab-settings';

/**
 * HR dashboard collaboration layer — live presence rail, section-scoped
 * cursors + click ripples, per-user cursor trails, "Observe" (full live screen
 * mirror via rrweb), and "Ping" (directed nudge). Full parity with the
 * Accounting collab layer, scoped to its OWN Realtime room (`hr-collab` /
 * `hr-cobrowse`) so HR collaborators never mix with Accounting collaborators,
 * and themed in HR's emerald palette.
 *
 * Admin can also kill the whole layer via System Settings (`collab.hr.
 * enabled`) — when off, CollabLayer never mounts, so it opens zero channels.
 */

// Section id -> label, mirroring the HR sidebar's tab names so a peer's
// location reads naturally in tooltips (e.g. "Here - New Hire Checklist").
const HR_SECTION_LABELS: Record<string, string> = {
  'overview': 'Overview',
  'new-hire-checklist': 'New Hire Checklist',
  'onboarding': 'Onboarding',
  'offboarding': 'Offboarding',
  'leaves': 'Leave Requests',
  'transfers': 'Transfers',
  'gift-tracker': 'Gift Tracker',
  'mesa': 'MESA',
  'announcements': 'Announcements',
  'notifications': 'Notifications',
  's-wall': 'S-Wall',
};

// Emerald accent for the Observe affordances + the "observing" avatar ring, so
// the layer belongs in the HR dashboard. The Tailwind class literals must live
// here (not be computed) for the JIT compiler to emit them.
const HR_ACCENT: CollabAccent = {
  observeBtn: 'bg-emerald-500/90 hover:bg-emerald-500',
  observeBadge: 'bg-emerald-500 text-white',
  focusRing: 'focus-visible:ring-emerald-400',
  hex: '#10b981',
  ringGlow: 'rgba(16,185,129,0.75)',
  cobrowseGlow: 'rgba(16,185,129,0.55)',
};

type Props = Pick<CollabLayerProps, 'selfEmail' | 'section' | 'containerRef' | 'scrollSurface'>;

export default function HrCollabLayer(props: Props) {
  const enabled = useCollabEnabled(COLLAB_HR_ENABLED_KEY);
  if (!enabled) return null;
  return (
    <CollabLayer
      {...props}
      channel="hr-collab"
      cobrowseChannel="hr-cobrowse"
      sectionLabels={HR_SECTION_LABELS}
      accent={HR_ACCENT}
      surfaceLabel="HR dashboard"
    />
  );
}
