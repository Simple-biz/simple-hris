/** [TERMINATION-DOCS] TEST SUPPORT — the cycle timesheet, under test control.
 *
 * G3's strongest signal is "did this person log hours in the current cycle" —
 * the one thing a stale off-board stamp cannot forge. `loadCycleHoursIndex`
 * cannot be driven through the Supabase double: `listHubstaffUploads` builds its
 * own client from `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` with
 * `createClient` directly (hubstaff-hours-db.ts:20-28), and
 * `getTableColumnsFromSpec` goes out over raw `fetch` to the PostgREST spec
 * endpoint. So this file replaces the LOADER only, and re-exports the REAL
 * `personWorkedCycle` — the matcher (normalized email OR exact name-token key)
 * is the part that decides, and a test that stubbed it would prove nothing.
 *
 * `./stub-server-modules.ts` redirects `@/lib/payroll/cycle-hours-index` here.
 * The relative import below deliberately bypasses that redirect (only the bare
 * `@/`-specifier is mapped), so the real module is still what is loaded — which
 * also means THIS FILE MUST NOT be imported from a test file's static imports:
 * it would pull `server-only` in before the hook exists. Tests import the
 * controls from `./cycle-hours-control.ts` instead.
 */
import { personWorkedCycle } from '../../../payroll/cycle-hours-index';
import type { CycleHoursIndex } from '../../../payroll/cycle-hours-index';
import { readTestCycleHours, recordCycleHoursCall } from './cycle-hours-control';

export { personWorkedCycle };
export type { CycleHoursIndex };

export async function loadCycleHoursIndex(sourceFile: string | null): Promise<CycleHoursIndex> {
  recordCycleHoursCall(sourceFile);
  const spec = readTestCycleHours();
  return {
    emails: new Set(spec.emails ?? []),
    nameTokenKeys: new Set(spec.nameTokenKeys ?? []),
    sourceFile: spec.sourceFile ?? 'cycle-2026-08-22.csv',
    error: spec.error ?? null,
  };
}

/** Compile-time pin against the real loader's signature — see
 *  `./supabase-server-stub.ts` for why every stub carries one. */
export type RealCycleHoursLoader = typeof import('@/lib/payroll/cycle-hours-index').loadCycleHoursIndex;
export const CYCLE_HOURS_LOADER: RealCycleHoursLoader = loadCycleHoursIndex;
