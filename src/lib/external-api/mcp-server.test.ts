import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MCP_TOOL_NAMES, buildMcpServer, describeAccess, type McpAccessContext } from './mcp-server';
import type { GmlRow } from './gml-query';
import type { GmlReadOutcome } from './gml-read';
import { OFFERABLE_COLUMNS } from './catalog';

function row(id: number, extra: Record<string, unknown> = {}): GmlRow {
  const r: GmlRow = { id, off_boarded_at: null, import_batch_id: 'b' };
  for (const c of OFFERABLE_COLUMNS) r[c] = `${c}-${id}`;
  r['Work Email'] = `p${id}@simple.biz`;
  r['Personal Email'] = `p${id}@gmail.com`;
  r['Name'] = `Person ${id}`;
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

function ctxWith(rows: GmlRow[], grant: string[] | null, seen: Array<{ tool: string; outcome: GmlReadOutcome | null }> = []): McpAccessContext {
  return {
    clientName: 'Ops mirror',
    system: 'n8n',
    grant,
    rateLimitPerMinute: 60,
    expiresAt: null,
    readRows: async () => ({ rows, error: null }),
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

test('the tool list is exactly the two read tools — nothing writes', async () => {
  const { client, server } = await connected(ctxWith([], null));
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
  const seen: Array<{ tool: string; outcome: GmlReadOutcome | null }> = [];
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
  const page = first['page'] as { next_cursor: number | null };
  assert.deepEqual((first['data'] as Array<{ id: number }>).map((r) => r.id), [1]);
  assert.equal(page.next_cursor, 1);
  const second = parse(
    (await client.callTool({ name: 'query_global_master_list', arguments: { limit: 5, cursor: page.next_cursor! } })) as {
      content: unknown;
    },
  );
  assert.deepEqual((second['data'] as Array<{ id: number }>).map((r) => r.id), [3]);
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
