/**
 * Anniversary Gifts pick their gift FROM the Gift items table (Kane, 2026-09-23).
 *
 * A tier stores `gift_items` — the item NAMES it sends — and `gift`, the same
 * names joined with " & " for anything that still reads the old free-text field.
 * Gift items lists sizes/variants as separate rows ("Tshirt" XS…3XL, "Tote Bag"
 * S/M/L), so the choice is the distinct item NAME, never a row id: a tier sends
 * "a Tshirt", the size comes from the employee's submission.
 *
 * A name no longer in Gift items (renamed, deleted, or typed free-hand before this
 * rule — live 2026-09-23: "Polo", "Speaker", "Lamp") is KEPT on the tier and
 * reported as `missing`, never silently dropped on load or save. Dropping it would
 * erase what HR decided the month sends without anyone choosing to.
 */

export const GIFT_JOINER = ' & ';

/** Distinct, trimmed, non-empty item names in Gift items order (first occurrence wins). */
export function catalogItemNames(items: ReadonlyArray<{ item: string }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of items) {
    const name = row.item.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * The names a tier sends. `gift_items` wins when present; a tier saved before it
 * existed has only the free-text `gift`, split on " & ".
 */
export function tierGiftItems(tier: { gift: string; gift_items?: string[] | null }): string[] {
  const raw = Array.isArray(tier.gift_items) ? tier.gift_items : tier.gift.split(GIFT_JOINER);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of raw) {
    const name = n.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** The two stored fields for a chosen list — always written together. */
export function tierGiftFields(names: string[]): { gift_items: string[]; gift: string } {
  const gift_items = tierGiftItems({ gift: '', gift_items: names });
  return { gift_items, gift: gift_items.join(GIFT_JOINER) };
}

/** Tier names that match no Gift items name (case-insensitive). */
export function missingTierItems(tierNames: string[], catalogNames: string[]): string[] {
  const known = new Set(catalogNames.map((n) => n.toLowerCase()));
  return tierNames.filter((n) => !known.has(n.toLowerCase()));
}

/**
 * Snap each tier name to the catalog's spelling when it matches case-insensitively,
 * so "tshirt" typed long ago reads as the catalog's "Tshirt". Unmatched names are
 * returned unchanged (they surface through `missingTierItems`).
 */
export function canonicalizeTierItems(tierNames: string[], catalogNames: string[]): string[] {
  const byLower = new Map(catalogNames.map((n) => [n.toLowerCase(), n]));
  return tierNames.map((n) => byLower.get(n.toLowerCase()) ?? n);
}
