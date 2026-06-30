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

/**
 * Key whose value is bumped (to a fresh timestamp) every time a payment is
 * recorded or undone. The CEO live "payments to send" counter subscribes to
 * THIS key over Realtime — `app_settings` is already in the realtime
 * publication and reliably reaches the browser (anon) client, whereas the
 * sensitive `payment_dispatches` table may not. Keep this string in sync with
 * the literal in `usePaymentsLive` (kept literal there to avoid pulling this
 * server-only module into the client bundle).
 */
export const PAYMENTS_LIVE_PULSE_KEY = 'payroll.payments.pulse';

/** Best-effort nudge so payments-live subscribers refetch instantly. Never throws. */
export async function pulsePaymentsLive(): Promise<void> {
  try {
    await upsertAppSetting(PAYMENTS_LIVE_PULSE_KEY, new Date().toISOString());
  } catch {
    /* non-fatal — the periodic poll still reconciles the count */
  }
}

/**
 * Key bumped (to a fresh timestamp) every time an employee self-updates their
 * bank/payout details via the external link. The People-tab "Bank changes" feed
 * subscribes to THIS key over Realtime — same rationale as the payments pulse:
 * `app_settings` is in the realtime publication and reliably reaches the anon
 * browser client, whereas `audit_log` (the actual source) may be RLS-gated from
 * it. Keep this string in sync with the literal in `PeopleBankChanges`.
 */
export const BANK_CHANGES_PULSE_KEY = 'people.bank_changes.pulse';

/** Best-effort nudge so the People "Bank changes" feed refetches instantly. Never throws. */
export async function pulseBankChanges(): Promise<void> {
  try {
    await upsertAppSetting(BANK_CHANGES_PULSE_KEY, new Date().toISOString());
  } catch {
    /* non-fatal — the periodic poll still reconciles the feed */
  }
}
