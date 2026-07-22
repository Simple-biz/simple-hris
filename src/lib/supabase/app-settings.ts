import { createSupabaseServiceRoleClient } from './server';
import type { HubstaffMasterRow } from '@/lib/payroll/hubstaff-reconciliation';

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

/** Like {@link getAppSetting} but also returns the row's `updated_at`, for callers
 *  that need to compare a setting's freshness against another timestamp (e.g. a
 *  wizard snapshot vs. a staged paystub's `locked_at`). */
export async function getAppSettingWithMeta(
  key: string,
): Promise<{ value: string; updatedAt: string | null } | null> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('app_settings')
    .select('value, updated_at')
    .eq('key', key)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { value: string; updated_at: string | null };
  return { value: row.value, updatedAt: row.updated_at ?? null };
}

/** Bulk twin of {@link getAppSettingWithMeta} — one round-trip for many keys.
 *  Keys absent from the table are simply missing from the returned map. */
export async function getAppSettingsWithMeta(
  keys: string[],
): Promise<Record<string, { value: string; updatedAt: string | null }>> {
  const out: Record<string, { value: string; updatedAt: string | null }> = {};
  if (keys.length === 0) return out;
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return out;
  const { data, error } = await supabase
    .from('app_settings')
    .select('key, value, updated_at')
    .in('key', keys);
  if (error || !data) return out;
  for (const row of data as { key: string; value: string; updated_at: string | null }[]) {
    out[row.key] = { value: row.value, updatedAt: row.updated_at ?? null };
  }
  return out;
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
 * Per-cycle key under which the Accounting Overview publishes its EXACT hero
 * "Total payout" (Σ initial pay + PAB once the period closes). The CEO System
 * Overview board reads it so its headline mirrors Accounting instead of the base
 * figure it computes on its own (which drifts low by the PAB total). An absent
 * key → the CEO falls back to its own computation.
 */
export function accountingOverviewSnapshotKey(sourceFile: string): string {
  return `accounting.overview.snapshot.${sourceFile}`;
}

/** Shape stored (as a JSON string) at {@link accountingOverviewSnapshotKey}.
 *  Carries the FULL Accounting hero so the CEO board renders an exact replica
 *  from Accounting's own numbers. All beyond `totalPayoutPhp` are optional so an
 *  older snapshot (or a partial publish) degrades gracefully to CEO fallbacks. */
export interface AccountingOverviewSnapshot {
  totalPayoutPhp: number | null;
  totalPayoutUsd: number | null;
  /** "active workers" pill + "In this payroll" tile (payrollWorkerCount). */
  activeWorkers?: number | null;
  /** "Master list" tile (global master headcount). */
  masterTotal?: number | null;
  /** "Bonuses keyed in" tile. */
  bonusesKeyedIn?: number | null;
  /** "Hubstaff ↔ Master matches" tile + its reconciliation tooltip counts. */
  emailsMatched?: number | null;
  masterOnlyCount?: number | null;
  hubstaffOnlyCount?: number | null;
  /** Expected no-hours rows (no-Hubstaff dept / just hired / on leave) — counted
   *  as exceptions, NOT reconcile gaps. */
  exceptionsCount?: number | null;
  /** Drives the "Initial pay + PAB" vs "Initial pay" subtitle. */
  pabFinalized?: boolean;
  periodLabel?: string | null;
  periodWeek?: number | null;
  /** Full Hubstaff ↔ Master reconciliation breakdown (one row per person) so the
   *  CEO drill-down modal renders an exact replica of Accounting's list — same
   *  rows + no-hours reasons — rather than a server recompute. Optional so an
   *  older snapshot degrades to the CEO's own fallback build. */
  reconRows?: HubstaffMasterRow[];
  ts: string;
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
