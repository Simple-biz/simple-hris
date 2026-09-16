import 'server-only';

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import type { GmlRow } from '@/lib/external-api/gml-query';

/**
 * Data access for the external read API — the client registry, the per-call
 * request log, and the ONE read of `global_master_list` the API is allowed.
 *
 * Service-role throughout: both new tables have RLS on with no policies, so the
 * anon key sees nothing, and `active_employees` is not used because its
 * `security_invoker` view goes silently empty under RLS
 * (memory/security-invoker-view-silent-empty.md). The base table is read
 * directly with `off_boarded_at IS NULL` — the same rule `gml-status.ts` uses.
 */

export const EXTERNAL_API_CLIENTS_TABLE = 'external_api_clients';
export const EXTERNAL_API_REQUESTS_TABLE = 'external_api_requests';
export const GML_TABLE = 'global_master_list';

export type ExternalApiClientRow = {
  id: string;
  name: string;
  system: string;
  contact_email: string | null;
  key_prefix: string;
  key_hash: string;
  scopes: string[];
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  rotated_at: string | null;
  rotated_by: string | null;
  last_used_at: string | null;
};

/** What the admin UI sees — never the hash. */
export type ExternalApiClientPublic = Omit<ExternalApiClientRow, 'key_hash'>;

export type ExternalApiRequestRow = {
  id: number;
  client_id: string | null;
  key_prefix: string | null;
  method: string;
  path: string;
  query: Record<string, unknown> | null;
  status: number;
  row_count: number | null;
  denial: string | null;
  ip: string | null;
  user_agent: string | null;
  duration_ms: number | null;
  created_at: string;
};

export type NewExternalApiRequest = Omit<ExternalApiRequestRow, 'id' | 'created_at'>;

const PUBLIC_COLUMNS =
  'id,name,system,contact_email,key_prefix,scopes,created_by,created_at,revoked_at,revoked_by,rotated_at,rotated_by,last_used_at';

export type DbResult<T> = { data: T; error: null; missingTable: false } | { data: null; error: string; missingTable: boolean };

/**
 * PostgREST answers a query against a table that does not exist with PGRST205
 * ("Could not find the table … in the schema cache"); raw Postgres says 42P01.
 * The admin panel turns this into "migration not applied yet" instead of a
 * generic failure.
 */
export function isMissingTableError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === 'PGRST205' || err.code === '42P01') return true;
  const m = (err.message ?? '').toLowerCase();
  return m.includes('could not find the table') || m.includes('does not exist');
}

function publicOf(row: ExternalApiClientRow | ExternalApiClientPublic): ExternalApiClientPublic {
  const { key_hash: _drop, ...rest } = row as ExternalApiClientRow;
  void _drop;
  return rest;
}

function fail<T>(err: { code?: string; message?: string }): DbResult<T> {
  return { data: null, error: err.message ?? 'Database error', missingTable: isMissingTableError(err) };
}

const NO_CLIENT = { code: 'NO_CLIENT', message: 'Supabase not configured' };

// ─── Clients ──────────────────────────────────────────────────────────────────

/** The hot-path lookup. Indexed unique equality on the hash; no cache, so a revoke is instant. */
export async function findClientByKeyHash(keyHash: string): Promise<DbResult<ExternalApiClientRow | null>> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return fail(NO_CLIENT);
  const { data, error } = await supabase
    .from(EXTERNAL_API_CLIENTS_TABLE)
    .select('*')
    .eq('key_hash', keyHash)
    .maybeSingle();
  if (error) return fail(error);
  return { data: (data as ExternalApiClientRow | null) ?? null, error: null, missingTable: false };
}

export async function getClient(id: string): Promise<DbResult<ExternalApiClientPublic | null>> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return fail(NO_CLIENT);
  const { data, error } = await supabase
    .from(EXTERNAL_API_CLIENTS_TABLE)
    .select(PUBLIC_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) return fail(error);
  return { data: data ? publicOf(data as ExternalApiClientPublic) : null, error: null, missingTable: false };
}

export async function listClients(): Promise<DbResult<ExternalApiClientPublic[]>> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return fail(NO_CLIENT);
  const { rows, error } = await selectAllPaged<ExternalApiClientPublic>((from, to) =>
    supabase
      .from(EXTERNAL_API_CLIENTS_TABLE)
      .select(PUBLIC_COLUMNS)
      .order('created_at', { ascending: false })
      .range(from, to),
  );
  if (error) return fail({ message: error });
  return { data: rows.map(publicOf), error: null, missingTable: false };
}

export type NewExternalApiClient = {
  name: string;
  system: string;
  contact_email: string | null;
  key_prefix: string;
  key_hash: string;
  created_by: string;
};

