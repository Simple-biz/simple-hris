import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { fpuClassLabel, nextFpuBatch, validateFpuClassInput, type FpuEnrollmentStatus } from '@/lib/mesa/fpu-class';
import {
  FPU_CLASSES_TABLE,
  FPU_CLASS_SELECT,
  isFpuNotMigrated,
  listFpuClasses,
  listFpuEnrollments,
  type FpuClassRow,
} from '@/lib/mesa/fpu-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505';

export type FpuClassCounts = Record<FpuEnrollmentStatus, number>;

const zeroCounts = (): FpuClassCounts => ({ pending: 0, approved: 0, denied: 0, completed: 0 });

/**
 * GET /api/hr/fpu-classes — every class, newest first, with per-status
 * enrollment counts. `migrated: false` when the table is not there yet.
 * Gate: HR · MESA · view.
 */
export async function GET() {
  const authz = await requireFeatureAccess('hr', 'mesa', 'view');
  if (!authz.ok) return deniedResponse(authz);
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const [classes, enrollments] = await Promise.all([listFpuClasses(sb), listFpuEnrollments(sb)]);
  if (classes.error) return NextResponse.json({ error: classes.error }, { status: 500 });
  if (enrollments.error) return NextResponse.json({ error: enrollments.error }, { status: 500 });

  const counts: Record<string, FpuClassCounts> = {};
  for (const c of classes.classes) counts[c.id] = zeroCounts();
  for (const e of enrollments.rows) {
    if (!e.class_id) continue;
    const bucket = (counts[e.class_id] ??= zeroCounts());
    if (e.status in bucket) bucket[e.status] += 1;
  }

  return NextResponse.json({
    classes: classes.classes,
    counts,
    migrated: classes.migrated && enrollments.migrated,
    error: null,
  });
}

/**
 * POST /api/hr/fpu-classes — create a class. `batch` defaults to the next
 * number in that year. Gate: HR · MESA · edit.
 */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureAccess('hr', 'mesa', 'edit');
  if (!authz.ok) return deniedResponse(authz);
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (body.batch == null || body.batch === '') {
    const existing = await listFpuClasses(sb);
    if (existing.error) return NextResponse.json({ error: existing.error }, { status: 500 });
    if (!existing.migrated) return NextResponse.json({ error: 'FPU classes are not set up yet — run the migration first.', migrated: false }, { status: 503 });
    body.batch = nextFpuBatch(existing.classes, Number(body.year));
  }

  const v = validateFpuClassInput(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const res = await sb
    .from(FPU_CLASSES_TABLE)
    .insert({ ...v.value, created_by: authz.sessionEmail, updated_by: authz.sessionEmail })
    .select(FPU_CLASS_SELECT)
    .single();
  if (res.error) {
    if (isFpuNotMigrated(res.error)) return NextResponse.json({ error: 'FPU classes are not set up yet — run the migration first.', migrated: false }, { status: 503 });
    if (res.error.code === UNIQUE_VIOLATION) return NextResponse.json({ error: `${fpuClassLabel(v.value)} already exists.` }, { status: 409 });
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const cls = res.data as FpuClassRow;

  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'fpu.class.created',
    resource: FPU_CLASSES_TABLE,
    resource_id: cls.id,
    details: { label: fpuClassLabel(cls), ...v.value },
  });

  return NextResponse.json({ class: cls, error: null });
}

/**
 * PATCH /api/hr/fpu-classes — edit a class. Body is the full form (`id` + every
 * field); the same validation as create. Gate: HR · MESA · edit.
 */
export async function PATCH(req: NextRequest) {
  const authz = await requireFeatureAccess('hr', 'mesa', 'edit');
  if (!authz.ok) return deniedResponse(authz);
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
  const v = validateFpuClassInput(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const before = await sb.from(FPU_CLASSES_TABLE).select(FPU_CLASS_SELECT).eq('id', id).maybeSingle();
  if (before.error) return NextResponse.json({ error: before.error.message }, { status: 500 });
  if (!before.data) return NextResponse.json({ error: 'Class not found' }, { status: 404 });

  const res = await sb
    .from(FPU_CLASSES_TABLE)
    .update({ ...v.value, updated_by: authz.sessionEmail })
    .eq('id', id)
    .select(FPU_CLASS_SELECT)
    .single();
  if (res.error) {
    if (res.error.code === UNIQUE_VIOLATION) return NextResponse.json({ error: `${fpuClassLabel(v.value)} already exists.` }, { status: 409 });
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const cls = res.data as FpuClassRow;

  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'fpu.class.updated',
    resource: FPU_CLASSES_TABLE,
    resource_id: cls.id,
    details: { label: fpuClassLabel(cls), before: before.data, after: v.value },
  });

  return NextResponse.json({ class: cls, error: null });
}

/**
 * DELETE /api/hr/fpu-classes?id= — remove a class that has NO enrollments
 * (a class created by mistake). One with enrollments is refused with 409; the
 * FK is `on delete restrict` as the backstop. Gate: HR · MESA · edit.
 */
export async function DELETE(req: NextRequest) {
  const authz = await requireFeatureAccess('hr', 'mesa', 'edit');
  if (!authz.ok) return deniedResponse(authz);
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const id = req.nextUrl.searchParams.get('id')?.trim() ?? '';
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const [cls, enrollments] = await Promise.all([
    sb.from(FPU_CLASSES_TABLE).select(FPU_CLASS_SELECT).eq('id', id).maybeSingle(),
    listFpuEnrollments(sb, { classId: id }),
  ]);
  if (cls.error) return NextResponse.json({ error: cls.error.message }, { status: 500 });
  if (!cls.data) return NextResponse.json({ error: 'Class not found' }, { status: 404 });
  if (enrollments.error) return NextResponse.json({ error: enrollments.error }, { status: 500 });
  if (enrollments.rows.length > 0) {
    return NextResponse.json(
      { error: `${fpuClassLabel(cls.data as FpuClassRow)} has ${enrollments.rows.length} enrollment${enrollments.rows.length === 1 ? '' : 's'} and cannot be deleted.` },
      { status: 409 },
    );
  }

  const del = await sb.from(FPU_CLASSES_TABLE).delete().eq('id', id);
  if (del.error) return NextResponse.json({ error: del.error.message }, { status: 500 });

  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'fpu.class.deleted',
    resource: FPU_CLASSES_TABLE,
    resource_id: id,
    details: { label: fpuClassLabel(cls.data as FpuClassRow), deleted: cls.data },
  });

  return NextResponse.json({ success: true, error: null });
}
