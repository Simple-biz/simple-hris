import { NextRequest, NextResponse } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { admitExternalCall } from '@/lib/external-api/serve';
import { buildMcpServer } from '@/lib/external-api/mcp-server';
import type { GmlReadOutcome } from '@/lib/external-api/gml-read';
import { readActiveGmlRows } from '@/lib/supabase/external-api-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/external/mcp — the MCP face of the external read API (Streamable HTTP,
 * stateless, JSON responses).
 *
 *   Authorization: Bearer hris_live_…   the SAME key the REST route takes
 *
 * Every POST is ONE call against the client's rate limit, whatever JSON-RPC method
 * it carries (initialize, tools/list, tools/call…), and writes ONE request-log row
 * whose `query` names the method and, for a tool call, the tool + its arguments;
 * `row_count` is what the tool returned. A new server + transport is built per
 * request and closed after it — nothing is kept between calls, so a revoke, an
 * expiry or a narrowed grant is honoured on the next POST.
 *
 * GET and DELETE are 405: no server-initiated stream and no session to end.
 * The SSO proxy lets `/api/external/*` through; `admitExternalCall` is the gate.
 */

const PATH = '/api/external/mcp';

function summarise(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const msgs = Array.isArray(body) ? body : [body];
  const out: Record<string, unknown> = {};
  const methods: string[] = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const method = (m as { method?: unknown }).method;
    if (typeof method === 'string') methods.push(method);
    if (method === 'tools/call') {
      const params = (m as { params?: { name?: unknown; arguments?: unknown } }).params;
      if (params && typeof params.name === 'string') out.tool = params.name;
      if (params && params.arguments && typeof params.arguments === 'object') {
        out.arguments = JSON.parse(JSON.stringify(params.arguments).slice(0, 400));
      }
    }
  }
  if (methods.length) out.method = methods.length === 1 ? methods[0] : methods;
  return Object.keys(out).length ? out : null;
}

export async function POST(req: NextRequest) {
  let body: unknown = null;
  let query: Record<string, unknown> | null = null;
  try {
    body = await req.json();
    try {
      query = summarise(body);
    } catch {
      query = null;
    }
  } catch {
    body = null;
  }

  const admitted = await admitExternalCall(req, { method: 'POST', path: PATH, query });
  if (!admitted.ok) return NextResponse.json(admitted.body, { status: admitted.status, headers: admitted.headers });
  const { client, grant, rateHeaders, log, touch } = admitted;

  if (body === null) {
    await log({ status: 400, rowCount: null, denial: 'bad_request' });
    return NextResponse.json({ error: 'Body must be a JSON-RPC message' }, { status: 400, headers: rateHeaders });
  }

  let rowCount: number | null = null;
  let toolDenial: string | null = null;
  const server = buildMcpServer({
    clientName: client.name,
    system: client.system,
    grant,
    rateLimitPerMinute: client.rate_limit_per_minute,
    expiresAt: client.expires_at,
    readRows: readActiveGmlRows,
    onToolResult: (_tool, _args, outcome: GmlReadOutcome | null) => {
      if (outcome && outcome.ok) rowCount = outcome.data.length;
      if (outcome && !outcome.ok) toolDenial = outcome.denial;
    },
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    const res = await transport.handleRequest(req, { parsedBody: body });
    // The HTTP status is the transport's (200 / 202 / 4xx). A tool that REFUSED still
    // answers 200 at the protocol level — the log carries the refusal as the denial.
    const status = res.status;
    await log({
      status: status >= 400 ? status : toolDenial ? 400 : status,
      rowCount,
      denial: status >= 400 ? 'bad_request' : toolDenial,
    });
    if (status < 400) touch();
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(rateHeaders)) headers.set(k, v);
    headers.set('Cache-Control', 'no-store');
    return new Response(res.body, { status, headers });
  } catch (err) {
    console.error('[external-api] MCP handling failed:', err instanceof Error ? err.message : err);
    await log({ status: 500, rowCount: null, denial: 'read_failed' });
    return NextResponse.json({ error: 'Could not serve the MCP request' }, { status: 500, headers: rateHeaders });
  } finally {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  }
}
