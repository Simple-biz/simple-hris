// Server-side storage for the Current Banks registry — one JSON array in
// app_settings, exactly like the Pay Processors registry beside it. No table,
// no migration. See banks.ts for the model.

import 'server-only';

import { casUpdateAppSetting, getAppSettingWithMetaStrict } from '@/lib/supabase/app-settings';
import { BANKS_SETTING_KEY, sanitizeBankEntry, type BankRegistryEntry } from './banks';

/**
 * The stored bank entries. THROWS on a failed read — a transient DB error must
 * never read as "no bank has a logo yet", because the next save would then
 * persist a registry missing every alias mapping and logo that was there.
 * Corrupt JSON surfaces as empty and is NOT written back.
 */
export async function readBankRegistry(): Promise<{
  stored: BankRegistryEntry[];
  updatedAt: string | null;
}> {
  const meta = await getAppSettingWithMetaStrict(BANKS_SETTING_KEY);
  if (!meta) return { stored: [], updatedAt: null };
  try {
    const parsed: unknown = JSON.parse(meta.value);
    if (!Array.isArray(parsed)) return { stored: [], updatedAt: meta.updatedAt };
    return {
      stored: parsed.map(sanitizeBankEntry).filter((e): e is BankRegistryEntry => e !== null),
      updatedAt: meta.updatedAt,
    };
  } catch {
    return { stored: [], updatedAt: meta.updatedAt };
  }
}

const CAS_ATTEMPTS = 4;

/**
 * Read → `mutate(stored)` → compare-and-swap write, retried on conflict, so two
 * people logging two different banks both land. `mutate` may return `{ error }`
 * to refuse, which is returned as-is and never retried.
 */
export async function mutateBankRegistry(
  mutate: (stored: BankRegistryEntry[]) => BankRegistryEntry[] | { error: string },
): Promise<{ stored: BankRegistryEntry[] | null; error: string | null; conflict: boolean }> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    let current: { stored: BankRegistryEntry[]; updatedAt: string | null };
    try {
      current = await readBankRegistry();
    } catch (e) {
      return {
        stored: null,
        error: e instanceof Error ? e.message : 'Could not read the bank registry',
        conflict: false,
      };
    }
    const next = mutate(current.stored);
    if (!Array.isArray(next)) return { stored: null, error: next.error, conflict: false };
    const sorted = [...next].sort((a, b) => a.key.localeCompare(b.key));
    const res = await casUpdateAppSetting(BANKS_SETTING_KEY, JSON.stringify(sorted), current.updatedAt);
    if (res.ok) return { stored: sorted, error: null, conflict: false };
    if (res.error) return { stored: null, error: res.error, conflict: false };
  }
  return {
    stored: null,
    error: 'Someone else saved the bank list at the same moment — please try again.',
    conflict: true,
  };
}
