import 'server-only';

import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  SCREENING_DB_COLUMNS,
  SCREENING_MATCH_COLUMN,
  SCREENING_ORDER_FIELD,
} from '@/lib/screening/columns';
import { escapeLikePattern } from '@/lib/db/like-escape';

/**
 * Reconcile engine for the Screening feature (one-way Sheet → DB).
 *
 * CHANGE DETECTION: the source sheet is ~50k rows, so we don't rewrite every row
 * each sync. Each row carries a `row_hash` (fingerprint of its mapped columns).
 * On sync we compare hashes and only write deltas:
 *   - new email/row               → INSERT (is_active = true)
 *   - existing row, hash changed  → UPDATE data + hash
 *   - existing row, reappeared     → reactivate (is_active = true)
 *   - existing row, hash same      → SKIP (zero writes) ← the win
 *   - existing active row absent from the sheet → deactivate (is_active = false)
 * `active_screening` = rows where is_active = true. Removals run LAST, so a
 * mid-sync failure can only leave EXTRA active rows, never blank the board.
 *
 * Match key = lower(trim(email)); rows without an email are keyed by content hash
 * (so identical no-email rows don't churn). Ordering key = `grid_id` (the sheet's
 * own "Grid ID"), surfaced newest-first by getScreeningPage.
 */

const MATCH_COL = SCREENING_MATCH_COLUMN; // "Email Address"

export interface ScreeningSyncResult {
  uploadId: number;
  /** Deduped sheet rows processed. */
  rowCount: number;
  inserted: number;
  /** Rows whose content changed. */
  updated: number;
  /** Rows that reappeared (were inactive, now back). */
  reactivated: number;
  /** Rows that fell off the sheet (set is_active = false). */
  removed: number;
  /** Rows identical to the DB — skipped, no write. */
  unchanged: number;
  rowsMissingEmail: number;
  duplicatesInSheet: number;
}

export interface ScreeningPage {
  rows: Record<string, unknown>[];
  page: number;
  pageSize: number;
}

/** Columns the board search box matches against (ilike, escaped). */
const SEARCH_COLUMNS = ['Name', 'Email Address', 'Screener', 'Source', 'Referral', '2nd Interviewer'];

function adminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error(
      'Supabase service role not configured — set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    );
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const emailKey = (v: unknown): string => String(v ?? '').trim().toLowerCase();

/** Stable fingerprint of the mapped display columns → drives change detection. */
function rowHashOf(r: Record<string, string>): string {
  const h = crypto.createHash('sha256');
  h.update(SCREENING_DB_COLUMNS.map((c) => String(r[c] ?? '').trim()).join(''));
  return h.digest('hex');
}

/** Parse the captured "Grid ID" cell to an int (null if absent/non-numeric). */
function gridIdOf(r: Record<string, string>): number | null {
  const raw = String(r[SCREENING_ORDER_FIELD] ?? '').replace(/[^0-9-]/g, '');
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function isMissingRelation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  const m = (error.message ?? '').toLowerCase();
  return m.includes('does not exist') || m.includes('schema cache');
}

/** Run async tasks with bounded concurrency. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      await fn(items[cur]!);
    }
  });
  await Promise.all(workers);
}

/** Map a sheet row to its DB display-column values (empty → null). */
function buildValues(r: Record<string, string>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const c of SCREENING_DB_COLUMNS) out[c] = r[c]?.trim() ? r[c]! : null;
  return out;
}

