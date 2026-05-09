import { NextResponse } from 'next/server';
import {
  listGiftTrackerNotes,
  upsertGiftTrackerNote,
} from '@/lib/supabase/gift-tracker-notes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const { notes, error } = await listGiftTrackerNotes();
  if (error) return NextResponse.json({ notes: [], error }, { status: 500 });
  return NextResponse.json({ notes, error: null });
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as {
      personal_email?: string;
      note?: string;
      updated_by?: string | null;
    };
    const email = body.personal_email?.trim().toLowerCase();
    if (!email) {
      return NextResponse.json({ error: 'Missing personal_email' }, { status: 400 });
    }
    const { error } = await upsertGiftTrackerNote(
      email,
      body.note ?? '',
      body.updated_by ?? null,
    );
    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
