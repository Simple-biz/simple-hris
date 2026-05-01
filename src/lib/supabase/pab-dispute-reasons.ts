/**
 * Pure data + types for PAB dispute reasons. No server-only imports — safe to
 * use from client components.
 */

export type PabDisputeReasonCode = {
  code: string;
  label: string;
  min_hours: number;
};

/**
 * Built-in dispute reasons. Used as a fallback when `pab_dispute_reason_codes`
 * is unset, and as the source of truth on the client (so the picker always
 * has options without a round-trip).
 */
export const DEFAULT_DISPUTE_REASON_CODES: PabDisputeReasonCode[] = [
  { code: 'orphanage_visit', label: 'Orphanage Visit', min_hours: 0 },
  { code: 'ceo_visitation', label: 'CEO Visitation & Accommodation', min_hours: 0 },
  { code: 'medical', label: 'Health Issues', min_hours: 4 },
  { code: 'power_outage', label: 'Power Outage', min_hours: 4 },
  { code: 'internet_issue', label: 'Intermittent Internet', min_hours: 4 },
  { code: 'family_emergency', label: 'Family Emergency', min_hours: 4 },
  { code: 'other', label: 'Other', min_hours: 4 },
];

/**
 * Reasons that follow the Orphanage approval flow:
 *  - Two-stage gate (Orphanage Manager → Accounting)
 *  - Day flips green without hours added (4h floor bypassed)
 *  - Manager-submitted, never employee-filed
 *  - Note flows from manager to Accounting reviewer
 */
const ORPHANAGE_STYLE_REASONS = new Set<string>(['orphanage_visit', 'ceo_visitation']);

export function isOrphanageStyleReason(reason: string | null | undefined): boolean {
  return reason != null && ORPHANAGE_STYLE_REASONS.has(reason);
}
