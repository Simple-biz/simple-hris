import { NextResponse } from 'next/server';
import { requireAdminSession, deniedResponse } from '@/lib/auth/authorize-email';
import { upsertAppSetting } from '@/lib/supabase/app-settings';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import {
  ANTHROPIC_API_KEY_SETTING,
  maskAnthropicKey,
  resolveAnthropicApiKey,
} from '@/lib/anthropic/api-key';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Admin-only management of the Anthropic (Claude) API key powering the CEO chat
 * assistant. The full key is NEVER returned to the client — only a masked
 * preview plus which source is active (DB override vs the server env var).
 * The DB value takes precedence over `ANTHROPIC_API_KEY` (see resolver).
 *
 *  GET    → { configured, masked, source }
 *  POST   { key } → upserts the DB override → { success, configured, masked, source:'db' }
 *  DELETE → removes the DB override (reverts to the env var) → { success, ...status }
 */

async function statusPayload() {
  const { key, source } = await resolveAnthropicApiKey();
  return {
    configured: !!key,
    masked: key ? maskAnthropicKey(key) : null,
    source,
  };
}

export async function GET() {
  const authz = await requireAdminSession();
  if (!authz.ok) return deniedResponse(authz);
  try {
    return NextResponse.json(await statusPayload());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to read key status' },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const authz = await requireAdminSession();
  if (!authz.ok) return deniedResponse(authz);

  let body: { key?: string };
  try {
    body = (await req.json()) as { key?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const key = (body.key ?? '').trim();
  if (!key) {
    return NextResponse.json({ error: 'API key is required' }, { status: 400 });
  }
  if (!key.startsWith('sk-ant-')) {
    return NextResponse.json(
      { error: 'That does not look like an Anthropic API key — it should start with "sk-ant-".' },
      { status: 400 },
    );
  }
  if (key.length < 20) {
    return NextResponse.json({ error: 'That API key looks too short.' }, { status: 400 });
  }

  const { error } = await upsertAppSetting(ANTHROPIC_API_KEY_SETTING, key);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ success: true, ...(await statusPayload()) });
}

export async function DELETE() {
  const authz = await requireAdminSession();
  if (!authz.ok) return deniedResponse(authz);

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const { error } = await supabase
    .from('app_settings')
    .delete()
    .eq('key', ANTHROPIC_API_KEY_SETTING);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, ...(await statusPayload()) });
}
