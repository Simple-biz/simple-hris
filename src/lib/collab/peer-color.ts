/**
 * Stable per-person identity color for the live collaboration layer.
 *
 * A collaborator should read as the SAME color everywhere they surface — their
 * live cursor, their avatar ring in the presence rail, and (New Hire Checklist)
 * the ring around whatever cell they're editing. Hashing the email into a fixed
 * palette keeps that mapping deterministic across every client with no shared
 * state. Extracted here so `CollabLayer` (cursors/rail) and `useLiveCells`
 * (co-edit rings) can share one source of truth.
 */

export const PEER_PALETTE = [
  { bg: '#f43f5e', glow: 'rgba(244,63,94,0.55)' },
  { bg: '#f97316', glow: 'rgba(249,115,22,0.55)' },
  { bg: '#eab308', glow: 'rgba(234,179,8,0.55)' },
  { bg: '#10b981', glow: 'rgba(16,185,129,0.55)' },
  { bg: '#06b6d4', glow: 'rgba(6,182,212,0.55)' },
  { bg: '#3b82f6', glow: 'rgba(59,130,246,0.55)' },
  { bg: '#a855f7', glow: 'rgba(168,85,247,0.55)' },
  { bg: '#ec4899', glow: 'rgba(236,72,153,0.55)' },
] as const;

export type PeerColor = (typeof PEER_PALETTE)[number];

/** Deterministic palette pick for an email (same hash on every client). */
export function hashEmail(email: string): PeerColor {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = ((h << 5) - h + email.charCodeAt(i)) >>> 0;
  return PEER_PALETTE[h % PEER_PALETTE.length]!;
}
