/**
 * The MCP face of the external read API — Kane, 2026-09-17: *"let them pull via
 * querying or MCP."*
 *
 * ONE server shape, built per request (stateless Streamable HTTP; nothing is held
 * between calls, so a revoke or an expiry is honoured on the very next POST, like
 * REST). It exposes exactly TWO tools, both reads, and `mcp-server.test.ts` pins
 * that list — a third tool, or a write, fails the suite:
 *
 *   describe_access            what THIS key may see: the table, its visible
 *                              columns, the filters it may use, its limit, expiry
 *   query_global_master_list   the REST contract as a tool: department / email /
 *                              search / limit / cursor → { data, page }
 *
 * The tool result goes through `executeGmlRead`, the same pipeline the REST route
 * runs, so a hidden column is absent here for the same reason it is absent there.
 * Rate limiting and the request log live in the ROUTE (one POST = one call against
 * the same budget REST spends); this module never touches the database directly.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GML_TABLE_KEY, GML_TABLE_LABEL } from './catalog';
import { executeGmlRead, type GmlReadOutcome, type ReadRows } from './gml-read';
import { MAX_LIMIT, type GmlQuery } from './gml-query';
import { filterVisibility, visibleColumns, type Grant } from './grants';

export const MCP_SERVER_NAME = 'simple-hris-external';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_TOOL_NAMES = ['describe_access', 'query_global_master_list'] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export type McpAccessContext = {
  clientName: string;
  system: string;
  grant: Grant;
  rateLimitPerMinute: number;
  expiresAt: string | null;
  readRows: ReadRows;
  /** Called after every tool run, success or refusal — the route logs the row count from it. */
  onToolResult?: (tool: McpToolName, args: Record<string, unknown>, outcome: GmlReadOutcome | null) => void;
};

function textResult(payload: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
}

export function describeAccess(ctx: McpAccessContext) {
  const vis = filterVisibility(ctx.grant);
  const filters: string[] = [];
  if (vis.department) filters.push('department');
  if (vis.emailColumns.length) filters.push('email');
  if (vis.name || vis.emailColumns.length) filters.push('search');
  return {
    table: GML_TABLE_KEY,
    table_label: GML_TABLE_LABEL,
    client: ctx.clientName,
    system: ctx.system,
    columns: visibleColumns(ctx.grant),
    whole_table: ctx.grant === null,
    filters,
    active_only: true,
    max_limit: MAX_LIMIT,
    rate_limit_per_minute: ctx.rateLimitPerMinute,
    expires_at: ctx.expiresAt,
  };
}

export function buildMcpServer(ctx: McpAccessContext): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions:
        `Read-only access to the Simple HRIS ${GML_TABLE_LABEL} (active people only). ` +
        'Call describe_access first to see which columns this key may read, then query_global_master_list, ' +
        'walking pages with cursor until next_cursor is null.',
    },
  );

  server.registerTool(
    'describe_access',
    {
      title: 'Describe this key’s access',
      description: 'The table, the columns this key may read, the filters it may use, its rate limit and expiry.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      ctx.onToolResult?.('describe_access', {}, null);
      return textResult(describeAccess(ctx));
    },
  );

  server.registerTool(
    'query_global_master_list',
    {
      title: `Query the ${GML_TABLE_LABEL}`,
      description:
        `Active people from the ${GML_TABLE_LABEL}, only the columns this key was granted. ` +
        `Filters: department (exact, case-insensitive), email (matches any visible email column), ` +
        `search (substring over Name and visible email columns). limit 1–${MAX_LIMIT} (default 100); ` +
        'pass the previous page’s next_cursor as cursor to continue. Off-boarded people are never returned.',
      inputSchema: {
        department: z.string().trim().min(1).max(120).optional(),
        email: z.string().trim().email().max(320).optional(),
        search: z.string().trim().min(1).max(120).optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        // Opaque string, NOT a number: `global_master_list.id` is a UUID, so a
        // numeric schema here made every continuation a schema error and capped
        // the tool at its first page (fixed 2026-09-21).
        cursor: z
          .string()
          .trim()
          .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
          .optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const q: GmlQuery = {
        department: args.department ?? null,
        email: args.email ? args.email.toLowerCase() : null,
        search: args.search ?? null,
        limit: args.limit ?? 100,
        cursor: args.cursor ?? null,
      };
      const outcome = await executeGmlRead(ctx.readRows, q, ctx.grant);
      ctx.onToolResult?.('query_global_master_list', args as Record<string, unknown>, outcome);
      if (!outcome.ok) return textResult({ error: outcome.error, details: outcome.details ?? null }, true);
      return textResult({ data: outcome.data, page: outcome.page, columns: outcome.columns });
    },
  );

  return server;
}
