import 'server-only';

/**
 * Server half of FPU groups + session attendance: table names, the paged reads,
 * and the two identity questions the employee surface turns on — "which group am
 * I in" and "which group do I lead". Routes stay thin.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { normEmail } from '@/lib/email/norm-email';
import { isFpuNotMigrated } from './fpu-server';

export const FPU_GROUPS_TABLE = 'fpu_class_groups';
export const FPU_GROUP_MEMBERS_TABLE = 'fpu_group_members';
export const FPU_ATTENDANCE_TABLE = 'fpu_session_attendance';

export const FPU_GROUP_SELECT = 'id, class_id, group_no, leader_enrollment_id, created_by, created_at, updated_at';
export const FPU_GROUP_MEMBER_SELECT = 'id, group_id, enrollment_id, email, left_on, left_reason, created_at';
export const FPU_ATTENDANCE_SELECT = 'id, enrollment_id, class_id, session_no, present, marked_by, marked_at, note';

export interface FpuGroupRow {
  id: string;
  class_id: string;
  group_no: number;
  leader_enrollment_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FpuGroupMemberRow {
  id: string;
  group_id: string;
  enrollment_id: string;
  email: string;
  left_on: string | null;
  left_reason: string | null;
  created_at: string;
}

export interface FpuAttendanceRow {
  id: string;
  enrollment_id: string;
  class_id: string;
  session_no: number;
  present: boolean;
  marked_by: string;
  marked_at: string;
  note: string | null;
}

type Sb = SupabaseClient;
type Paged<T> = { rows: T[]; error: string | null; migrated: boolean };

function pagedResult<T>(rows: T[], error: string | null): Paged<T> {
  if (error) {
    if (isFpuNotMigrated({ message: error })) return { rows: [], error: null, migrated: false };
    return { rows: [], error, migrated: true };
  }
  return { rows, error: null, migrated: true };
}

/** Every group of a class, lowest number first. */
export async function listClassGroups(sb: Sb, classId: string): Promise<Paged<FpuGroupRow>> {
  const { rows, error } = await selectAllPaged<FpuGroupRow>((from, to) =>
    sb.from(FPU_GROUPS_TABLE).select(FPU_GROUP_SELECT).eq('class_id', classId).order('group_no', { ascending: true }).range(from, to),
  );
  return pagedResult(rows, error);
}

/** Every member row of the given groups. Paged — a class can outgrow 1000 rows. */
export async function listGroupMembers(sb: Sb, groupIds: readonly string[]): Promise<Paged<FpuGroupMemberRow>> {
  if (groupIds.length === 0) return { rows: [], error: null, migrated: true };
  const { rows, error } = await selectAllPaged<FpuGroupMemberRow>((from, to) =>
    sb
      .from(FPU_GROUP_MEMBERS_TABLE)
      .select(FPU_GROUP_MEMBER_SELECT)
      .in('group_id', groupIds as string[])
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  return pagedResult(rows, error);
}

/** Every attendance mark of a class. */
export async function listClassAttendance(sb: Sb, classId: string): Promise<Paged<FpuAttendanceRow>> {
  const { rows, error } = await selectAllPaged<FpuAttendanceRow>((from, to) =>
    sb
      .from(FPU_ATTENDANCE_TABLE)
      .select(FPU_ATTENDANCE_SELECT)
      .eq('class_id', classId)
      .order('session_no', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  return pagedResult(rows, error);
}

/** `enrollment_id` → (`session_no` → present). The shape the verdict takes. */
export function indexAttendance(rows: readonly FpuAttendanceRow[]): Map<string, Map<number, boolean>> {
  const out = new Map<string, Map<number, boolean>>();
  for (const r of rows) {
    const inner = out.get(r.enrollment_id) ?? new Map<number, boolean>();
    inner.set(r.session_no, r.present);
    out.set(r.enrollment_id, inner);
  }
  return out;
}

export interface FpuMembership {
  group: FpuGroupRow;
  /** Every member row of that group, leavers included. */
  members: FpuGroupMemberRow[];
  /** This person's own row. */
  mine: FpuGroupMemberRow;
  /** Does this person LEAD the group they are in? */
  isLeader: boolean;
}

/**
 * The group this email belongs to, if any — the single read behind both the
 * employee's "my group" card and the per-row authorization for marking.
 *
 * **Leadership is re-read here on every call, never trusted from the client.** A
 * leader who is replaced must lose the capability on their next request, and a
 * cached flag would leave it live.
 */
export async function findMembership(sb: Sb, email: string): Promise<{ membership: FpuMembership | null; error: string | null; migrated: boolean }> {
  const target = normEmail(email);
  if (!target) return { membership: null, error: null, migrated: true };

  const mine = await sb.from(FPU_GROUP_MEMBERS_TABLE).select(FPU_GROUP_MEMBER_SELECT).eq('email', target).is('left_on', null).maybeSingle();
  if (mine.error) {
    if (isFpuNotMigrated(mine.error)) return { membership: null, error: null, migrated: false };
    return { membership: null, error: mine.error.message, migrated: true };
  }
  if (!mine.data) return { membership: null, error: null, migrated: true };
  const row = mine.data as FpuGroupMemberRow;

  const group = await sb.from(FPU_GROUPS_TABLE).select(FPU_GROUP_SELECT).eq('id', row.group_id).maybeSingle();
  if (group.error) return { membership: null, error: group.error.message, migrated: true };
  if (!group.data) return { membership: null, error: null, migrated: true };
  const g = group.data as FpuGroupRow;

  const members = await listGroupMembers(sb, [g.id]);
  if (members.error) return { membership: null, error: members.error, migrated: true };

  return {
    membership: { group: g, members: members.rows, mine: row, isLeader: g.leader_enrollment_id === row.enrollment_id },
    error: null,
    migrated: true,
  };
}
