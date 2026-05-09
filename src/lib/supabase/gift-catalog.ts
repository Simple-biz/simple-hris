import { createSupabaseServiceRoleClient } from './server';

export type GiftCatalogItem = {
  id: string;
  item: string;
  description: string;
  price_php: number;
};

export type GiftAnniversaryTier = {
  id: string;
  year: number;
  month_label: string;
  gift: string;
  usd_est: number;
};

export type GiftCatalogPayload = {
  items: GiftCatalogItem[];
  anniversaries: GiftAnniversaryTier[];
  suggestions: string[];
};

const EMPTY: GiftCatalogPayload = { items: [], anniversaries: [], suggestions: [] };

export async function getGiftCatalog(): Promise<{
  catalog: GiftCatalogPayload;
  updated_at: string | null;
  updated_by: string | null;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase)
    return { catalog: EMPTY, updated_at: null, updated_by: null, error: 'Supabase client unavailable' };
  const { data, error } = await supabase
    .from('gift_catalog')
    .select('items, anniversaries, suggestions, updated_at, updated_by')
    .eq('id', 1)
    .maybeSingle();
  if (error) return { catalog: EMPTY, updated_at: null, updated_by: null, error: error.message };
  if (!data) return { catalog: EMPTY, updated_at: null, updated_by: null, error: null };
  const row = data as {
    items: GiftCatalogItem[] | null;
    anniversaries: GiftAnniversaryTier[] | null;
    suggestions: string[] | null;
    updated_at: string;
    updated_by: string | null;
  };
  return {
    catalog: {
      items: row.items ?? [],
      anniversaries: row.anniversaries ?? [],
      suggestions: row.suggestions ?? [],
    },
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    error: null,
  };
}

export async function upsertGiftCatalog(
  payload: GiftCatalogPayload,
  updatedBy: string | null,
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase client unavailable' };
  const { error } = await supabase
    .from('gift_catalog')
    .upsert(
      {
        id: 1,
        items: payload.items,
        anniversaries: payload.anniversaries,
        suggestions: payload.suggestions,
        updated_by: updatedBy,
      },
      { onConflict: 'id' },
    );
  return { error: error ? error.message : null };
}
