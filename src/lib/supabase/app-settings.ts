import { createSupabaseServiceRoleClient } from './server';

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
