import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  GML_ONLY_INSTRUCTIONS,
  MCP_TOOL_NAMES,
  buildMcpServer,
  describeAccess,
  toolsFor,
  type McpAccessContext,
  type McpToolOutcome,
} from './mcp-server';
import type { GmlRow } from './gml-query';
import { OFFERABLE_COLUMNS } from './catalog';
import { OFFBOARDED_COLUMNS, type OffboardedLedgerRow } from './offboarded';
import { GML_SCOPE, OFFBOARDED_SCOPE } from './scopes';

/** `global_master_list.id` is a UUID — these fixtures used integers until
 *  2026-09-21, which is why the suite never caught that the MCP tool's numeric
 *  `cursor` schema rejected every continuation the tool itself issued. */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function row(seed: number, extra: Record<string, unknown> = {}): GmlRow {
  const r: GmlRow = { id: uuid(seed), off_boarded_at: null, import_batch_id: 'b' };
  for (const c of OFFERABLE_COLUMNS) r[c] = `${c}-${seed}`;
  r['Work Email'] = `p${seed}@simple.biz`;
  r['Personal Email'] = `p${seed}@gmail.com`;
  r['Name'] = `Person ${seed}`;
  return { ...r, ...extra };
}

async function connected(ctx: McpAccessContext) {
  const server = buildMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return { client, server };
}

function leaver(id: number, extra: Partial<OffboardedLedgerRow> = {}): OffboardedLedgerRow {
  return {
    id,
    name: `Leaver ${id}`,
    work_email: `l${id}@simple.biz`,
    department: 'Lead Gen',
    start_date: '2026-05-18',
    off_boarded_at: '2026-09-01T00:00:00+00:00',
    off_boarded_reason: 'resigned',
    origin: 'hris',
    ...extra,
  };
}

function ctxWith(
  rows: GmlRow[],
  grant: string[] | null,
  seen: Array<{ tool: string; outcome: McpToolOutcome | null }> = [],
  scopes: string[] = [GML_SCOPE],
  leavers: OffboardedLedgerRow[] = [],
): McpAccessContext {
  return {
    clientName: 'Ops mirror',
    system: 'n8n',
    scopes,
    grant,
    rateLimitPerMinute: 60,
    expiresAt: null,
    readRows: async () => ({ rows, error: null }),
    readOffboardedRows: async () => ({ rows: leavers, error: null }),
    onToolResult: (tool, _args, outcome) => {
      seen.push({ tool, outcome });
    },
  };
}

function parse(result: { content: unknown }): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'text');
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

test('every tool there is, and every one is a read — a new tool or a write fails here', async () => {
  assert.deepEqual([...MCP_TOOL_NAMES], ['describe_access', 'query_global_master_list', 'query_offboarded']);
  const { client, server } = await connected(ctxWith([], null, [], [GML_SCOPE, OFFBOARDED_SCOPE]));
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), [...MCP_TOOL_NAMES].sort());
  for (const t of tools.tools) assert.equal(t.annotations?.readOnlyHint, true, `${t.name} must be read-only`);
  await client.close();
  await server.close();
});

test('describe_access reports the visible columns and the filters the grant allows', async () => {
  const ctx = ctxWith([], ['Name', 'Work Email']);
  const d = describeAccess(ctx);
  assert.deepEqual(d.columns, ['id', 'Name', 'Work Email']);
  assert.deepEqual(d.filters, ['email', 'search']);
  assert.equal(d.whole_table, false);
  const { client, server } = await connected(ctx);
  const res = await client.callTool({ name: 'describe_access', arguments: {} });
  const body = parse(res as { content: unknown });
  assert.deepEqual(body['columns'], ['id', 'Name', 'Work Email']);
  assert.equal(body['rate_limit_per_minute'], 60);
  await client.close();
  await server.close();
});

test('query_global_master_list: a hidden column never appears in a tool result', async () => {
  const seen: Array<{ tool: string; outcome: McpToolOutcome | null }> = [];
  const { client, server } = await connected(ctxWith([row(1), row(2)], ['Name', 'Work Email'], seen));
  const res = await client.callTool({ name: 'query_global_master_list', arguments: { limit: 10 } });
  const body = parse(res as { content: unknown });
  const data = body['data'] as Record<string, unknown>[];
  assert.equal(data.length, 2);
  for (const r of data) {
    assert.deepEqual(Object.keys(r).sort(), ['Name', 'Work Email', 'id'].sort());
    assert.ok(!('Personal Email' in r));
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, 'query_global_master_list');
  assert.ok(seen[0].outcome?.ok);
  await client.close();
  await server.close();
});

test('query_global_master_list: a filter on a hidden column comes back as a tool error, not an empty page', async () => {
  const { client, server } = await connected(ctxWith([row(1)], ['Name']));
  const res = (await client.callTool({ name: 'query_global_master_list', arguments: { department: 'Sales' } })) as {
    content: unknown;
    isError?: boolean;
  };
  assert.equal(res.isError, true);
  const body = parse(res);
  assert.match(String(body['error']), /not granted/);
  await client.close();
  await server.close();
});

