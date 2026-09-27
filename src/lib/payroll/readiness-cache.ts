/**
 * The per-week readiness snapshot cache — ONE entry per week, shared by every
 * reader of `GET /api/payroll-wizard/readiness`: the Payroll Notes FAB's score
 * ring, its Readiness pane, and the Accounting Overview's Payroll Notes card.
 * Whichever surface pulls a week first spares the others the query.
 *
 * Lived privately inside `PayrollWizardNotesFab.tsx` until 2026-09-26, when the
 * Overview card became a second consumer; moved here unchanged so both import
 * the same window, age ceiling and trim instead of drifting copies.
 *
 * Behaviour (payroll-wizard-notes.md § "No reload on the way back"): younger
 * than {@link READINESS_FRESH_MS} → a remount reuses it with no refetch; older
 * → paint, then revalidate quietly; older than {@link READINESS_MAX_AGE_MS} →
 * treated as absent (cold load). The key is in `tab-cache.test.ts`'s banned
 * list — the skip flag may never gate it.
 */

import { clearTabCache, getTabCache, setTabCache, TAB_CACHE_KEYS } from '@/lib/accounting/tab-cache';
import type { PayrollReadiness } from '@/lib/payroll/payroll-readiness';

/** A readiness snapshot plus when it was pulled, so a remount can tell "seconds
 *  ago" (reuse as-is) from "a while ago" (paint it, then revalidate). */
export type StampedReadiness = { readiness: PayrollReadiness; at: number };

/** Inside this window a remount reuses the cached snapshot with NO refetch — it
 *  matches the pane's own live poll, so a tab bounce can't be staler than
 *  sitting on the tab already was. */
export const READINESS_FRESH_MS = 30_000;

/** Past this, a cached snapshot is too old to show even briefly (e.g. the tab
 *  sat open overnight) — such a load starts from the skeleton instead. */
export const READINESS_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** A readiness snapshot is a sizeable payload, so paging back through a quarter
 *  of weeks would otherwise fill sessionStorage with snapshots nobody will look
 *  at again — only the most recent handful are kept. */
export const READINESS_CACHE_MAX_WEEKS = 4;

export function readCachedReadiness(sourceFile: string | null): StampedReadiness | null {
  const hit = getTabCache<StampedReadiness>(TAB_CACHE_KEYS.payrollReadiness(sourceFile));
  if (!hit?.readiness || typeof hit.at !== 'number') return null;
  return Date.now() - hit.at > READINESS_MAX_AGE_MS ? null : hit;
}

/** Week keys cached this session, oldest first — module scope, so every
 *  consumer's writes share ONE trim. */
const cachedReadinessKeys: string[] = [];

/** Share a freshly-pulled snapshot with every other reader of the same week. */
export function writeCachedReadiness(sourceFile: string | null, readiness: PayrollReadiness): void {
  const key = TAB_CACHE_KEYS.payrollReadiness(sourceFile);
  setTabCache<StampedReadiness>(key, { readiness, at: Date.now() });
  const seen = cachedReadinessKeys.indexOf(key);
  if (seen >= 0) cachedReadinessKeys.splice(seen, 1);
  cachedReadinessKeys.push(key);
  while (cachedReadinessKeys.length > READINESS_CACHE_MAX_WEEKS) {
    clearTabCache(cachedReadinessKeys.shift()!);
  }
}
