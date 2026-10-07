/**
 * The MCP face of the external read API — Kane, 2026-09-17: *"let them pull via
 * querying or MCP."*
 *
 * ONE server shape, built per request (stateless Streamable HTTP; nothing is held
 * between calls, so a revoke or an expiry is honoured on the very next POST, like
 * REST). Every tool is a read, and `mcp-server.test.ts` pins the list — a new tool,
 * or a write, fails the suite:
 *
 *   describe_access            what THIS key may see: per dataset it holds, the
 *                              columns, the filters, the limit, the expiry
 *   query_global_master_list   (scope global_master_list.read) the roster REST
 *                              contract as a tool → { data, page, columns }
 *   query_offboarded           (scope offboarded.read, 2026-10-07) the leavers REST
 *                              contract as a tool → { data, page, columns }
 *
 * **A tool is registered only when the key holds its scope** (`toolsFor`). A key
 * without `offboarded.read` cannot list or call `query_offboarded` — it is not there
 * to refuse. A roster-only key sees exactly the two tools, the instructions and the
 * `describe_access` payload it saw before the second scope existed; the test pins them.
 *
 * Each query tool goes through the same pipeline its REST route runs
 * (`executeGmlRead` / `executeOffboardedRead`), so a hidden column is absent here for
 * the same reason it is absent there. Rate limiting and the request log live in the
 * ROUTE (one POST = one call against the same budget REST spends); this module never
 * touches the database directly.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GML_TABLE_KEY, GML_TABLE_LABEL } from './catalog';
import { executeGmlRead, type GmlReadOutcome, type ReadRows } from './gml-read';
import { MAX_LIMIT, type GmlQuery } from './gml-query';
import { filterVisibility, visibleColumns, type Grant } from './grants';
import {
  OFFBOARDED_COLUMNS,
  OFFBOARDED_LABEL,
  OFFBOARDED_TABLE,
  REASON_CATEGORIES,
  executeOffboardedRead,
  parseOffboardedQuery,
  type OffboardedReadOutcome,
  type ReadOffboardedRows,
} from './offboarded';
import { GML_SCOPE, OFFBOARDED_SCOPE, holdsScope } from './scopes';

export const MCP_SERVER_NAME = 'simple-hris-external';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_TOOL_NAMES = ['describe_access', 'query_global_master_list', 'query_offboarded'] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** The query tool each scope unlocks. `describe_access` is every key's. */
export const TOOL_FOR_SCOPE = {
  [GML_SCOPE]: 'query_global_master_list',
  [OFFBOARDED_SCOPE]: 'query_offboarded',
} as const satisfies Record<string, McpToolName>;

/** The tools a key with these scopes sees, in `MCP_TOOL_NAMES` order. */
export function toolsFor(scopes: unknown): McpToolName[] {
  const out: McpToolName[] = ['describe_access'];
  if (holdsScope(scopes, GML_SCOPE)) out.push('query_global_master_list');
  if (holdsScope(scopes, OFFBOARDED_SCOPE)) out.push('query_offboarded');
  return out;
}

/** A tool call refused before any read (a date that does not exist, until before since). */
export type McpToolRefusal = { ok: false; status: 400; denial: 'bad_request'; error: string };

export type McpToolOutcome = GmlReadOutcome | OffboardedReadOutcome | McpToolRefusal;

export type McpAccessContext = {
  clientName: string;
  system: string;
  /** The key's scopes — which query tools exist for it. */
  scopes: readonly string[];
  grant: Grant;
  rateLimitPerMinute: number;
  expiresAt: string | null;
  readRows: ReadRows;
  readOffboardedRows: ReadOffboardedRows;
  /** Called after every tool run, success or refusal — the route logs the row count from it. */
  onToolResult?: (tool: McpToolName, args: Record<string, unknown>, outcome: McpToolOutcome | null) => void;
};

function textResult(payload: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
}

function offboardedAccess() {
  return {
    table: OFFBOARDED_TABLE,
    table_label: OFFBOARDED_LABEL,
    tool: 'query_offboarded',
    columns: [...OFFBOARDED_COLUMNS],
    filters: ['email', 'department', 'reason', 'since', 'until', 'search'],
    reasons: [...REASON_CATEGORIES],
    max_limit: MAX_LIMIT,
  };
}

export type DescribeAccessPayload = {
  /** The roster block — present only when the key holds `global_master_list.read`. */
  table?: string;
  table_label?: string;
  client: string;
  system: string;
  columns?: string[];
  whole_table?: boolean;
  filters?: string[];
  active_only?: true;
  max_limit?: number;
  rate_limit_per_minute: number;
  expires_at: string | null;
  /** Present only when the key holds `offboarded.read`. */
  offboarded?: ReturnType<typeof offboardedAccess>;
};

