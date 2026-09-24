/**
 * The ONE browser read of Orders state, shared by the Orders tab and the
 * tracker's Orders badge so the two can never count from different data.
 * `no-store` on purpose: lock state must never paint from a cache
 * (docs/features/gift-tracker-orders.md).
 */
import type { GiftOrderRow } from '@/lib/supabase/gift-orders';
import type { OrderCatalogItem, OrderTier } from './orders';

export interface OrdersClientState {
  migrated: boolean;
  orders: GiftOrderRow[];
  liveKeys: string[];
  catalog: OrderCatalogItem[];
  tiers: OrderTier[];
}

/** Throws on any failed read — a caller must never turn a failure into "0 open". */
export async function fetchOrdersState(): Promise<OrdersClientState> {
  const [oRes, cRes] = await Promise.all([
    fetch('/api/gift-orders', { cache: 'no-store' }),
    fetch('/api/gift-catalog', { cache: 'no-store' }),
  ]);
  const oJson = (await oRes.json()) as {
    migrated?: boolean;
    orders?: GiftOrderRow[];
    liveKeys?: string[];
    error?: string | null;
  };
  const cJson = (await cRes.json()) as {
    catalog?: { items?: OrderCatalogItem[]; anniversaries?: OrderTier[] };
    error?: string | null;
  };
  if (!oRes.ok || oJson.error) throw new Error(oJson.error ?? 'Could not load orders');
  if (!cRes.ok || cJson.error) throw new Error(cJson.error ?? 'Could not load Gift items');
  return {
    migrated: oJson.migrated !== false,
    orders: oJson.orders ?? [],
    liveKeys: oJson.liveKeys ?? [],
    catalog: cJson.catalog?.items ?? [],
    tiers: cJson.catalog?.anniversaries ?? [],
  };
}
