/**
 * Server-safe role constants. A user is "elevated" if they hold any of these active roles,
 * which lets them view/act on other employees' data (payroll, disputes, leave, etc.).
 *
 * Must match the role set used by the client-side view picker in `src/lib/rbac/views.ts`
 * (ACCOUNTING_ROLES ∪ {'admin'}). Kept here as a plain module so server code can import it
 * without pulling in a 'use client' file.
 */

export const ELEVATED_ROLES = [
  'admin',
  'payroll_coordinator',
  'payroll_manager',
  'finance',
  'hr_coordinator',
  'viewer',
] as const;

export type ElevatedRole = (typeof ELEVATED_ROLES)[number];

const ELEVATED_SET = new Set<string>(ELEVATED_ROLES);

export function isElevatedRole(role: string | null | undefined): boolean {
  return !!role && ELEVATED_SET.has(role);
}

export function hasElevatedRole(roles: readonly string[] | null | undefined): boolean {
  return !!roles && roles.some((r) => ELEVATED_SET.has(r));
}
