import { NextRequest, NextResponse } from 'next/server';
import { getSecondaryServiceClient } from '@/lib/supabase/secondary';

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) return String((err as Record<string, unknown>).message);
  return String(err);
}

// GET /api/secondary/hubstaff-projects
export async function GET(_req: NextRequest) {
  try {
    const supabase = getSecondaryServiceClient();
    const { data, error } = await supabase
      .from('hubstaff_projects')
      .select('*')
      .order('name', { ascending: true });
    if (error) throw error;
    return NextResponse.json({ projects: data ?? [] });
  } catch (err) {
    return NextResponse.json({ error: errMsg(err), projects: [] }, { status: 500 });
  }
}
