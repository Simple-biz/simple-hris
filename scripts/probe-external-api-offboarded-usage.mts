/**
 * STRICTLY READ-ONLY. No insert / update / delete / upsert. Two SELECTs.
 *
 * Open item 395 (2026-10-07 call): Kane told Carla the job portal (Rainer B.) "already" reads the
 * Offboarded list and blocks reapplying. This proves or disproves it from the tables:
 *   1. every external API key: name, system, scopes, and whether it is live / revoked / expired;
 *   2. every call since 2026-10-06, per key, split by what it read.
 *
 * Reads the tables directly. NEVER test this by curling /api/external/* on local dev: even a
 * denied call writes a production external_api_requests row (memory `external-api-offboarded`).
 *
 * An offboarded read has TWO shapes in the log, and both are counted:
 *   - REST: path = /api/external/v1/offboarded
 *   - MCP:  path = /api/external/mcp, query.tool = 'query_offboarded' (app/api/external/mcp/route.ts)
 * The plan's draft filtered on path ILIKE '%offboarded%', which misses every MCP read.
 *
 * Prints names, scopes and counts only. Never key hashes, key prefixes, IPs or query arguments.
 *
 *   node --import tsx scripts/probe-external-api-offboarded-usage.mts
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { selectAllPaged } = await import('../src/lib/supabase/select-all-paged');
const { isExpired } = await import('../src/lib/external-api/expiry');
const { OFFBOARDED_SCOPE, holdsScope } = await import('../src/lib/external-api/scopes');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (.env.local)');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

const SINCE = '2026-10-06T00:00:00Z';
const REST_OFFBOARDED = '/api/external/v1/offboarded';
const REST_ROSTER = '/api/external/v1/global-master-list';
const MCP = '/api/external/mcp';

type ClientRow = {
  id: string;
  name: string;
  system: string;
  scopes: string[] | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
};
type RequestRow = {
  id: number;
  client_id: string | null;
  method: string;
  path: string;
  query: Record<string, unknown> | null;
  status: number;
  denial: string | null;
  created_at: string;
};

const clients = await selectAllPaged<ClientRow>((from, to) =>
  sb
    .from('external_api_clients')
    .select('id,name,system,scopes,expires_at,revoked_at,created_at,last_used_at')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to),
);
if (clients.error) {
  console.error('external_api_clients:', clients.error);
  process.exit(1);
}

const requests = await selectAllPaged<RequestRow>((from, to) =>
  sb
    .from('external_api_requests')
    .select('id,client_id,method,path,query,status,denial,created_at')
    .gte('created_at', SINCE)
    .order('id', { ascending: true })
    .range(from, to),
);
if (requests.error) {
  console.error('external_api_requests:', requests.error);
  process.exit(1);
}

function state(c: ClientRow): string {
  if (c.revoked_at) return 'REVOKED';
  if (isExpired(c.expires_at)) return 'EXPIRED';
  return 'live';
}

/** What the call read. An MCP POST that is not a tools/call (initialize, tools/list) is its own class. */
function kind(r: RequestRow): string {
  if (r.path === REST_OFFBOARDED) return 'REST offboarded';
  if (r.path === REST_ROSTER) return 'REST roster';
  if (r.path === MCP) {
    const tool = r.query && typeof r.query.tool === 'string' ? r.query.tool : null;
    if (tool) return `MCP ${tool}`;
    const method = r.query?.method;
    return `MCP ${typeof method === 'string' ? method : Array.isArray(method) ? method.join('+') : '(no method)'}`;
  }
  return `other ${r.path}`;
}
const isOffboardedRead = (k: string) => k === 'REST offboarded' || k === 'MCP query_offboarded';

const byId = new Map(clients.rows.map((c) => [c.id, c]));

console.log(`\n== External API keys (${clients.rows.length}) ==`);
for (const c of clients.rows) {
  const scopes = Array.isArray(c.scopes) ? c.scopes.join(', ') : '(none)';
  console.log(
    `${c.name} [${c.system}] ${state(c)} · scopes: ${scopes} · created ${c.created_at.slice(0, 10)}` +
      ` · expires ${c.expires_at ?? 'never'} · last used ${c.last_used_at ?? 'never'}`,
  );
}

console.log(`\n== Calls since ${SINCE} (${requests.rows.length}) ==`);
type Tally = { n: number; first: string; last: string };
const tally = new Map<string, Tally>();
for (const r of requests.rows) {
  const who = r.client_id ? (byId.get(r.client_id)?.name ?? `(unlisted client ${r.client_id.slice(0, 8)})`) : '(no key / unknown key)';
  const k = `${who} · ${kind(r)} · ${r.status}${r.denial ? ` ${r.denial}` : ''}`;
  const t = tally.get(k);
  if (t) {
    t.n += 1;
    t.last = r.created_at;
  } else tally.set(k, { n: 1, first: r.created_at, last: r.created_at });
}
for (const [k, t] of [...tally].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`  ${k}: ${t.n}  (first ${t.first}, last ${t.last})`);
}

const holders = clients.rows.filter((c) => holdsScope(c.scopes, OFFBOARDED_SCOPE));
const offboardedOk = requests.rows.filter((r) => isOffboardedRead(kind(r)) && r.status < 400);
const offboardedDenied = requests.rows.filter((r) => isOffboardedRead(kind(r)) && r.status >= 400);
console.log('\n== Verdict inputs ==');
console.log(`keys holding ${OFFBOARDED_SCOPE}: ${holders.length}${holders.length ? ` (${holders.map((c) => `${c.name}, ${state(c)}`).join('; ')})` : ''}`);
console.log(`successful offboarded reads since ${SINCE.slice(0, 10)}: ${offboardedOk.length}`);
console.log(`refused offboarded reads since ${SINCE.slice(0, 10)}: ${offboardedDenied.length}`);
