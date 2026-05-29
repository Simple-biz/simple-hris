import { NextRequest, NextResponse } from 'next/server';
import {
  getSkillSet,
  listSkillSetsForEmails,
  upsertSkillSet,
  type UpsertSkillSetInput,
} from '@/lib/supabase/employee-skill-sets';
import { SKILL_SET_TITLES } from '@/lib/skill-set-titles';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_FIELD_LEN = 4000;
const VALID_ROLE_TITLES = new Set<string>(SKILL_SET_TITLES);

/**
 * GET ?email=foo@bar       -> single row (returns empty defaults if missing)
 * GET ?emails=a@x,b@y      -> bulk fetch (for My Team read-only view)
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const single = searchParams.get('email')?.trim() ?? '';
  const bulk = searchParams.get('emails')?.trim() ?? '';

  if (bulk) {
    const emails = bulk
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    const { rows, error } = await listSkillSetsForEmails(emails);
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
    return NextResponse.json({ rows, error: null });
  }

  if (!single) {
    return NextResponse.json({ row: null, error: 'email or emails is required' }, { status: 400 });
  }
  const { row, error } = await getSkillSet(single);
  if (error) return NextResponse.json({ row: null, error }, { status: 500 });
  return NextResponse.json({ row, error: null });
}

/**
 * PUT — employee self-edit. Body: { work_email, role_title, currently_working_on, skills, strengths }
 *
 * `member_notes` is intentionally NOT writable here: it is a manager-authored
 * note about the teammate, edited only via PUT /api/manager/member-notes. Any
 * member_notes sent to this endpoint is stripped before the upsert.
 */
export async function PUT(req: NextRequest) {
  let body: UpsertSkillSetInput;
  try {
    body = (await req.json()) as UpsertSkillSetInput;
  } catch {
    return NextResponse.json({ row: null, error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body?.work_email?.trim()) {
    return NextResponse.json({ row: null, error: 'work_email is required' }, { status: 400 });
  }

  // Employees cannot author their own member notes — drop the field if present.
  delete body.member_notes;

  const fields: (keyof UpsertSkillSetInput)[] = [
    'role_title',
    'currently_working_on',
    'skills',
    'strengths',
  ];
  for (const k of fields) {
    const v = body[k];
    if (v != null && typeof v === 'string' && v.length > MAX_FIELD_LEN) {
      return NextResponse.json(
        { row: null, error: `${k} exceeds ${MAX_FIELD_LEN} characters` },
        { status: 400 },
      );
    }
  }
  if (body.role_title && !VALID_ROLE_TITLES.has(body.role_title)) {
    return NextResponse.json(
      { row: null, error: 'role_title is not a valid option' },
      { status: 400 },
    );
  }

  // Free-typed string arrays. The personal `projects` list is unlimited; only
  // the "currently working on" selection is bounded (1-2, display joins them
  // with " and "). Each name length is bounded as a guard.
  const MAX_CURRENT_PROJECTS = 2;
  const MAX_PROJECT_NAME_LEN = 120;
  for (const k of ['projects', 'current_projects'] as const) {
    const v = body[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((p) => typeof p !== 'string')) {
      return NextResponse.json({ row: null, error: `${k} must be an array of strings` }, { status: 400 });
    }
    if (v.some((p) => p.length > MAX_PROJECT_NAME_LEN)) {
      return NextResponse.json(
        { row: null, error: `project names must be at most ${MAX_PROJECT_NAME_LEN} characters` },
        { status: 400 },
      );
    }
  }
  if (Array.isArray(body.current_projects) && body.current_projects.length > MAX_CURRENT_PROJECTS) {
    return NextResponse.json(
      { row: null, error: `Select at most ${MAX_CURRENT_PROJECTS} current projects` },
      { status: 400 },
    );
  }

  const { row, error } = await upsertSkillSet(body);
  if (error || !row) {
    return NextResponse.json(
      { row: null, error: error ?? 'Save failed' },
      { status: 500 },
    );
  }
  return NextResponse.json({ row, error: null });
}
