// mesa_request_receipts — server CRUD for the receipts attached to a MESA
// disbursement request.
//
// The MESA program has always required a receipt ("Receipts must be submitted
// within 14 days. All receipts must be valid and include the merchant's name."),
// but there was nowhere to put one: it arrived over email, or not at all, so
// Accounting reviewed a disbursement with no evidence attached to the request it
// was deciding. A member now attaches up to three files — photos or PDFs — from
// Employee → MESA → Request → Past requests, and Accounting sees them on the row
// and inside the review modal.
//
// Storage layout (private MESA_RECEIPTS_BUCKET, service-role access only —
// objects are read through short-lived signed URLs, never a public URL):
//   <sanitized-email>/<request-id>/<slot>-<timestamp>.<ext>
//
// Schema: references/sql/migrate/2026-07-29_mesa_request_receipts.sql
//         (apply with `node scripts/apply-mesa-receipts.mjs`)

import 'server-only';

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { normEmail } from '@/lib/email/norm-email';
import {
  MAX_MESA_RECEIPTS,
  MAX_MESA_RECEIPT_BYTES,
  MESA_RECEIPTS_BUCKET,
  mesaReceiptExt,
  type MesaReceiptRow,
  type MesaReceiptWithUrl,
} from './receipt-types';
import { sniffReceiptMime } from './receipt-sniff';

const TABLE = 'mesa_request_receipts';

/** Signed-URL lifetime. Long enough to read a PDF in a new tab, short enough
 *  that a copied link isn't a lasting leak of someone's medical receipt. */
const SIGNED_URL_TTL_SECONDS = 3600;

/** Storage folder that owns one member's receipt objects. */
function emailPathSegment(email: string): string {
  return (email || 'unknown').toLowerCase().replace(/[^a-z0-9._-]/g, '_');
}

/** All receipts for one request, in slot order. */
export async function listMesaReceipts(
  requestId: string,
): Promise<{ rows: MesaReceiptRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('request_id', requestId)
    .order('slot', { ascending: true });
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as MesaReceiptRow[], error: null };
}

/**
 * Receipt counts for a batch of requests, keyed by request_id. Feeds the Receipt
 * column and Accounting's row indicator, so the lists render in one round trip
 * instead of one fetch per row.
 *
 * Returns an empty map on ANY failure — including the table not existing yet,
 * before the migration has been applied. A missing receipts table must degrade
 * to "no receipts", never to a failed request list.
 */
