// Server-side storage for the Pay Processors registry — one JSON array in
// app_settings (no table, no migration), same decision as the Department
// registry. See pay-processors.ts for the model.

import 'server-only';

import { casUpdateAppSetting, getAppSettingWithMetaStrict } from '@/lib/supabase/app-settings';
import {
  PAY_PROCESSORS_SETTING_KEY,
  comparePayProcessors,
  sanitizePayProcessor,
  type PayProcessor,
} from './pay-processors';

/**
 * The STORED rows (not merged over code — callers merge). THROWS on a failed
 * read: a transient DB error must never read as "nobody has saved anything",
 * because the next write would then persist a registry missing every row that
 * was there. Corrupt JSON surfaces as empty and is NOT written back here; only
 * an explicit save may overwrite it.
 */
export async function readPayProcessorRegistry(): Promise<{
  stored: PayProcessor[];
  updatedAt: string | null;
}> {
  const meta = await getAppSettingWithMetaStrict(PAY_PROCESSORS_SETTING_KEY);
  if (!meta) return { stored: [], updatedAt: null };
  try {
    const parsed: unknown = JSON.parse(meta.value);
    if (!Array.isArray(parsed)) return { stored: [], updatedAt: meta.updatedAt };
    return {
      stored: parsed.map(sanitizePayProcessor).filter((p): p is PayProcessor => p !== null),
      updatedAt: meta.updatedAt,
    };
  } catch {
    return { stored: [], updatedAt: meta.updatedAt };
  }
}

const CAS_ATTEMPTS = 4;

/**
 * Read → `mutate(stored)` → compare-and-swap write, retried when someone else
 * wrote between our read and our write. Two Accounting people editing two
 * different processors at the same moment both land; a plain last-write-wins
 * upsert would silently drop one of them (see `casUpdateAppSetting`).
 *
 * `mutate` returns the full next array, or `{ error }` to refuse (e.g. "no such
 * processor") — a refusal is returned as-is, never retried.
 */
export async function mutatePayProcessorRegistry(
  mutate: (stored: PayProcessor[]) => PayProcessor[] | { error: string },
): Promise<{ stored: PayProcessor[] | null; error: string | null; conflict: boolean }> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    let current: { stored: PayProcessor[]; updatedAt: string | null };
    try {
      current = await readPayProcessorRegistry();
    } catch (e) {
      return {
        stored: null,
        error: e instanceof Error ? e.message : 'Could not read the pay processor registry',
        conflict: false,
      };
    }
    const next = mutate(current.stored);
    if (!Array.isArray(next)) return { stored: null, error: next.error, conflict: false };
    const sorted = [...next].sort(comparePayProcessors);
    const res = await casUpdateAppSetting(
      PAY_PROCESSORS_SETTING_KEY,
      JSON.stringify(sorted),
      current.updatedAt,
    );
    if (res.ok) return { stored: sorted, error: null, conflict: false };
    if (res.error) return { stored: null, error: res.error, conflict: false };
    // conflict ⇒ someone else saved first; re-read and re-apply.
  }
  return {
    stored: null,
    error: 'Someone else saved the registry at the same moment — please try again.',
    conflict: true,
  };
}
