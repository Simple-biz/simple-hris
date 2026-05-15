import { createSupabaseServiceRoleClient } from './server';

/**
 * Bulk lookup — one DB round-trip for many keys. Returns a `key → value` map
 * with `null` for keys that aren't in the table. Used by surfaces like the
 * Payroll Wizard that need ~10 settings up front (global + per-dept OT flags).
 */
export async function getAppSettings(keys: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const k of keys) out[k] = null;
  if (keys.length === 0) return out;
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return out;
  const { data, error } = await supabase
    .from('app_settings')
    .select('key,value')
    .in('key', keys);
  if (error || !data) return out;
  for (const row of data as { key: string; value: string }[]) {
    out[row.key] = row.value;
  }
  return out;
}

export async function getAppSetting(key: string): Promise<string | null> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { value: string }).value;
}

export async function upsertAppSetting(key: string, value: string): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase client unavailable' };
  const { error } = await supabase
    .from('app_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  return { error: error ? error.message : null };
}
