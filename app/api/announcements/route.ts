import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { type NextRequest } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import {
  listAnnouncements,
  insertAnnouncement,
  lookupFullNameForEmail,
} from '@/lib/supabase/announcements';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Roles that can post to the general wall. */
const GENERAL_POST_ROLES = new Set([
  'admin',
  'ceo',
  'hr_coordinator',
  'finance',
  'payroll_coordinator',
  'payroll_manager',
  'orphanage_manager',
]);

async function getRoles(email: string): Promise<string[]> {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return [];
  const { data } = await sb
    .from('employee_roles')
    .select('role')
    .ilike('work_email', email)
    .is('revoked_at', null);
  return (data ?? []).map((r: { role: string }) => r.role);
}

// GET /api/announcements
// Query params:
//   scope=all           → admin/ceo: all announcements
//   scope=general       → general only
//   department=Eng,HR   → general + those departments
export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const scope = searchParams.get('scope');           // 'all' | 'general' | null
  const deptParam = searchParams.get('department');  // comma-separated

  let departments: string[] | null = null;

  if (scope === 'all') {
    departments = null; // no filter
  } else if (scope === 'general') {
    departments = [];
  } else if (deptParam) {
    departments = deptParam.split(',').map((d) => d.trim()).filter(Boolean);
  } else {
    departments = []; // fallback: general only
  }

  try {
    const rows = await listAnnouncements({ departments });
    return NextResponse.json({ announcements: rows });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// POST /api/announcements
// Body: { title, body, scope, department?, pinned? }
export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const email = ((token.email as string) ?? '').trim().toLowerCase();
  // Prefer the canonical roster name from the master list over whatever
  // NextAuth's JWT got from the OAuth profile (often a truncated first name).
  const fullName = await lookupFullNameForEmail(email);
  const name = fullName ?? (token.name as string | null) ?? null;

  try {
    const body = (await req.json()) as {
      title?: string;
      body?: string;
      scope?: string;
      department?: string | null;
      pinned?: boolean;
    };

    if (!body.title?.trim()) return NextResponse.json({ error: 'title is required' }, { status: 400 });
    if (!body.body?.trim()) return NextResponse.json({ error: 'body is required' }, { status: 400 });
    if (!['general', 'department'].includes(body.scope ?? '')) {
      return NextResponse.json({ error: 'scope must be general or department' }, { status: 400 });
    }

    const roles = await getRoles(email);

    if (body.scope === 'general') {
      if (!roles.some((r) => GENERAL_POST_ROLES.has(r))) {
        return NextResponse.json({ error: 'Not authorized to post general announcements' }, { status: 403 });
      }
    }

    if (body.scope === 'department') {
      if (!body.department?.trim()) {
        return NextResponse.json({ error: 'department is required for department-scoped announcements' }, { status: 400 });
      }
      const canPost =
        roles.some((r) => GENERAL_POST_ROLES.has(r)) || roles.includes('manager');
      if (!canPost) {
        return NextResponse.json({ error: 'Not authorized to post department announcements' }, { status: 403 });
      }
    }

    // Only admin/ceo can pin
    const pinned = (body.pinned ?? false) && roles.some((r) => r === 'admin' || r === 'ceo');

    const row = await insertAnnouncement({
      author_email: email,
      author_name: name,
      scope: body.scope as 'general' | 'department',
      department: body.scope === 'department' ? (body.department ?? null) : null,
      title: body.title,
      body: body.body,
      pinned,
    });

    return NextResponse.json({ announcement: row });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
