import { NextResponse } from 'next/server';
import { requireAdminSession, deniedResponse } from '@/lib/auth/authorize-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { auditFrom } from '@/lib/audit/context';
import { generateApiKey, hashApiKey, keyPrefix, readPepper } from '@/lib/external-api/keys';
import {
  countRequestsSince,
  createExternalApiClient,
  listClients,
  listUnattributedRequests,
  type ExternalApiClientPublic,
} from '@/lib/supabase/external-api-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Admin-only registry of outside systems allowed to call /api/external/v1/*.
 *
 *  GET  → { clients: [...with 7-day call counts], unattributed: [...denied calls
 *           that matched no client], configured, migration_applied }
 *  POST { name, system, contact_email? } → { client, api_key }
 *
 * The plaintext key appears in exactly ONE response — the POST that created it
 * (and the PATCH that rotates it). It is not stored, so it cannot be shown again;
 * the admin panel says so before the dialog closes.
 */

export type ExternalApiClientView = ExternalApiClientPublic & {
  calls_7d: number;
  denied_7d: number;
};

const NAME_MAX = 80;
const SYSTEM_MAX = 80;

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

export async function GET() {
  const authz = await requireAdminSession();
  if (!authz.ok) return deniedResponse(authz);

  const clients = await listClients();
  if (clients.error !== null) {
    if (clients.missingTable) {
      return NextResponse.json({
        clients: [],
        unattributed: [],
        configured: readPepper().ok,
        migration_applied: false,
      });
    }
    return NextResponse.json({ error: clients.error }, { status: 500 });
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [counts, unattributed] = await Promise.all([countRequestsSince(since), listUnattributedRequests(25)]);

  const countMap = counts.data ?? new Map();
  const view: ExternalApiClientView[] = clients.data.map((c) => {
    const n = countMap.get(c.id);
    return { ...c, calls_7d: n?.total ?? 0, denied_7d: n?.denied ?? 0 };
  });

  return NextResponse.json({
    clients: view,
    unattributed: unattributed.data ?? [],
    unattributed_7d: countMap.get('')?.total ?? 0,
    configured: readPepper().ok,
    migration_applied: true,
  });
}

export async function POST(req: Request) {
  const authz = await requireAdminSession();
  if (!authz.ok) return deniedResponse(authz);

  let body: { name?: unknown; system?: unknown; contact_email?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const name = cleanText(body.name, NAME_MAX);
  const system = cleanText(body.system, SYSTEM_MAX);
  const contact = cleanText(body.contact_email, 320);
  if (!name) return NextResponse.json({ error: 'Give the client a name — who is this for?' }, { status: 400 });
  if (!system) {
    return NextResponse.json(
      { error: 'Name the system that will call us (e.g. "n8n", "Google Sheets script", "Retool dashboard").' },
      { status: 400 },
    );
  }
  if (contact && !contact.includes('@')) {
    return NextResponse.json({ error: 'Contact must be an email address' }, { status: 400 });
  }

  const pepper = readPepper();
  if (!pepper.ok) {
    return NextResponse.json(
      { error: 'No key pepper is configured on this deployment (EXTERNAL_API_KEY_PEPPER or NEXTAUTH_SECRET). Keys cannot be issued.' },
      { status: 503 },
    );
  }

  const apiKey = generateApiKey();
  const created = await createExternalApiClient({
    name,
    system,
    contact_email: contact ? contact.toLowerCase() : null,
    key_prefix: keyPrefix(apiKey),
    key_hash: hashApiKey(apiKey, pepper.pepper),
    created_by: authz.sessionEmail,
  });
  if (created.error !== null) {
    const status = created.missingTable ? 503 : 500;
    const error = created.missingTable
      ? 'The external_api_clients table has not been applied yet — run the migration first.'
      : created.error;
    return NextResponse.json({ error }, { status });
  }

  void insertAuditLog({
    ...auditFrom(req, authz),
    action: 'external_api.client.created',
    resource: 'external_api_clients',
    resource_id: created.data.id,
    details: { name, system, contact_email: contact, key_prefix: created.data.key_prefix },
  });

  // The ONLY time the plaintext leaves the server.
  return NextResponse.json({ success: true, client: created.data, api_key: apiKey }, { status: 201 });
}