export async function createExternalApiClient(input: NewExternalApiClient): Promise<DbResult<ExternalApiClientPublic>> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return fail(NO_CLIENT);
  const { data, error } = await supabase
    .from(EXTERNAL_API_CLIENTS_TABLE)
    .insert({ ...input, scopes: ['global_master_list.read'] })
    .select(PUBLIC_COLUMNS)
    .single();
  if (error) return fail(error);
  return { data: publicOf(data as ExternalApiClientPublic), error: null, missingTable: false };
}

export type ExternalApiClientPatch = Partial<
  Pick<
    ExternalApiClientRow,
    | 'name'
    | 'system'
    | 'contact_email'
    | 'key_prefix'
    | 'key_hash'
    | 'revoked_at'
    | 'revoked_by'
    | 'rotated_at'
    | 'rotated_by'
  >
>;

export async function updateExternalApiClient(
  id: string,
  patch: ExternalApiClientPatch,
): Promise<DbResult<ExternalApiClientPublic>> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return fail(NO_CLIENT);
  const { data, error } = await supabase
    .from(EXTERNAL_API_CLIENTS_TABLE)
    .update(patch)
    .eq('id', id)
    .select(PUBLIC_COLUMNS)
    .single();
  if (error) return fail(error);
  return { data: publicOf(data as ExternalApiClientPublic), error: null, missingTable: false };
}

/** Best-effort; a failure here must never fail the caller's request. */
export async function touchLastUsed(id: string): Promise<void> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return;
  const { error } = await supabase
    .from(EXTERNAL_API_CLIENTS_TABLE)
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', id);
  if (error) console.error('[external-api] last_used_at update failed:', error.message);
}

// ─── Request log ──────────────────────────────────────────────────────────────

/**
 * One row per call, success or denial. Awaited by the route so a lost row is at
 * least shouted about — this table IS the "what system is calling us" record.
 */
export async function insertExternalApiRequest(entry: NewExternalApiRequest): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const { error } = await supabase.from(EXTERNAL_API_REQUESTS_TABLE).insert(entry);
  if (error) {
    console.error('[external-api] request log write FAILED — call unrecorded:', error.message, {
      key_prefix: entry.key_prefix,
      status: entry.status,
      denial: entry.denial,
    });
    return { error: error.message };
  }
  return { error: null };
}

export async function listExternalApiRequests(
  clientId: string,
  limit: number,
): Promise<DbResult<ExternalApiRequestRow[]>> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return fail(NO_CLIENT);
  const { data, error } = await supabase
    .from(EXTERNAL_API_REQUESTS_TABLE)
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500));
  if (error) return fail(error);
  return { data: (data ?? []) as ExternalApiRequestRow[], error: null, missingTable: false };
}

/** Denied calls that matched no client (unknown / malformed keys) — the leaked-key detector. */
export async function listUnattributedRequests(limit: number): Promise<DbResult<ExternalApiRequestRow[]>> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return fail(NO_CLIENT);
  const { data, error } = await supabase
    .from(EXTERNAL_API_REQUESTS_TABLE)
    .select('*')
    .is('client_id', null)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500));
  if (error) return fail(error);
  return { data: (data ?? []) as ExternalApiRequestRow[], error: null, missingTable: false };
}

export type RequestCounts = { total: number; denied: number };

/** Per-client call counts since `sinceIso`, plus the unattributed bucket under the key `''`. Paged. */
export async function countRequestsSince(sinceIso: string): Promise<DbResult<Map<string, RequestCounts>>> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return fail(NO_CLIENT);
  type Slim = { client_id: string | null; status: number };
  const { rows, error } = await selectAllPaged<Slim>((from, to) =>
    supabase
      .from(EXTERNAL_API_REQUESTS_TABLE)
      .select('client_id,status')
      .gte('created_at', sinceIso)
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (error) return fail({ message: error });
  const map = new Map<string, RequestCounts>();
  for (const r of rows) {
    const k = r.client_id ?? '';
    const cur = map.get(k) ?? { total: 0, denied: 0 };
    cur.total += 1;
    if (r.status >= 400) cur.denied += 1;
    map.set(k, cur);
  }
  return { data: map, error: null, missingTable: false };
}

// ─── The one permitted read ───────────────────────────────────────────────────

/**
 * Every ACTIVE row of `global_master_list`, all columns, ordered by id.
 * `off_boarded_at IS NULL` here AND again in `applyGmlQuery` — the leaver filter
 * is enforced twice on purpose. Paged: the table is ~3.8k rows and PostgREST
 * truncates at 1000 even with `.range()` (memory/postgrest-1000-cap-sweep.md).
 */
export async function readActiveGmlRows(): Promise<{ rows: GmlRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  return selectAllPaged<GmlRow>((from, to) =>
    supabase.from(GML_TABLE).select('*').is('off_boarded_at', null).order('id', { ascending: true }).range(from, to),
  );
}
