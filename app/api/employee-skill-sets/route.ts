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

/** PUT — employee self-edit. Body: { work_email, currently_working_on, skills, strengths, member_notes } */
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

  const fields: (keyof UpsertSkillSetInput)[] = [
    'role_title',
    'currently_working_on',
    'skills',
    'strengths',
    'member_notes',
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

  const { row, error } = await upsertSkillSet(body);
  if (error || !row) {
    return NextResponse.json(
      { row: null, error: error ?? 'Save failed' },
      { status: 500 },
    );
  }
  return NextResponse.json({ row, error: null });
}
