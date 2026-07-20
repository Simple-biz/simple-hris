/**
 * Shared helpers for the New Hire Checklist "Source" / "Referred By" columns.
 * Client-safe (pure, no server imports) so the grid, the quick-add modal, and
 * the server data layer can all agree on what counts as a referral.
 */

/** The canonical "Referral" source value (always offered in the dropdown). */
export const REFERRAL_SOURCE = "Referral";

/**
 * Default source options offered in the Source dropdown (a combobox, so users
 * can still type a CUSTOM source not in this list). "Referral" is always first;
 * the grid merges in whatever custom sources already exist in the data.
 */
export const BASE_SOURCE_OPTIONS = [
  REFERRAL_SOURCE,
  "Facebook",
  "OnlineJobs.ph",
  "LinkedIn",
  "Indeed",
  "JobStreet",
  "Kalibrr",
  "Website",
  "Walk-in",
] as const;

/** Normalised form for source matching: lowercased, alphanumeric-only. */
export function normalizeSource(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * True when a `source` value marks a genuine employee REFERRAL. Matches
 * "Referral", "Referrals", "Employee Referral", "Referred by ..." — anything
 * whose normalised form contains "refer". When this is true, the hire's
 * "Referred By" is required (the modal enforces it; the grid flags it).
 */
export function isReferralSource(s: string): boolean {
  return normalizeSource(s).includes("refer");
}
