// Weekly department pay configuration — the Payroll Wizard's step-1
// "Configuration" tab. Two per-department switches live there:
//
//   • Pay this week — off ⇒ the department is EXCLUDED from that pay run:
//     its workers disappear from every wizard step (calc/additions/validation/
//     dispatch), the Payroll Notes worker picker + rates glance skip it, and
//     the readiness score drops it from every numerator AND denominator (so
//     the score re-curves over the departments actually being paid).
//     Stored PER PAY WEEK — one app_settings JSON array of dept keys (built-in
//     payroll keys and Payment Catalog registry keys alike) under
//     `payroll.wizard.dept_pay_paused.<sourceFile>`, following the wizard's
//     exclusions/additions convention (one Hubstaff file = one pay period).
//     The exclusion applies ONLY to the week it was set on: a new week's
//     upload has no entry, so every department starts that week paying.
//
//   • Overtime — off ⇒ OT hours are zeroed for the department (regular pay
//     only). Reuses the existing per-department `ot_dept_<key>` keys that
//     System Settings writes, so both surfaces stay in lockstep. Unlike the
//     pay switch this is a STANDING setting (no week scoping) — it mirrors
//     System Settings exactly.
//
// Client-safe: constants + pure parsing only, no Supabase imports.

/** Key prefix for the per-pay-week pay-paused sets. */
export const DEPT_PAY_PAUSED_SETTING_PREFIX = 'payroll.wizard.dept_pay_paused.';

/** app_settings key holding the JSON array of dept keys excluded from the
 *  given pay week (`sourceFile` = the week's Hubstaff upload filename). */
export function deptPayPausedSettingKey(sourceFile: string): string {
  return `${DEPT_PAY_PAUSED_SETTING_PREFIX}${sourceFile}`;
}

/** The per-department OT suspension key System Settings already uses.
 *  Absent/`'true'` = OT on; `'false'` = OT suspended for the department. */
export function otDeptSettingKey(deptKey: string): string {
  return `ot_dept_${deptKey}`;
}

/** Parse the stored JSON array into a Set of dept keys. Malformed or absent
 *  values read as "nothing paused" — the safe default (everyone gets paid). */
export function parsePausedDeptKeys(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(
      arr
        .filter((k): k is string => typeof k === 'string')
        .map((k) => k.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/** Serialize a paused-key set for storage (sorted, deduped — stable diffs). */
export function serializePausedDeptKeys(keys: Iterable<string>): string {
  return JSON.stringify([...new Set(keys)].sort());
}
