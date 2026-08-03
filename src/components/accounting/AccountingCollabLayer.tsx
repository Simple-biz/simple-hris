'use client';

import CollabLayer, { type CollabLayerProps } from '@/components/collab/CollabLayer';
import { useCollabEnabled } from '@/hooks/useCollabEnabled';
import { COLLAB_ACCOUNTING_ENABLED_KEY } from '@/lib/collab/collab-settings';

/**
 * Accounting dashboard collaboration layer.
 *
 * Thin wrapper over the shared {@link CollabLayer} engine. The engine's
 * built-in defaults (channels `accounting-collab` / `accounting-cobrowse`,
 * Accounting section labels, orange accent) ARE the Accounting configuration,
 * so this wrapper simply forwards `selfEmail` / `section` / `containerRef`.
 * Kept as its own file/name so existing mount sites (App.tsx) and the feature's
 * identity stay stable; see {@link HrCollabLayer} for the HR-scoped sibling.
 *
 * Accounting is where payroll processing happens, so this dashboard retracts
 * the collab chrome (peer cursors + avatar rail) while the dispatch lock is on
 * — same trigger as the sidebar auto-collapse — to keep the operator focused.
 *
 * Admin can also kill the whole layer via System Settings (`collab.accounting.
 * enabled`) — when off, CollabLayer never mounts, so it opens zero channels.
 */
type Props = Pick<CollabLayerProps, 'selfEmail' | 'section' | 'containerRef'>;

export default function AccountingCollabLayer(props: Props) {
  const enabled = useCollabEnabled(COLLAB_ACCOUNTING_ENABLED_KEY);
  if (!enabled) return null;
  return <CollabLayer {...props} retractWhileProcessing />;
}
