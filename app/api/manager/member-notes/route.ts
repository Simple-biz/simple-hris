import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import { getSkillSet, upsertSkillSet } from '@/lib/supabase/employee-skill-sets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_FIELD_LEN = 4000;

function sessionInfo(session: Awaited<ReturnType<typeof getServerSession>>): {
  email: string | null;
  roles: string[];
  elevated: boolean;
} {
  const user = (session as {
    user?: { email?: string | null; roles?: string[]; elevated?: boolean };
  } | null)?.user;
  const roles = user?.roles ?? [];
  return {
    email: user?.email?.trim().toLowerCase() ?? null,
    roles,
    elevated: user?.elevated ?? hasElevatedRole(roles),
  };
}

/**
 * Authorize the caller as a manager: either an elevated (org-wide) role or an
 * active department-manager assignment. Member notes are manager-authored, so
 * this gate keeps employees from writing them via the API directly.
 */
async function authorizeManager(): Promise<
  { ok: true; email: string } | { ok: false; status: 401 | 403; message: string }
> {
  const session = await getServerSession(authOptions);
  const { email, elevated } = sessionInfo(session);
  if (!email) return { ok: false, status: 401, message: 'Not signed in' };
  if (elevated) return { ok: true, email };
  const { rows } = await listDepartmentsForManager(email);
  if (rows.length === 0) return { ok: false, status: 403, message: 'Manager access required' };
  return { ok: true, email };
}

/** GET ?email=foo@bar — current member notes for a teammate (manager only). */
export async function GET(req: NextRequest) {
  const authz = await authorizeManager();
  if (!authz.ok) return NextResponse.json({ error: authz.message }, { status: authz.status });

  const email = req.nextUrl.searchParams.get('email')?.trim() ?? '';
  if (!email) {
    return NextResponse.json({ error: 'email is required' }, { status: 400 });
  }
  const { row, error } = await getSkillSet(email);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ member_notes: row.member_notes ?? '', error: null });
}

/** PUT { work_email, member_notes } — manager writes a teammate's member notes. */
export async function PUT(req: NextRequest) {
  const authz = await authorizeManager();
  if (!authz.ok) return NextResponse.json({ error: authz.message }, { status: authz.status });

  let body: { work_email?: string; member_notes?: string };
  try {
    body = (await req.json()) as { work_email?: string; member_notes?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const workEmail = body.work_email?.trim();
  if (!workEmail) {
    return NextResponse.json({ error: 'work_email is required' }, { status: 400 });
  }
  const notes = body.member_notes ?? '';
  if (typeof notes !== 'string' || notes.length > MAX_FIELD_LEN) {
    return NextResponse.json(
      { error: `member_notes exceeds ${MAX_FIELD_LEN} characters` },
      { status: 400 },
    );
  }

  const { row, error } = await upsertSkillSet({ work_email: workEmail, member_notes: notes });
  if (error || !row) {
    return NextResponse.json({ error: error ?? 'Save failed' }, { status: 500 });
  }
  return NextResponse.json({ member_notes: row.member_notes, error: null });
}