/**
 * For a roster key, the SAME object it got before 2026-10-07 (the test pins it), plus an
 * `offboarded` block only when the key also holds that scope. A leavers-only key gets the
 * client fields and the `offboarded` block — never the roster's columns.
 */
export function describeAccess(ctx: McpAccessContext): DescribeAccessPayload {
  const common = {
    client: ctx.clientName,
    system: ctx.system,
    rate_limit_per_minute: ctx.rateLimitPerMinute,
    expires_at: ctx.expiresAt,
  };
  const offboarded = holdsScope(ctx.scopes, OFFBOARDED_SCOPE) ? { offboarded: offboardedAccess() } : {};
  if (!holdsScope(ctx.scopes, GML_SCOPE)) return { ...common, ...offboarded };

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
    active_only: true as const,
    max_limit: MAX_LIMIT,
    rate_limit_per_minute: ctx.rateLimitPerMinute,
    expires_at: ctx.expiresAt,
    ...offboarded,
  };
}

/** Byte-identical to the roster-only text shipped 2026-09-17. */
export const GML_ONLY_INSTRUCTIONS =
  `Read-only access to the Simple HRIS ${GML_TABLE_LABEL} (active people only). ` +
  'Call describe_access first to see which columns this key may read, then query_global_master_list, ' +
  'walking pages with cursor until next_cursor is null.';

export function instructionsFor(scopes: readonly string[]): string {
  const gml = holdsScope(scopes, GML_SCOPE);
  const off = holdsScope(scopes, OFFBOARDED_SCOPE);
  if (gml && !off) return GML_ONLY_INSTRUCTIONS;
  const parts: string[] = [];
  if (gml) parts.push(`query_global_master_list reads the ${GML_TABLE_LABEL} (active people only)`);
  if (off) parts.push('query_offboarded reads the Offboarded list (one row per recorded departure)');
  return (
    'Read-only access to Simple HRIS. Call describe_access first to see what this key may read. ' +
    `${parts.join('; ')}. Walk pages with cursor until next_cursor is null.`
  );
}

export function buildMcpServer(ctx: McpAccessContext): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: instructionsFor(ctx.scopes) },
  );

  server.registerTool(
    'describe_access',
    {
      title: 'Describe this key’s access',
      description: holdsScope(ctx.scopes, OFFBOARDED_SCOPE)
        ? 'The datasets this key may read, their columns and filters, its rate limit and expiry.'
        : 'The table, the columns this key may read, the filters it may use, its rate limit and expiry.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      ctx.onToolResult?.('describe_access', {}, null);
      return textResult(describeAccess(ctx));
    },
  );

  if (holdsScope(ctx.scopes, GML_SCOPE)) {
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
  }

  if (holdsScope(ctx.scopes, OFFBOARDED_SCOPE)) {
    server.registerTool(
      'query_offboarded',
      {
        title: 'Query the Offboarded list',
        description:
          'One row per recorded departure (a re-hire who left twice has two rows): name, work email, department, ' +
          'start date, when they left, the reason category and where the record came from. Temporary pauses are ' +
          'never returned. Filters: email (exact work email), department (exact, case-insensitive), reason (a ' +
          `category: ${REASON_CATEGORIES.join(', ')}), since / until (YYYY-MM-DD, inclusive, on the date they left), ` +
          `search (substring over name and work email). limit 1–${MAX_LIMIT} (default 100); pass the previous ` +
          'page’s next_cursor as cursor to continue.',
        inputSchema: {
          email: z.string().trim().email().max(320).optional(),
          department: z.string().trim().min(1).max(120).optional(),
          reason: z.enum(REASON_CATEGORIES).optional(),
          since: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          until: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          search: z.string().trim().min(1).max(120).optional(),
          limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
          // Opaque digits — the ledger id is a bigint. A string, so a caller echoes it untouched.
          cursor: z.string().trim().regex(/^\d{1,15}$/).optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async (args) => {
        // One parser for both faces: the tool's arguments become the REST query string.
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(args)) if (v !== undefined) params.set(k, String(v));
        const parsed = parseOffboardedQuery(params);
        if (!parsed.ok) {
          ctx.onToolResult?.('query_offboarded', args as Record<string, unknown>, {
            ok: false,
            status: 400,
            denial: 'bad_request',
            error: 'Invalid query',
          });
          return textResult({ error: 'Invalid query', details: parsed.errors }, true);
        }
        const outcome = await executeOffboardedRead(ctx.readOffboardedRows, parsed.query);
        ctx.onToolResult?.('query_offboarded', args as Record<string, unknown>, outcome);
        if (!outcome.ok) return textResult({ error: outcome.error }, true);
        return textResult({ data: outcome.data, page: outcome.page, columns: outcome.columns });
      },
    );
  }

  return server;
}
