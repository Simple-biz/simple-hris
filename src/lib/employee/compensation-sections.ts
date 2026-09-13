import type { SectionId } from './profile-tabs';

/** Canonical order. Slide direction is computed from THIS, never from a filtered view. */
export const COMPENSATION_SECTIONS: readonly { id: SectionId; label: string }[] = [
  { id: 'rates', label: 'Rates' },
  { id: 'payStubs', label: 'Pay Stubs' },
  { id: 'payout', label: 'Payout' },
];

/**
 * DERIVED, never stored — a stored section can outlive the condition that
 * offered it (this Profile already hides content by state: the Address block
 * is `hasAnyAddress`-gated). Callers pass the raw stored value in on every
 * render; this decides whether it is still valid rather than trusting it.
 */
export function resolveCompensationSection(
  stored: SectionId | null,
  available: readonly SectionId[],
): SectionId {
  if (stored && available.includes(stored)) return stored;
  return available[0] ?? 'rates';
}

/**
 * Slide direction from the CANONICAL order (`COMPENSATION_SECTIONS`), never
 * from a filtered/available view — otherwise a hidden section could reverse
 * the direction of a swap.
 */
export function sectionSlideDirection(from: SectionId, to: SectionId): 1 | -1 {
  const order = COMPENSATION_SECTIONS.map((s) => s.id);
  return order.indexOf(to) >= order.indexOf(from) ? 1 : -1;
}