export async function replaceScreeningFromRows(
  rows: Record<string, string>[],
  sourceLabel: string,
  uploadedBy: string,
): Promise<ScreeningSyncResult> {
  const sb = adminClient();

  // 1. Dedupe by match key (email, else content hash) — last-wins.
  const byKey = new Map<string, { r: Record<string, string>; hash: string }>();
  let duplicatesInSheet = 0;
  let rowsMissingEmail = 0;
  for (const r of rows) {
    const hash = rowHashOf(r);
    const eK = emailKey(r[MATCH_COL]);
    if (!eK) rowsMissingEmail++;
    const key = eK || `#${hash}`;
    if (byKey.has(key)) duplicatesInSheet++;
    byKey.set(key, { r, hash });
  }

  // Guard: never process an empty sheet — that would deactivate the whole board
  // on an HTTP-200 "success". A cleared/wrong tab should fail loudly instead.
  if (byKey.size === 0) {
    throw new Error(
      'No screening rows found in the sheet — refusing to sync (it would blank the active board). ' +
        'Verify the "Screenings2.0" tab has data rows and that GOOGLE_SHEETS_SCREENING_TAB_NAME is correct.',
    );
  }

  // 2. Audit row for this sync.
  const { data: up, error: upErr } = await sb
    .from('screening_uploads')
    .insert({ source_file: sourceLabel, uploaded_by: uploadedBy, row_count: byKey.size, is_current: false })
    .select('id')
    .single();
  if (upErr || !up) {
    throw new Error(`Could not create screening upload: ${upErr?.message ?? 'no row returned'}`);
  }
  const uploadId = up.id as number;

  // 3. Load existing rows (id + key inputs + hash + active) to diff against.
  const existingByKey = new Map<string, { id: number; hash: string | null; active: boolean }>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('screening')
      .select(`id,"${MATCH_COL}",row_hash,is_active`)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isMissingRelation(error)) {
        throw new Error('The `screening` table does not exist yet — run create_screening.sql (migration #102).');
      }
      throw new Error(`Could not read existing screening rows: ${error.message}`);
    }
    const batch = (data ?? []) as Record<string, unknown>[];
    for (const row of batch) {
      const eK = emailKey(row[MATCH_COL]);
      const key = eK || `#${(row.row_hash as string) ?? ''}`;
      existingByKey.set(key, { id: row.id as number, hash: (row.row_hash as string) ?? null, active: !!row.is_active });
    }
    if (batch.length < PAGE) break;
  }

  // 4. Diff.
  const toInsert: { r: Record<string, string>; hash: string }[] = [];
  const toUpdate: { id: number; r: Record<string, string>; hash: string }[] = [];
  const toReactivate: number[] = [];
  let unchanged = 0;
  const seen = new Set<string>();
  for (const [key, { r, hash }] of byKey) {
    seen.add(key);
    const ex = existingByKey.get(key);
    if (!ex) {
      toInsert.push({ r, hash });
    } else if (ex.hash !== hash) {
      toUpdate.push({ id: ex.id, r, hash });
    } else if (!ex.active) {
      toReactivate.push(ex.id);
    } else {
      unchanged++;
    }
  }
  const toRemove: number[] = [];
  for (const [key, ex] of existingByKey) {
    if (ex.active && !seen.has(key)) toRemove.push(ex.id);
  }

  const nowIso = new Date().toISOString();

  // 4a. UPDATE changed rows (data + hash + grid_id).
  let updated = 0;
  await pool(toUpdate, 10, async ({ id, r, hash }) => {
    const { error } = await sb
      .from('screening')
      .update({
        ...buildValues(r),
        row_hash: hash,
        grid_id: gridIdOf(r),
        is_active: true,
        import_batch_id: uploadId,
        last_seen_upload_id: uploadId,
        source_file: sourceLabel,
        synced_at: nowIso,
      })
      .eq('id', id);
    if (error) throw new Error(`Screening update failed: ${error.message}`);
    updated++;
  });

  // 4b. INSERT new rows — chunked + concurrent (deduped keys ⇒ no unique conflict).
  let inserted = 0;
  const CHUNK = 500;
  const insertChunks: Record<string, string | number | boolean | null>[][] = [];
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    insertChunks.push(
      toInsert.slice(i, i + CHUNK).map(({ r, hash }) => ({
        ...buildValues(r),
        row_hash: hash,
        grid_id: gridIdOf(r),
        is_active: true,
        import_batch_id: uploadId,
        first_seen_upload_id: uploadId,
        last_seen_upload_id: uploadId,
        source_file: sourceLabel,
        synced_at: nowIso,
      })),
    );
  }
  await pool(insertChunks, 5, async (chunk) => {
    const { error, count } = await sb.from('screening').insert(chunk, { count: 'exact' });
    if (error) throw new Error(`Screening insert failed: ${error.message}`);
    inserted += count ?? chunk.length;
  });

  // 4c. Reactivate rows that reappeared unchanged.
  let reactivated = 0;
  const ID_CHUNK = 500;
  for (let i = 0; i < toReactivate.length; i += ID_CHUNK) {
    const chunk = toReactivate.slice(i, i + ID_CHUNK);
    const { error } = await sb
      .from('screening')
      .update({ is_active: true, last_seen_upload_id: uploadId, synced_at: nowIso })
      .in('id', chunk);
    if (error) throw new Error(`Screening reactivate failed: ${error.message}`);
    reactivated += chunk.length;
  }

  // 4d. Deactivate rows absent from the sheet — LAST, so any earlier failure
  //     leaves extra active rows (a safe superset), never a blank board.
  let removed = 0;
  for (let i = 0; i < toRemove.length; i += ID_CHUNK) {
    const chunk = toRemove.slice(i, i + ID_CHUNK);
    const { error } = await sb
      .from('screening')
      .update({ is_active: false, last_seen_upload_id: uploadId, synced_at: nowIso })
      .in('id', chunk);
    if (error) throw new Error(`Screening deactivate failed: ${error.message}`);
    removed += chunk.length;
  }

  // 5. Mark this upload as the latest sync (audit only).
  const { error: offErr } = await sb.from('screening_uploads').update({ is_current: false }).eq('is_current', true);
  if (offErr) throw new Error(`Could not clear current screening upload: ${offErr.message}`);
  const { error: onErr } = await sb.from('screening_uploads').update({ is_current: true }).eq('id', uploadId);
  if (onErr) throw new Error(`Could not promote screening upload: ${onErr.message}`);

  return {
    uploadId,
    rowCount: byKey.size,
    inserted,
    updated,
    reactivated,
    removed,
    unchanged,
    rowsMissingEmail,
    duplicatesInSheet,
  };
}