export async function countMesaReceipts(
  requestIds: string[],
): Promise<Record<string, { count: number; last_uploaded_at: string | null }>> {
  const ids = Array.from(new Set(requestIds.filter(Boolean)));
  if (ids.length === 0) return {};

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return {};

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('request_id, uploaded_at')
      .in('request_id', ids);
    if (error || !data) return {};

    const out: Record<string, { count: number; last_uploaded_at: string | null }> = {};
    for (const r of data as { request_id: string; uploaded_at: string | null }[]) {
      const entry = out[r.request_id] ?? { count: 0, last_uploaded_at: null };
      entry.count += 1;
      if (r.uploaded_at && (!entry.last_uploaded_at || r.uploaded_at > entry.last_uploaded_at)) {
        entry.last_uploaded_at = r.uploaded_at;
      }
      out[r.request_id] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

/** Batch-sign object paths for display. */
export async function signMesaReceiptUrls(paths: string[]): Promise<Record<string, string>> {
  const supabase = createSupabaseServiceRoleClient();
  const wanted = paths.filter(Boolean);
  if (!supabase || wanted.length === 0) return {};

  const { data, error } = await supabase.storage
    .from(MESA_RECEIPTS_BUCKET)
    .createSignedUrls(wanted, SIGNED_URL_TTL_SECONDS);
  if (error || !data) return {};

  const out: Record<string, string> = {};
  for (const entry of data) {
    if (entry.path && entry.signedUrl) out[entry.path] = entry.signedUrl;
  }
  return out;
}

/** List + sign in one call — what both the employee dialog and Accounting's
 *  review modal actually want. */
export async function listMesaReceiptsWithUrls(
  requestId: string,
): Promise<{ rows: MesaReceiptWithUrl[]; error: string | null }> {
  const { rows, error } = await listMesaReceipts(requestId);
  if (error) return { rows: [], error };
  const urls = await signMesaReceiptUrls(rows.map((r) => r.file_path));
  return { rows: rows.map((r) => ({ ...r, url: urls[r.file_path] ?? null })), error: null };
}

/**
 * Attach one file to a disbursement request.
 *
 * The 3-receipt cap is the DB's `(request_id, slot)` unique constraint, not this
 * function's count: two submits racing would both read "2 receipts, take slot 3"
 * and one insert has to lose. That loser retries against a re-read of the taken
 * slots, and only reports "already has 3" when there genuinely is no free slot.
 */
export async function createMesaReceipt(params: {
  request_id: string;
  work_email: string;
  uploaded_by: string;
  bytes: ArrayBuffer;
  file_name?: string | null;
  actor?: { user_name: string; user_role: string };
}): Promise<{ row: MesaReceiptRow | null; error: string | null; status?: number }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const bytes = new Uint8Array(params.bytes);
  if (bytes.byteLength === 0) return { row: null, error: 'That file is empty.', status: 400 };
  if (bytes.byteLength > MAX_MESA_RECEIPT_BYTES) {
    return { row: null, error: 'Each receipt must be 5 MB or smaller.', status: 400 };
  }

  const mime = sniffReceiptMime(bytes);
  if (!mime) {
    return {
      row: null,
      error: 'Receipts must be a photo (JPG, PNG, WebP, HEIC) or a PDF.',
      status: 400,
    };
  }

  const email = normEmail(params.work_email) ?? params.work_email.trim().toLowerCase();
  const uploader = normEmail(params.uploaded_by) ?? params.uploaded_by.trim().toLowerCase();
  const fileName = params.file_name?.trim().slice(0, 200) || null;
  const ext = mesaReceiptExt(mime, fileName);

  // Two attempts: the first against the slots we can see, the second against a
  // re-read after losing a unique-constraint race.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { rows: existing, error: listErr } = await listMesaReceipts(params.request_id);
    if (listErr) return { row: null, error: listErr };

    const taken = new Set(existing.map((r) => r.slot));
    const slot = [1, 2, 3].find((s) => !taken.has(s));
    if (!slot) {
      return {
        row: null,
        error: `A request can carry ${MAX_MESA_RECEIPTS} receipts. Remove one to add another.`,
        status: 409,
      };
    }

    const filePath = `${emailPathSegment(email)}/${params.request_id}/${slot}-${Date.now()}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from(MESA_RECEIPTS_BUCKET)
      .upload(filePath, bytes, { contentType: mime, upsert: false });
    if (upErr) return { row: null, error: upErr.message };

    const { data, error } = await supabase
      .from(TABLE)
      .insert({
        request_id: params.request_id,
        work_email: email,
        slot,
        file_path: filePath,
        file_name: fileName,
        file_size: bytes.byteLength,
        mime_type: mime,
        uploaded_by: uploader || null,
      })
      .select('*')
      .single();

    if (error) {
      // Never strand the object when the row didn't land.
      await supabase.storage.from(MESA_RECEIPTS_BUCKET).remove([filePath]).catch(() => {});
      // 23505 = unique violation, i.e. someone took this slot in between.
      const isSlotRace = error.code === '23505';
      if (isSlotRace && attempt === 0) continue;
      return {
        row: null,
        error: isSlotRace
          ? `A request can carry ${MAX_MESA_RECEIPTS} receipts. Remove one to add another.`
          : error.message,
        status: isSlotRace ? 409 : 500,
      };
    }

    const row = data as MesaReceiptRow;
    void insertAuditLog({
      user_name: params.actor?.user_name ?? uploader ?? email,
      user_role: params.actor?.user_role ?? 'user',
      action: 'mesa.receipt.uploaded',
      resource: TABLE,
      resource_id: row.id,
      details: {
        request_id: params.request_id,
        work_email: email,
        slot: row.slot,
        file_name: fileName,
        file_size: row.file_size,
        mime_type: mime,
      },
    });

    return { row, error: null };
  }

  return {
    row: null,
    error: `A request can carry ${MAX_MESA_RECEIPTS} receipts. Remove one to add another.`,
    status: 409,
  };
}

/**
 * Remove one receipt (row + object).
 *
 * Every deletion is audited. Receipts are Accounting's evidence that a
 * disbursement was legitimate, and a member fixing a mis-picked file is the
 * common case — so removal stays available rather than being locked at approval,
 * and the audit trail is what records that a file was pulled and by whom.
 */
export async function deleteMesaReceipt(params: {
  id: string;
  request_id: string;
  actor?: { user_name: string; user_role: string };
}): Promise<{ error: string | null; status?: number }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const { data: existing, error: fetchErr } = await supabase
    .from(TABLE)
    .select('*')
    .eq('id', params.id)
    .eq('request_id', params.request_id)
    .maybeSingle();
  if (fetchErr) return { error: fetchErr.message };
  if (!existing) return { error: 'Receipt not found', status: 404 };
  const row = existing as MesaReceiptRow;

  const { error } = await supabase.from(TABLE).delete().eq('id', params.id);
  if (error) return { error: error.message };

  // Row first, object second: an orphaned object is invisible clutter, whereas a
  // row pointing at a deleted object renders as a broken receipt.
  await supabase.storage.from(MESA_RECEIPTS_BUCKET).remove([row.file_path]).catch(() => {});

  void insertAuditLog({
    user_name: params.actor?.user_name ?? row.work_email,
    user_role: params.actor?.user_role ?? 'user',
    action: 'mesa.receipt.deleted',
    resource: TABLE,
    resource_id: params.id,
    details: {
      request_id: params.request_id,
      work_email: row.work_email,
      slot: row.slot,
      file_name: row.file_name,
      uploaded_at: row.uploaded_at,
      uploaded_by: row.uploaded_by,
    },
  });

  return { error: null };
}
