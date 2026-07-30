/**
 * Which list a GET /api/department-transfers call is served, given the
 * caller's roles and the `scope` query param. Pure so the dispatch contract
 * is testable — it regressed once when the HR/admin default was narrowed to
 * the personal outbox and the HR history tab silently went empty.
 *
 *   all-requests  — every request, every status (HR/admin read-only history).
 *   all-pending   — pending only, all teams (admin action queue; stale-hidden).
 *   all-resolved  — resolved only, all teams (admin Done tab).
 *   own-outbox    — requests the caller raised (default for every role).
 *   dept-incoming — pending releases for depts the manager owns (stale-hidden).
 *   dept-resolved — resolved rows for depts the manager owns.
 *   forbidden     — caller holds no qualifying role.
 *
 * `scope=all` is deliberately HR/admin-only: the full company-wide trail is a
 * privileged surface, so a plain manager asking for it falls to their outbox.
 */
export type TransferListQuery =
  | 'all-requests'
  | 'all-pending'
  | 'all-resolved'
  | 'own-outbox'
  | 'dept-incoming'
  | 'dept-resolved'
  | 'forbidden';

export function resolveTransferListQuery(
  roles: string[],
  scope: string | null,
): TransferListQuery {
  const isHr = roles.includes('hr_coordinator') || roles.includes('admin');
  const isManager = roles.includes('manager');

  if (isHr) {
    if (scope === 'all') return 'all-requests';
    if (scope === 'incoming') return 'all-pending';
    if (scope === 'done') return 'all-resolved';
    return 'own-outbox';
  }
  if (isManager) {
    if (scope === 'incoming') return 'dept-incoming';
    if (scope === 'done') return 'dept-resolved';
    return 'own-outbox';
  }
  return 'forbidden';
}