/** Apply the board's optional case-insensitive search to a query builder. */
function applySearch<Q extends { or: (f: string) => Q }>(query: Q, q: string): Q {
  const term = q.trim();
  if (!term) return query;
  // Escape LIKE wildcards, then strip PostgREST or()-grammar chars so the term is
  // matched literally and can't break the filter.
  const esc = escapeLikePattern(term).replace(/[(),]/g, ' ').trim();
  if (!esc) return query;
  return query.or(SEARCH_COLUMNS.map((c) => `"${c}".ilike.*${esc}*`).join(','));
}

/**
 * A page of the active screening board, ordered LATEST-FIRST (highest grid_id),
 * with an optional search. NO row count is computed here — that's the slow part
 * on a 50k-row board, so the count is fetched separately by {@link getScreeningCount}
 * in the background. This keeps the table paint fast (an indexed LIMIT scan).
 * Returns [] (not an error) when the tables don't exist yet.
 */
export async function getScreeningPage(
  { page = 0, pageSize = 100, q = '' }: { page?: number; pageSize?: number; q?: string },
): Promise<ScreeningPage> {
  const sb = adminClient();
  const size = Math.min(Math.max(1, Math.floor(pageSize) || 100), 200);
  const p = Math.max(0, Math.floor(page) || 0);
  const from = p * size;
  const to = from + size - 1;

  let query = sb.from('active_screening').select('*');
  query = applySearch(query, q);
  query = query
    .order('grid_id', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .range(from, to);

  const { data, error } = await query;
  if (error) {
    if (isMissingRelation(error)) {
      console.warn('[screening] active_screening not found yet — run create_screening.sql (migration #102).');
      return { rows: [], page: p, pageSize: size };
    }
    throw new Error(error.message);
  }
  return { rows: (data ?? []) as Record<string, unknown>[], page: p, pageSize: size };
}

/**
 * Total active-board rows (optionally filtered by the same search). Runs as a
 * separate, background request so it never blocks the first paint. Head-only
 * (no rows) exact count. Returns 0 if the tables don't exist yet.
 */
export async function getScreeningCount(q = ''): Promise<number> {
  const sb = adminClient();
  let query = sb.from('active_screening').select('*', { count: 'exact', head: true });
  query = applySearch(query, q);
  const { count, error } = await query;
  if (error) {
    if (isMissingRelation(error)) return 0;
    throw new Error(error.message);
  }
  return count ?? 0;
}
