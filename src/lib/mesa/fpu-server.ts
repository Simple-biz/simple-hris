import 'server-only';

/**
 * Server half of FPU classes + enrollments: table names, the missing-table
 * check, the paged reads and the roster lookup. Routes stay thin.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { normEmail } from '@/lib/email/norm-email';
import type { EmployeeRow } from '@/lib/supabase/employees';
import type { FpuClass, FpuEnrollmentStatus } from './fpu-class';

export const FPU_CLASSES_TABLE = 'fpu_classes';
export const FPU_ENROLLMENTS_TABLE = 'fpu_enrollments';

/** PostgREST's code for "relation does not exist". */
const UNDEFINED_TABLE = '42P01';
/** PostgREST's code for "column does not exist" — the ALTER half not applied. */
const UNDEFINED_COLUMN = '42703';

/**
 * Is this error the migration simply not having run yet? The DDL ships as a
 * script with an `--apply` gate that Kane runs, so the code can be deployed
 * first. That window must read as "not migrated yet", not as a 500. A REAL
 * error check — never `head: true` (memory/postgrest-head-true-hides-missing-table).
 */
export function isFpuNotMigrated(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === UNDEFINED_TABLE || err.code === UNDEFINED_COLUMN) return true;
  const m = (err.message ?? '').toLowerCase();
  return (m.includes('does not exist') || m.includes('schema cache')) && (m.includes('fpu_') || m.includes('class_id') || m.includes('status'));
}

export interface FpuClassRow extends FpuClass {
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FpuEnrollmentRow {
  id: string;
  email: string;
  full_name: string;
  department: string;
  shift_schedule_est: string;
  created_at: string;
  class_id: string | null;
  status: FpuEnrollmentStatus;
  start_date_used: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  completed_on: string | null;
}

export const FPU_CLASS_SELECT =
  'id, year, batch, opens_on, closes_on, class_starts_on, class_ends_on, schedule_note, name, enrollment_closed_on, enrollment_closed_by, created_by, created_at, updated_at';

export const FPU_ENROLLMENT_SELECT =
  'id, email, full_name, department, shift_schedule_est, created_at, class_id, status, start_date_used, reviewed_by, reviewed_at, review_notes, completed_on';

type Sb = SupabaseClient;

export async function listFpuClasses(
  sb: Sb,
): Promise<{ classes: FpuClassRow[]; error: string | null; migrated: boolean }> {
  const res = await sb.from(FPU_CLASSES_TABLE).select(FPU_CLASS_SELECT).order('year', { ascending: false }).order('batch', { ascending: false }).limit(500);
  if (res.error) {
    if (isFpuNotMigrated(res.error)) return { classes: [], error: null, migrated: false };
    return { classes: [], error: res.error.message, migrated: true };
  }
  return { classes: (res.data ?? []) as FpuClassRow[], error: null, migrated: true };
}

/**
 * Enrollments, paged. `classId` narrows to one class; `emails` narrows to one
 * person's addresses (work + personal + alternates). With neither, every row
 * that belongs to a class — legacy pre-class rows (class_id NULL) are never
 * returned.
 */
export async function listFpuEnrollments(
  sb: Sb,
  filter: { classId?: string | null; emails?: string[] } = {},
): Promise<{ rows: FpuEnrollmentRow[]; error: string | null; migrated: boolean }> {
  const emails = (filter.emails ?? []).map((e) => normEmail(e)).filter((e): e is string => !!e);
  if (filter.emails && emails.length === 0) return { rows: [], error: null, migrated: true };
  const { rows, error } = await selectAllPaged<FpuEnrollmentRow>((from, to) => {
    let q = sb.from(FPU_ENROLLMENTS_TABLE).select(FPU_ENROLLMENT_SELECT).not('class_id', 'is', null);
    if (filter.classId) q = q.eq('class_id', filter.classId);
    if (emails.length) q = q.in('email', emails);
    return q.order('created_at', { ascending: false }).order('id', { ascending: true }).range(from, to);
  });
  if (error) {
    if (isFpuNotMigrated({ message: error })) return { rows: [], error: null, migrated: false };
    return { rows: [], error, migrated: true };
  }
  return { rows, error: null, migrated: true };
}

/** Every normalized email a roster row answers to. */
export function rosterRowEmails(row: EmployeeRow): string[] {
  return [row.work_email, row.personal_email, row.alternate_work_email, row.alternate_work_email_2]
    .map((e) => normEmail(e ?? ''))
    .filter((e): e is string => !!e);
}

/** The active-roster row that carries `email` under any of its addresses. */
export function findRosterRow(employees: EmployeeRow[], email: string): EmployeeRow | null {
  const target = normEmail(email);
  if (!target) return null;
  return employees.find((r) => rosterRowEmails(r).includes(target)) ?? null;
}
