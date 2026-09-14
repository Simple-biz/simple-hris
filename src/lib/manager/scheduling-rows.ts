/**
 * The row ↔ `SchedulePeriod` boundary for Manager → My Team → HSL → Scheduling,
 * and the predicate deciding which departments carry the tab at all.
 *
 * Pure — no I/O — so the mapping and the capability rule are unit-tested without
 * a database. `SchedulePeriod` was written before the table existed
 * (`manager-scheduling.md`, UI-first), so this module is where the two are made
 * to agree, and the one place a column name appears next to a field name.
 */
import type { SchedulePeriod, Weekday } from '@/lib/manager/scheduling';
import { WEEKDAYS } from '@/lib/manager/scheduling';
import { isHslFamilyLabel } from '@/lib/departments/hsl-subdept';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';

/** A row of `employee_schedule_periods`, exactly as PostgREST returns it. */
export interface SchedulePeriodRow {
  id: string;
  work_email: string;
  member_name: string | null;
  department: string;
  rest_days: number[] | null;
  shift_start_minute: number | null;
  shift_end_minute: number | null;
  timezone: string | null;
  effective_from: string;
  effective_to: string | null;
}

/** The workforce's zone — every Hubstaff row measured carries it. */
export const DEFAULT_SCHEDULE_TIMEZONE = 'America/New_York';

function isWeekday(n: number): n is Weekday {
  return Number.isInteger(n) && n >= 0 && n <= 6;
}

/**
 * Which rest-day numbers survive a read.
 *
 * A value outside 0–6 is DROPPED rather than coerced. The column has a CHECK
 * that makes one impossible, so a stray value means something wrote past the
 * constraint — and silently turning a 7 into a Sunday would invent a rest day
 * nobody asked for. Dropping it leaves the person scheduled that day, which is
 * the direction that shows up as a question rather than as a quiet absence.
 */
export function readRestDays(raw: number[] | null | undefined): Weekday[] {
  const out = (raw ?? []).filter(isWeekday);
  return [...new Set(out)].sort((a, b) => a - b) as Weekday[];
}

/**
 * Row → `SchedulePeriod`.
 *
 * **A window is BOTH minutes or neither.** The column pair has a CHECK enforcing
 * it, and this mirrors it rather than trusting it: one-sided data would otherwise
 * become a window starting or ending at midnight, which is precisely the
 * "hours not set rendered as 00:00" bug the model exists to prevent.
 */
export function toSchedulePeriod(row: SchedulePeriodRow): SchedulePeriod {
  const hasWindow = row.shift_start_minute != null && row.shift_end_minute != null;
  return {
    id: row.id,
    workEmail: (row.work_email ?? '').trim().toLowerCase(),
    name: (row.member_name ?? '').trim(),
    department: (row.department ?? '').trim(),
    restDays: readRestDays(row.rest_days),
    shiftWindow: hasWindow
      ? { startMinute: row.shift_start_minute as number, endMinute: row.shift_end_minute as number }
      : null,
    timezone: (row.timezone ?? '').trim() || DEFAULT_SCHEDULE_TIMEZONE,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}

/** `SchedulePeriod` → the writable columns. `id` is omitted so the database mints it. */
export function toScheduleRow(p: SchedulePeriod): Omit<SchedulePeriodRow, 'id'> {
  return {
    work_email: p.workEmail.trim().toLowerCase(),
    member_name: p.name.trim() || null,
    department: p.department.trim(),
    rest_days: readRestDays(p.restDays),
    shift_start_minute: p.shiftWindow ? p.shiftWindow.startMinute : null,
    shift_end_minute: p.shiftWindow ? p.shiftWindow.endMinute : null,
    timezone: p.timezone.trim() || DEFAULT_SCHEDULE_TIMEZONE,
    effective_from: p.effectiveFrom,
    effective_to: p.effectiveTo,
  };
}

/**
 * Does this department carry the Scheduling tab?
 *
 * **HSL only** (Kane, 2026-09-14: *"Scheduling will be inside HSL Department only
 * so when we click HSL Department we should have a tab inside it"*). The whole
 * family qualifies — the parent and every `hsl:*` sub-team — because the rail is
 * the scoping control: selecting the parent sets all 591, selecting a sub-team
 * sets that team.
 *
 * This is the first entry in the per-department capability map. When a second
 * department earns its own surface, this becomes a lookup rather than a
 * predicate — but one department does not justify a registry yet, and a
 * premature one would be harder to read than the rule it replaces.
 *
 * Accepts either a rail KEY (`hogan_smith_law`, `hsl:intake_specialist`) or a raw
 * master-list cell, since the rail carries keys and the roster carries cells.
 */
export function departmentHasScheduling(deptKeyOrLabel: string | null | undefined): boolean {
  const raw = (deptKeyOrLabel ?? '').trim();
  if (!raw) return false;
  if (isHslFamilyLabel(raw)) return true;
  // A rail key for the family parent normalises to itself; a `hsl:*` sub-key
  // collapses onto it. Either is the HSL family.
  return normalizeDeptToKey(raw) === 'hogan_smith_law';
}

/** Rest days are stored as numbers; this is the only place they become `Weekday`. */
export const SCHEDULE_WEEKDAYS = WEEKDAYS;
