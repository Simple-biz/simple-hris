'use client';

/**
 * Contractor dashboard tab-switch and reload cache.
 *
 * Built on the shared envelope (`src/lib/dashboard-cache/create-tab-cache.ts`):
 * `sessionStorage`, never `localStorage`; identity-stamped and inert until
 * bound; 12h ceiling; purged on sign-out and on a viewer swap; and **no
 * skip-fetch flag is reachable**, so a cached value paints and never decides.
 *
 * ## Most of this dashboard may not be cached, and that is the point
 *
 * `GET /api/contractor/profile` returns the contractor's payout row — the route's
 * own comment says it "carries bank account + ACH routing numbers", and the
 * field list includes `account_number`, `swift_code`, `ach_routing_number` and
 * both wallet emails. It is never cached, and no key here may be spelled for it.
 *
 * The saved-invoice list is out for two reasons: `payment_method` carries the
 * rail the invoice is to be paid on, and `logo_data_url` is an inline data URL
 * that would spend the whole storage budget on one row. The invoice BUILDER is a
 * draft, and a draft that survived a reload would paint under a clean form.
 *
 * What is left is the Overview's invoice list — numbers, dates, totals and a
 * status — which is the landing surface a dashboard switch actually hits.
 */

import { createTabCache } from '@/lib/dashboard-cache/create-tab-cache';
import { createCachedStateHook } from '@/lib/dashboard-cache/create-cached-state-hook';

export const contractorTabCache = createTabCache('ctr-tab:');

export const {
  useCacheIdentity: useContractorCacheIdentity,
  useCachedState: useContractorCachedState,
} = createCachedStateHook(contractorTabCache);

export function clearAllContractorCache(): void {
  contractorTabCache.clearAll();
}

/** Stable keys. **Every key here is wired to a live call site.** */
export const CONTRACTOR_CACHE_KEYS = {
  /** Overview → `GET /api/contractor/invoices?email=` — RAW rows: number, dates,
   *  company, total, currency, status, line items. No payment rail, no logo. */
  overviewInvoices: 'overview:invoices',
} as const;
