import type { AuthzOk } from '@/lib/auth/authorize-email';

/**
 * The audit actor for a sheet-sync run (`csv.master.sync`, `csv.hsl.sync`).
 *
 * The syncs are reachable two ways (`cron-auth.ts`): the scheduled cron with a
 * Bearer secret, or a person clicking Sync in the Payroll Wizard / Admin. Every
 * run used to be recorded as "GSheets Sync" / "System", so a manual re-sync of
 * the master list — which re-stamps departments the wizard pays by — had no
 * human on the record (2026-09-28 inventory, session log item 240). A manual run
 * now names the verified session; only the scheduled run is the system.
 */
export function syncRunActor(
  session: AuthzOk | null,
  system: { name: string; role: string },
): { user_name: string; user_role: string; trigger: 'manual' | 'cron' } {
  return session
    ? { user_name: session.sessionEmail, user_role: session.roles[0] ?? 'user', trigger: 'manual' }
    : { user_name: system.name, user_role: system.role, trigger: 'cron' };
}
