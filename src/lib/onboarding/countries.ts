import type { PayCurrency } from '@/lib/payment-catalog/pay-structure';

/**
 * Country → currency for onboarding hires.
 *
 * The Location field on the onboarding paperwork is being split into structured
 * parts; Country is the first piece. We keep this list intentionally tiny — one
 * entry per currency the org actually pays in (USD/PHP/COP) — because the whole
 * point of capturing the country is to know the hire's currency. This file is
 * therefore the single source of that country → currency mapping.
 */
export type OnboardingCountry = {
  /** Canonical value stored on the submission + shown in the dropdown. */
  name: string;
  /** Currency the hire is paid/known in, derived from their country. */
  currency: PayCurrency;
};

export const ONBOARDING_COUNTRIES: readonly OnboardingCountry[] = [
  { name: 'United States', currency: 'USD' },
  { name: 'Philippines', currency: 'PHP' },
  { name: 'Colombia', currency: 'COP' },
];

/**
 * Aliases → canonical country name, so a legacy / free-typed Location value
 * (e.g. "USA", "Columbia" misspelling) still resolves to a currency. Keyed by
 * lower-cased input.
 */
const COUNTRY_ALIASES: Record<string, string> = {
  'united states': 'United States',
  'united states of america': 'United States',
  usa: 'United States',
  us: 'United States',
  'u.s.': 'United States',
  'u.s.a.': 'United States',
  america: 'United States',
  philippines: 'Philippines',
  ph: 'Philippines',
  phl: 'Philippines',
  colombia: 'Colombia',
  columbia: 'Colombia', // common misspelling
  co: 'Colombia',
  col: 'Colombia',
};

/** Resolve a stored/typed country string to its canonical entry, or null. */
export function resolveOnboardingCountry(
  country: string | null | undefined,
): OnboardingCountry | null {
  if (!country) return null;
  const trimmed = country.trim();
  if (!trimmed) return null;
  const name = COUNTRY_ALIASES[trimmed.toLowerCase()] ?? trimmed;
  return (
    ONBOARDING_COUNTRIES.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null
  );
}

/** The pay currency implied by a hire's country (USD/PHP/COP), or null. */
export function currencyForCountry(
  country: string | null | undefined,
): PayCurrency | null {
  return resolveOnboardingCountry(country)?.currency ?? null;
}
