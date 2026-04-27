import { getAppSetting, upsertAppSetting } from "./app-settings";

export const LOCK_KEY = "payroll.dispatch_locked";
export const LOCKED_AT_KEY = "payroll.dispatch_locked_at";
export const LOCKED_BY_KEY = "payroll.dispatch_locked_by";

export interface PayrollDispatchLockState {
  locked: boolean;
  lockedAt: string | null;
  lockedBy: string | null;
}

function parseLocked(value: string | null): boolean {
  if (value == null) return false;
  return String(value).trim().toLowerCase() === "true";
}

export async function getPayrollDispatchLock(): Promise<PayrollDispatchLockState> {
  const [lockedRaw, atRaw, byRaw] = await Promise.all([
    getAppSetting(LOCK_KEY),
    getAppSetting(LOCKED_AT_KEY),
    getAppSetting(LOCKED_BY_KEY),
  ]);
  return {
    locked: parseLocked(lockedRaw),
    lockedAt: atRaw && atRaw.trim() ? atRaw : null,
    lockedBy: byRaw && byRaw.trim() ? byRaw : null,
  };
}

export async function setPayrollDispatchLock(
  locked: boolean,
  actorEmail: string | null,
): Promise<{ state: PayrollDispatchLockState; error: string | null }> {
  const nowISO = new Date().toISOString();
  const [a, b, c] = await Promise.all([
    upsertAppSetting(LOCK_KEY, locked ? "true" : "false"),
    upsertAppSetting(LOCKED_AT_KEY, locked ? nowISO : ""),
    upsertAppSetting(LOCKED_BY_KEY, locked ? (actorEmail ?? "") : ""),
  ]);
  const firstErr = a.error ?? b.error ?? c.error;
  if (firstErr) return { state: await getPayrollDispatchLock(), error: firstErr };
  return { state: await getPayrollDispatchLock(), error: null };
}
