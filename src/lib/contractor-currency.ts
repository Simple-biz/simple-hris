// Currency handling for contractor invoices. Admins set a contractor's
// invoicing currency (PHP or USD) in Admin -> Roles; invoices snapshot it.
// Symbols are produced by Intl at runtime so this source stays ASCII-only.

export type ContractorCurrency = 'PHP' | 'USD';

export const CONTRACTOR_CURRENCIES: readonly ContractorCurrency[] = ['PHP', 'USD'];

export function normalizeCurrency(value: unknown): ContractorCurrency {
  return value === 'USD' ? 'USD' : 'PHP';
}

export function formatMoney(amount: number, currency: ContractorCurrency = 'PHP'): string {
  const locale = currency === 'USD' ? 'en-US' : 'en-PH';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

// Sum invoice totals grouped by their currency. Used wherever invoices of
// mixed currencies must be reported without conversion.
export function sumByCurrency(
  rows: readonly { total?: number | null; currency?: string | null }[],
): Record<ContractorCurrency, number> {
  const acc: Record<ContractorCurrency, number> = { PHP: 0, USD: 0 };
  for (const row of rows) {
    acc[normalizeCurrency(row.currency)] += row.total ?? 0;
  }
  return acc;
}

// Render a grouped total as a compact string, omitting zero buckets.
// Falls back to a formatted zero in the given currency when all buckets empty.
export function formatGrouped(
  totals: Record<ContractorCurrency, number>,
  fallbackCurrency: ContractorCurrency = 'PHP',
): string {
  const parts = CONTRACTOR_CURRENCIES.filter((c) => totals[c] !== 0).map((c) => formatMoney(totals[c], c));
  return parts.length > 0 ? parts.join(' + ') : formatMoney(0, fallbackCurrency);
}
