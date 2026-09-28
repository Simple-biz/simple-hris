/**
 * Send to OMS — the write side. Server-only.
 *
 * The ONE place the HRIS writes to the Orphanage Management System (Kane, 2026-09-28:
 * "i mean to OMS"). It appends rows to the table OMS created for this and named in
 * `OMS_RETURN_TABLE`; it never updates, never deletes, and never touches OMS's hours
 * table (readOmsReturnConfig refuses that name).
 *
 *   probeOmsReturnTable  count:'exact' WITHOUT head:true — a HEAD count against a
 *                        missing table can come back as a clean zero; this must fail
 *                        loud, naming what OMS has to create or grant.
 *   insertOmsReturn      ONE array insert = one statement = all rows or none. Never
 *                        chunked: a half-landed send is an accounting report that
 *                        silently omits people.
 *   latestOmsReturn      the newest send for a week, read back from OMS itself —
 *                        what they HAVE, not what we think we sent. Paged.
 *
 * Doc: docs/features/orphanage-oms-pull.md § Sending to OMS
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { selectAllPaged } from '@/lib/supabase/select-all-paged';

import type { OmsReturnConfig } from './oms-config';

export function createOmsReturnClient(cfg: OmsReturnConfig): SupabaseClient {
  return createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false } });
}

type PgError = { code?: string | null; message: string };

/** Turn a PostgREST error into the sentence the modal shows: what is missing, and whose job it is. */
export function describeOmsReturnError(table: string, error: PgError, verb: 'read' | 'write'): string {
  const probe = `${error.code ?? ''} ${error.message}`;
  // Column first: "column x does not exist" would otherwise read as a missing table.
  if (/column .* does not exist|PGRST204|42703/i.test(probe)) {
    return `"${table}" in OMS does not have the columns the HRIS sends — recreate it from the DDL in orphanage-oms-pull.md (${error.message})`;
  }
  if (/does not exist|schema cache|PGRST205|42P01/i.test(probe)) {
    return `OMS has no table named "${table}" yet — the OMS team creates it from the DDL in orphanage-oms-pull.md`;
  }
  if (/permission denied|42501|row-level security|RLS/i.test(probe)) {
    return verb === 'write'
      ? `The OMS key cannot write "${table}" — OMS must grant INSERT on it to the key's role`
      : `The OMS key cannot read "${table}" — OMS must grant SELECT on it to the key's role`;
  }
  return `OMS ${verb} failed: ${error.message}`;
}

export async function probeOmsReturnTable(
  cfg: OmsReturnConfig,
  client: SupabaseClient = createOmsReturnClient(cfg),
): Promise<{ ready: boolean; reason: string | null }> {
  const { error } = await client.from(cfg.table).select('push_id', { count: 'exact' }).limit(1);
  if (!error) return { ready: true, reason: null };
  return { ready: false, reason: describeOmsReturnError(cfg.table, error, 'read') };
}

export async function insertOmsReturn(
  cfg: OmsReturnConfig,
  records: ReadonlyArray<Record<string, unknown>>,
  client: SupabaseClient = createOmsReturnClient(cfg),
): Promise<{ error: string | null }> {
  if (records.length === 0) return { error: 'Nothing to send' };
  // `returning: minimal` semantics: no select() — the ack is the absence of an error,
  // and OMS need not grant SELECT for a send to land.
  const { error } = await client.from(cfg.table).insert(records as Record<string, unknown>[]);
  if (error) return { error: describeOmsReturnError(cfg.table, error, 'write') };
  return { error: null };
}

export interface OmsReturnSummary {
  pushId: string;
  pushedAt: string;
  pushedBy: string;
  cycleLocked: boolean;
  people: number;
  amountPhp: number;
}

export async function latestOmsReturn(
  cfg: OmsReturnConfig,
  weekStart: string,
  client: SupabaseClient = createOmsReturnClient(cfg),
): Promise<{ latest: OmsReturnSummary | null; error: string | null }> {
  const head = await client
    .from(cfg.table)
    .select('push_id, pushed_at, pushed_by, cycle_locked')
    .eq('week_start', weekStart)
    .order('pushed_at', { ascending: false })
    .limit(1);
  if (head.error) return { latest: null, error: describeOmsReturnError(cfg.table, head.error, 'read') };
  const first = (head.data?.[0] ?? null) as { push_id: string; pushed_at: string; pushed_by: string; cycle_locked: boolean } | null;
  if (!first) return { latest: null, error: null };

  const { rows, error } = await selectAllPaged<{ amount_php: number | string | null }>((from, to) =>
    client
      .from(cfg.table)
      .select('amount_php, hris_email')
      .eq('push_id', first.push_id)
      .order('hris_email', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: { amount_php: number | string | null }[] | null; error: { message: string } | null }>,
  );
  if (error) return { latest: null, error: `OMS read failed: ${error}` };
  const total = rows.reduce((s, r) => s + (Number(r.amount_php) || 0), 0);
  return {
    latest: {
      pushId: first.push_id,
      pushedAt: first.pushed_at,
      pushedBy: first.pushed_by,
      cycleLocked: first.cycle_locked === true,
      people: rows.length,
      amountPhp: Math.round(total * 100) / 100,
    },
    error: null,
  };
}
