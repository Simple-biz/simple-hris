import { createClient } from '@supabase/supabase-js';

export function getSecondaryServiceClient() {
  const url = process.env.SECONDARY_SUPABASE_URL?.trim();
  const key = process.env.SECONDARY_SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error('Missing SECONDARY_SUPABASE env vars');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
