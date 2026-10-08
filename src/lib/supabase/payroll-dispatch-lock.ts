import { getAppSetting, getAppSettingStrict, upsertAppSetting } from "./app-settings";

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

/**
 * The dispatch lock as a WRITE GATE on a payout change: `open`, `locked`, or
 * `unknown` when the read failed.
 *
 * `getPayrollDispatchLock` above reads through `getAppSetting`, which returns
 * null on a read error, and `parseLocked(null)` is false. So for a gate it fails
 * OPEN: a database blip during a dispatch would let a salary be redirected
 * mid-payment (Open item 266 #2). This one reads through `getAppSettingStrict`,
 * which THROWS on a failed read, and reports that as `unknown` so the caller
 * refuses. An absent key is still `open`: it means the lock was never set.
 *
 * Used by the two self-service bank saves (`/api/bank-update/save`,
 * `/api/update-employee-ids`). The other callers of `getPayrollDispatchLock`
 * are unchanged; the same fail-open read under People → Banking, the contractor
 * profile and the shared processing guard (`src/lib/payroll/processing-guard.ts`)
 * is recorded, not fixed here.
 * `read` is injectable for the test.
 */
export type PayrollDispatchLockGate = "open" | "locked" | "unknown";

export async function getPayrollDispatchLockGate(
  read: (key: string) => Promise<string | null> = getAppSettingStrict,
): Promise<PayrollDispatchLockGate> {
  try {
    return parseLocked(await read(LOCK_KEY)) ? "locked" : "open";
  } catch (e) {
    console.error("[payroll-dispatch-lock] lock read failed; treating as unknown (refuse):", e);
    return "unknown";
  }
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
