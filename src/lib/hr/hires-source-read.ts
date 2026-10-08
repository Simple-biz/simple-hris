/**
 * The hiring database — the read side. Server-only. READ ONLY: nothing here
 * writes to the source project.
 *
 * Pulls every row of the configured table, paged (PostgREST caps a page at 1000
 * even with .range() — see selectAllPaged) on a stable order (the id column), and
 * hard-capped with an explicit `truncated` flag rather than a silent tail drop
 * (the OMS precedent, oms-hours.ts). Only the configured columns are selected —
 * never `*` — so the HRIS copies the ten checklist fields and nothing else the
 * source happens to hold about an applicant.
 *
 * Doc: docs/features/new-hire-source-sync.md
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { selectAllPaged } from '@/lib/supabase/select-all-paged';

import { HIRES_SOURCE_FIELDS, type HiresSourceConfig } from './hires-source-config';

/** More hires than this in the source is a mistake upstream, not a hiring pipeline. */
export const HIRES_MAX_ROWS = 20_000;

export interface HiresSourcePull {
  rows: Record<string, unknown>[];
  truncated: boolean;
}

export function createHiresSourceClient(cfg: HiresSourceConfig): SupabaseClient {
  return createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** The exact columns read from the source, de-duplicated, id first. */
export function hiresSourceSelectColumns(cfg: HiresSourceConfig): string[] {
  const cols = [
    cfg.idColumn,
    ...HIRES_SOURCE_FIELDS.map((f) => cfg.cols[f]),
    cfg.createdAtColumn,
    cfg.updatedAtColumn,
  ].filter((c): c is string => !!c);
  return [...new Set(cols)];
}

/** Every source hire. Throws with the source's own message on any read error. */
export async function pullSourceHires(
  cfg: HiresSourceConfig,
  client: SupabaseClient = createHiresSourceClient(cfg),
): Promise<HiresSourcePull> {
  const select = hiresSourceSelectColumns(cfg).join(',');
  const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    client
      .from(cfg.table)
      .select(select)
      .order(cfg.idColumn, { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>,
  );
  if (error) throw new Error(`Hiring database read failed: ${error}`);
  const truncated = rows.length > HIRES_MAX_ROWS;
  return { rows: truncated ? rows.slice(0, HIRES_MAX_ROWS) : rows, truncated };
}
