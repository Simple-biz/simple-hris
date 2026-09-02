import type { InternShareMode } from './intern-types';

/**
 * The interns' ONE configuration setting: how the orphanage's share is paid.
 *
 *   system_split  — HRIS pays two payees: the intern share to the intern's bank
 *                   and the orphanage share to the orphanage's bank.
 *   intern_remits — the intern is paid 100% and remits the share themselves;
 *                   HRIS records the obligation only.
 *
 * Owned by Ellie/Ralph (Q2). Until it is set, the mini wizard's Lock in is
 * refused — a silent default would move money nobody decided on (the FX-zero
 * gate pattern, per-cycle-fx-zero-placeholder). The PAB rule is NOT here: Ralph
 * fixed it, so it lives in code (intern-pab.ts).
 */
export const INTERN_CONFIG_KEY = 'orphanage.interns.config';

export interface InternConfig {
  shareMode: InternShareMode | null;
}

const MODES: ReadonlySet<string> = new Set<InternShareMode>(['system_split', 'intern_remits']);

export function parseInternConfig(raw: string | null | undefined): InternConfig {
  if (!raw || !raw.trim()) return { shareMode: null };
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { shareMode: null };
    const m = (v as { shareMode?: unknown }).shareMode;
    return { shareMode: typeof m === 'string' && MODES.has(m) ? (m as InternShareMode) : null };
  } catch {
    return { shareMode: null };
  }
}

export function serializeInternConfig(cfg: InternConfig): string {
  return JSON.stringify({ shareMode: cfg.shareMode });
}
