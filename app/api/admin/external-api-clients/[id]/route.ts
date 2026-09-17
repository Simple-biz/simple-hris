import { NextResponse } from 'next/server';
import { requireAdminSession, deniedResponse } from '@/lib/auth/authorize-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { auditFrom } from '@/lib/audit/context';
import { generateApiKey, hashApiKey, keyPrefix, readPepper } from '@/lib/external-api/keys';
import { normalizeGrant, hiddenCount } from '@/lib/external-api/grants';
import { expiresAtFor, parseExpiryOption } from '@/lib/external-api/expiry';
import { parseRateLimit, RATE_LIMIT_CEILING, RATE_LIMIT_FLOOR } from '@/lib/external-api/rate-limit';
import {
  getClient,
  updateExternalApiClient,
  type ExternalApiClientPatch,
} from '@/lib/supabase/external-api-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/admin/external-api-clients/{id}
 *
 *   { action: 'revoke' }   → key dead on the next call. Row and history kept.
 *   { action: 'restore' }  → the SAME key works again (nothing was re-issued). An EXPIRED
 *                            key stays dead until its expiry is extended with 'update'.
 *   { action: 'rotate' }   → new key, same client id + history; old key dead. Returns api_key ONCE.
 *   { action: 'update', name?, system?, contact_email?, granted_columns?, expiry?, rate_limit_per_minute? }
 *                          → granted_columns: null = whole table, list = only these (absent = unchanged)
 *                            expiry: '1d' | '15d' | '30d' | 'never', counted from NOW (absent = unchanged)
 *                            rate_limit_per_minute: 1..600 (absent = unchanged)
 *                            Every change takes effect on the client's next call.
 *
 * There is deliberately no DELETE. `external_api_requests` references the
 * client with ON DELETE RESTRICT, and the request history is the record of
 * which outside system read the roster — it outlives the key on purpose.
 */

type Action = 'revoke' | 'restore' | 'rotate' | 'update';
const ACTIONS: readonly Action[] = ['revoke', 'restore', 'rotate', 'update'];

function cleanText(v: unknown, max: number): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requireAdminSession();
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await params;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Invalid client id' }, { status: 400 });

  let body: {
    action?: unknown;
    name?: unknown;
    system?: unknown;
    contact_email?: unknown;
    granted_columns?: unknown;
    expiry?: unknown;
    rate_limit_per_minute?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const action = body.action as Action;
  if (!ACTIONS.includes(action)) {
    return NextResponse.json({ error: `action must be one of ${ACTIONS.join(', ')}` }, { status: 400 });
  }

  const existing = await getClient(id);
  if (existing.error !== null) return NextResponse.json({ error: existing.error }, { status: existing.missingTable ? 503 : 500 });
  if (!existing.data) return NextResponse.json({ error: 'No such client' }, { status: 404 });
  const before = existing.data;

  const actor = authz.sessionEmail;
  const now = new Date().toISOString();
  let patch: ExternalApiClientPatch;
  let auditAction: string;
  let details: Record<string, unknown> = { name: before.name, system: before.system, key_prefix: before.key_prefix };
  let apiKey: string | null = null;

  switch (action) {
    case 'revoke': {
      if (before.revoked_at) return NextResponse.json({ error: 'Already revoked' }, { status: 409 });
      patch = { revoked_at: now, revoked_by: actor };
      auditAction = 'external_api.client.revoked';
      break;
    }
    case 'restore': {
      if (!before.revoked_at) return NextResponse.json({ error: 'Not revoked' }, { status: 409 });
      patch = { revoked_at: null, revoked_by: null };
      auditAction = 'external_api.client.restored';
      details = { ...details, was_revoked_at: before.revoked_at, was_revoked_by: before.revoked_by };
      break;
    }
    case 'rotate': {
      const pepper = readPepper();
      if (!pepper.ok) {
        return NextResponse.json(
          { error: 'No key pepper is configured on this deployment. Keys cannot be issued.' },
          { status: 503 },
        );
      }
      apiKey = generateApiKey();
      const newPrefix = keyPrefix(apiKey);
      // A rotate is also an un-revoke: the point is to hand the system a working key.
      // It does NOT touch expires_at — extend that explicitly with 'update' if wanted.
      patch = {
        key_prefix: newPrefix,
        key_hash: hashApiKey(apiKey, pepper.pepper),
        rotated_at: now,
        rotated_by: actor,
        revoked_at: null,
        revoked_by: null,
      };
      auditAction = 'external_api.client.rotated';
      details = { ...details, old_key_prefix: before.key_prefix, new_key_prefix: newPrefix, was_revoked: !!before.revoked_at };
      break;
    }
    case 'update': {
      const name = cleanText(body.name, 80);
      const system = cleanText(body.system, 80);
      const contact = cleanText(body.contact_email, 320);
      if (name === null) return NextResponse.json({ error: 'Name cannot be blank' }, { status: 400 });
      if (system === null) return NextResponse.json({ error: 'System cannot be blank' }, { status: 400 });
      if (contact && !contact.includes('@')) return NextResponse.json({ error: 'Contact must be an email address' }, { status: 400 });
      patch = {};
      const changes: Record<string, unknown> = {};
      if (name !== undefined) {
        patch.name = name;
        changes.name = name;
      }
      if (system !== undefined) {
        patch.system = system;
        changes.system = system;
      }
      if (contact !== undefined) {
        patch.contact_email = contact ? contact.toLowerCase() : null;
        changes.contact_email = patch.contact_email;
      }
      if (body.granted_columns !== undefined) {
        const grant = normalizeGrant(body.granted_columns);
        if (!grant.ok) return NextResponse.json({ error: grant.error }, { status: 400 });
        patch.granted_columns = grant.grant;
        changes.granted_columns = grant.grant;
        changes.whole_table = grant.grant === null;
        changes.hidden_columns = hiddenCount(grant.grant);
        changes.was_granted_columns = before.granted_columns;
      }
      if (body.expiry !== undefined) {
        const expiry = parseExpiryOption(body.expiry);
        if (!expiry) {
          return NextResponse.json({ error: 'expiry must be 1d, 15d, 30d or never' }, { status: 400 });
        }
        patch.expires_at = expiresAtFor(expiry);
        changes.expiry = expiry;
        changes.expires_at = patch.expires_at;
        changes.was_expires_at = before.expires_at;
      }
      if (body.rate_limit_per_minute !== undefined) {
        const limit = parseRateLimit(body.rate_limit_per_minute);
        if (limit === null) {
          return NextResponse.json(
            { error: `Rate limit must be a whole number between ${RATE_LIMIT_FLOOR} and ${RATE_LIMIT_CEILING} calls per minute.` },
            { status: 400 },
          );
        }
        patch.rate_limit_per_minute = limit;
        changes.rate_limit_per_minute = limit;
        changes.was_rate_limit_per_minute = before.rate_limit_per_minute;
      }
      if (!Object.keys(patch).length) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
      auditAction = 'external_api.client.updated';
      details = { ...details, changes };
      break;
    }
  }

  const updated = await updateExternalApiClient(id, patch);
  if (updated.error !== null) return NextResponse.json({ error: updated.error }, { status: 500 });

  void insertAuditLog({
    ...auditFrom(req, authz),
    action: auditAction,
    resource: 'external_api_clients',
    resource_id: id,
    details,
  });

  return NextResponse.json({ success: true, client: updated.data, ...(apiKey ? { api_key: apiKey } : {}) });
}
