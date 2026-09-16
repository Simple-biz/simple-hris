import { NextRequest, NextResponse } from 'next/server';
import { requireAdminSession, deniedResponse } from '@/lib/auth/authorize-email';
import { getClient, listExternalApiRequests } from '@/lib/supabase/external-api-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/admin/external-api-clients/{id}/requests?limit=100
 * The newest calls this client made — status, denial reason, query, ip,
 * user-agent, duration. This is the "what are they using it for" view.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requireAdminSession();
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await params;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Invalid client id' }, { status: 400 });

  const rawLimit = req.nextUrl.searchParams.get('limit');
  const limit = rawLimit && /^\d+$/.test(rawLimit) ? Math.min(Math.max(Number(rawLimit), 1), 500) : 100;

  const client = await getClient(id);
  if (client.error !== null) return NextResponse.json({ error: client.error }, { status: client.missingTable ? 503 : 500 });
  if (!client.data) return NextResponse.json({ error: 'No such client' }, { status: 404 });

  const requests = await listExternalApiRequests(id, limit);
  if (requests.error !== null) return NextResponse.json({ error: requests.error }, { status: 500 });

  return NextResponse.json({ client: client.data, requests: requests.data, limit });
}