test('query_global_master_list: off-boarded people are never returned, and the cursor pages', async () => {
  const rows = [row(1), row(2, { off_boarded_at: '2026-01-01T00:00:00Z' }), row(3)];
  const { client, server } = await connected(ctxWith(rows, null));
  const first = parse((await client.callTool({ name: 'query_global_master_list', arguments: { limit: 1 } })) as { content: unknown });
  const page = first['page'] as { next_cursor: string | null };
  assert.deepEqual((first['data'] as Array<{ id: string }>).map((r) => r.id), [uuid(1)]);
  assert.equal(page.next_cursor, uuid(1));
  // The continuation must be accepted by the tool's OWN input schema — this is
  // the round-trip that was broken: the tool issued a UUID and then refused it.
  const second = parse(
    (await client.callTool({ name: 'query_global_master_list', arguments: { limit: 5, cursor: page.next_cursor! } })) as {
      content: unknown;
    },
  );
  assert.deepEqual((second['data'] as Array<{ id: string }>).map((r) => r.id), [uuid(3)]);
  await client.close();
  await server.close();
});

test('query_global_master_list: an argument outside the contract is rejected by the schema', async () => {
  const { client, server } = await connected(ctxWith([row(1)], null));
  const res = (await client.callTool({ name: 'query_global_master_list', arguments: { limit: 5000 } })) as { isError?: boolean };
  assert.equal(res.isError, true, 'limit above MAX_LIMIT must not reach the read');
  await client.close();
  await server.close();
});

// ─── 2026-10-07: the second scope ─────────────────────────────────────────────

test('toolsFor: a tool exists only for a scope the key holds', () => {
  assert.deepEqual(toolsFor([GML_SCOPE]), ['describe_access', 'query_global_master_list']);
  assert.deepEqual(toolsFor([OFFBOARDED_SCOPE]), ['describe_access', 'query_offboarded']);
  assert.deepEqual(toolsFor([GML_SCOPE, OFFBOARDED_SCOPE]), ['describe_access', 'query_global_master_list', 'query_offboarded']);
  assert.deepEqual(toolsFor(null), ['describe_access']);
});

test('a roster-only key sees exactly what it saw before the second scope: two tools, same instructions, same describe_access', async () => {
  const ctx = ctxWith([], ['Name', 'Work Email']);
  const { client, server } = await connected(ctx);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ['describe_access', 'query_global_master_list']);
  assert.equal(client.getInstructions(), GML_ONLY_INSTRUCTIONS);
  // The payload the live OMS client reads — key for key, in order.
  assert.deepEqual(describeAccess(ctx), {
    table: 'global_master_list',
    table_label: 'Global Master List',
    client: 'Ops mirror',
    system: 'n8n',
    columns: ['id', 'Name', 'Work Email'],
    whole_table: false,
    filters: ['email', 'search'],
    active_only: true,
    max_limit: 500,
    rate_limit_per_minute: 60,
    expires_at: null,
  });
  const called = (await client.callTool({ name: 'query_offboarded', arguments: {} })) as { isError?: boolean };
  assert.equal(called.isError, true, 'a roster-only key cannot call the leavers tool');
  await client.close();
  await server.close();
});

test('a leavers-only key never sees the roster tool or its columns', async () => {
  const ctx = ctxWith([row(1)], null, [], [OFFBOARDED_SCOPE], [leaver(1)]);
  const d = describeAccess(ctx);
  assert.ok(!('columns' in d) && !('table' in d), 'no roster block for a leavers-only key');
  assert.deepEqual(d.offboarded?.columns, [...OFFBOARDED_COLUMNS]);
  const { client, server } = await connected(ctx);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ['describe_access', 'query_offboarded']);
  const called = (await client.callTool({ name: 'query_global_master_list', arguments: {} })) as { isError?: boolean };
  assert.equal(called.isError, true);
  await client.close();
  await server.close();
});

test('query_offboarded: fixed columns, temporary pause never returned, the cursor pages', async () => {
  const seen: Array<{ tool: string; outcome: McpToolOutcome | null }> = [];
  const leavers = [leaver(41958), leaver(41959, { off_boarded_reason: 'Temporary Pause' }), leaver(41960), leaver(41961)];
  const { client, server } = await connected(ctxWith([], null, seen, [OFFBOARDED_SCOPE], leavers));
  const first = parse((await client.callTool({ name: 'query_offboarded', arguments: { limit: 2 } })) as { content: unknown });
  const data = first['data'] as Array<Record<string, unknown>>;
  assert.deepEqual(data.map((r) => r['id']), [41958, 41960]);
  for (const r of data) assert.deepEqual(Object.keys(r), [...OFFBOARDED_COLUMNS]);
  const page = first['page'] as { next_cursor: string | null; total: number };
  assert.equal(page.total, 3);
  assert.equal(page.next_cursor, '41960');
  const second = parse(
    (await client.callTool({ name: 'query_offboarded', arguments: { limit: 2, cursor: page.next_cursor! } })) as { content: unknown },
  );
  assert.deepEqual((second['data'] as Array<{ id: number }>).map((r) => r.id), [41961]);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((x) => x.tool === 'query_offboarded' && x.outcome?.ok));
  await client.close();
  await server.close();
});

test('query_offboarded: an impossible date is a tool error the route logs as bad_request', async () => {
  const seen: Array<{ tool: string; outcome: McpToolOutcome | null }> = [];
  const { client, server } = await connected(ctxWith([], null, seen, [OFFBOARDED_SCOPE], [leaver(1)]));
  const res = (await client.callTool({ name: 'query_offboarded', arguments: { since: '2026-02-30' } })) as { isError?: boolean };
  assert.equal(res.isError, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].outcome?.ok, false);
  if (seen[0].outcome && !seen[0].outcome.ok) assert.equal(seen[0].outcome.denial, 'bad_request');
  const bad = (await client.callTool({ name: 'query_offboarded', arguments: { reason: 'temporary_pause' } })) as { isError?: boolean };
  assert.equal(bad.isError, true, 'temporary_pause is not a reason category');
  await client.close();
  await server.close();
});
