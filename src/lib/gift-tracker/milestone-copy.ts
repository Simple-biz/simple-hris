/**
 * The words and ornaments a tenure gift is celebrated with.
 *
 * Moved out of `src/components/employee/GiftShippingCard.tsx` on 2026-09-12,
 * when the public `/update-gift-address` page needed the same thing. Kane asked
 * for a page that looks and reads like the employee dashboard, and the only way
 * to guarantee "the same" is for both to read one module — a second copy of
 * eight thank-you messages drifts the first time somebody improves one of them.
 *
 * Presentational only. Nothing here decides a date, a milestone, or whether a
 * gift is owed; that is `gift-milestones.ts` and `gift-tracker/receipts.ts`.
 * Deliberately free of `server-only` and of any React import so a server route
 * can build an email or a payload from it.
 */

/** Apparel sizes offered on the shipping form — shirts, hoodies, jackets, polos.
 *  Non-apparel milestone gifts (tumbler, mug, speaker) just leave it blank. */
export const APPAREL_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'] as const;
export type ApparelSize = (typeof APPAREL_SIZES)[number];

/** Positions for the floating hearts behind the card content. */
export const HEARTS_FLOAT = [
  { left: '6%', delay: '0s', dur: '5.2s', size: 14, rotate: -8 },
  { left: '15%', delay: '1.6s', dur: '4.4s', size: 11, rotate: 6 },
  { left: '26%', delay: '3.1s', dur: '5.8s', size: 18, rotate: -12 },
  { left: '38%', delay: '0.9s', dur: '4.1s', size: 12, rotate: 10 },
  { left: '52%', delay: '2.4s', dur: '5.0s', size: 15, rotate: -4 },
  { left: '64%', delay: '0.3s', dur: '5.6s', size: 13, rotate: 8 },
  { left: '76%', delay: '3.4s', dur: '4.3s', size: 17, rotate: -10 },
  { left: '88%', delay: '1.9s', dur: '5.1s', size: 12, rotate: 4 },
] as const;

const MILESTONE_MESSAGES: Record<number, string> = {
  1: 'Six months in, and you have already made Simple.biz a better place. Thank you for your energy, your hard work, and for choosing to grow with us.',
  2: 'One full year together — and what a year it has been. Your dedication and heart inspire everyone around you. We are so proud to have you on this team.',
  3: 'A year and a half of showing up and making a real difference. The team truly would not be the same without you. Thank you for everything.',
  4: 'Two years! You have become a cornerstone of what Simple.biz is all about. Your loyalty and commitment mean more to us than words can say.',
  5: 'Two and a half years of dedication, growth, and passion. You have helped shape who we are as a company, and we are deeply grateful for every single day you give us.',
  6: 'Three years — a true milestone. You have grown with Simple.biz, and Simple.biz has grown because of you. Thank you for your unwavering commitment and spirit.',
  7: 'Three and a half years of excellence, resilience, and care. You are one of the people who make Simple.biz worth showing up for every day.',
  8: 'Four years! Your journey with us is a testament to your character and your drive. We celebrate you today and every day.',
};

/**
 * The thank-you line for a milestone.
 *
 * Falls back rather than returning empty: the source sheet stops at the
 * 48-month gift (index 8) but eighteen people are already past it, and a blank
 * card on somebody's fifth anniversary is worse than a warm generic one.
 */
export function giftMilestoneMessage(index: number): string {
  return (
    MILESTONE_MESSAGES[index] ??
    'Your continued dedication is one of our greatest blessings. Thank you for every day you bring to Simple.biz and to the people around you.'
  );
}

/**
 * "6 Months" / "1 Year" / "18 Months" / "2 Years".
 *
 * Whole years read as years because that is how people say them; everything
 * else stays in months rather than becoming "1.5 Years".
 */
export function tenureLabel(months: number): string {
  if (months % 12 === 0) {
    const yrs = months / 12;
    return yrs === 1 ? '1 Year' : `${yrs} Years`;
  }
  return `${months} Months`;
}
