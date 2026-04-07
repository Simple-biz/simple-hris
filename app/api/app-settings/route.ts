import { NextResponse } from 'next/server';
import { getAppSetting, upsertAppSetting } from '@/lib/supabase/app-settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');
  if (!key) {
    return NextResponse.json({ value: null, error: 'Missing key parameter' }, { status: 400 });
  }
  try {
    const value = await getAppSetting(key);
    return NextResponse.json({ value, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ value: null, error: msg }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { key?: string; value?: string };
    if (!body.key || body.value === undefined) {
      return NextResponse.json({ error: 'Missing key or value' }, { status: 400 });
    }
    const { error } = await upsertAppSetting(body.key, body.value);
    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
