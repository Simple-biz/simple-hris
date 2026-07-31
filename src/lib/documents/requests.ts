// document_requests — server CRUD for the Documents flow.
//
// Employee (Profile → Request Documents) submits a PDF → row lands `pending`
// in Accounting → Documents. Approving stamps the approver's saved signature
// into the PDF (appended certification page carrying the requested + signed
// dates and the request id — see sign-pdf.ts) and stores the signed copy next
// to the original; the employee downloads it from their profile. Rejection
// records a note. Originals are never mutated.
//
// Storage layout (private DOCUMENT_REQUESTS_BUCKET, service-role access only):
//   <sanitized-email>/<request-id>/original.pdf
//   <sanitized-email>/<request-id>/signed.pdf

import { randomUUID } from 'crypto';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { resolveUserRole } from '@/lib/supabase/pab-day-disputes';
import { normEmail } from '@/lib/email/norm-email';
import { stampSignedDocument } from './sign-pdf';
import { getDocumentSignature } from './signatures';
import { renderCoeDocument } from './coe-document';
import { coeSummaryLabel, resolveCoeFacts } from './coe-facts';
import {
  DOCUMENT_REQUESTS_BUCKET,
  MAX_DOCUMENT_BYTES,
  documentTypeLabel,
  isDocumentRequestType,
  type DocumentRequestRow,
  type DocumentRequestStatus,
} from './types';

const TABLE = 'document_requests';

/** Storage folder that owns one employee's request objects. */
function emailPathSegment(email: string): string {
  return (email || 'unknown').toLowerCase().replace(/[^a-z0-9._-]/g, '_');
}

/** Light content check so non-PDFs can't enter the signing flow. */
function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.slice(0, 5));
  return head === '%PDF-';
}

export async function listDocumentRequests(opts?: {
  email?: string;
  status?: DocumentRequestStatus;
  limit?: number;
}): Promise<{ rows: DocumentRequestRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  let query = supabase.from(TABLE).select('*').order('requested_at', { ascending: false });
  if (opts?.email) {
    // Rows are written lowercased, so exact match is safe (ilike would treat
    // '_' in an email as a single-char wildcard).
    const em = normEmail(opts.email) ?? opts.email.trim().toLowerCase();
    query = query.eq('employee_email', em);
  }
  if (opts?.status) query = query.eq('status', opts.status);
  query = query.limit(opts?.limit && opts.limit > 0 ? Math.min(opts.limit, 500) : 200);

  const { data, error } = await query;
  return { rows: (data ?? []) as DocumentRequestRow[], error: error?.message ?? null };
}

export async function getDocumentRequestById(
  id: string,
): Promise<{ row: DocumentRequestRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };
  const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  return { row: (data as DocumentRequestRow) ?? null, error: error?.message ?? null };
}

/**
 * Employee submit: upload the original PDF + insert the `pending` row.
 * `requested_at` (the row default) is the requested date later burned into the
 * certification page.
 */
export async function createDocumentRequest(params: {
  employee_email: string;
  employee_name?: string | null;
  document_type: string;
  period_label?: string | null;
  note?: string | null;
  file_name?: string | null;
  bytes: ArrayBuffer;
}): Promise<{ row: DocumentRequestRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const email = normEmail(params.employee_email) ?? params.employee_email.trim().toLowerCase();
  if (!email) return { row: null, error: 'Missing employee email' };
  if (!isDocumentRequestType(params.document_type)) {
    return { row: null, error: `Invalid document type: ${params.document_type}` };
  }

  const bytes = new Uint8Array(params.bytes);
  if (bytes.byteLength === 0) return { row: null, error: 'Empty file' };
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) return { row: null, error: 'Max 10 MB per document' };
  if (!looksLikePdf(bytes)) return { row: null, error: 'Only PDF documents can be submitted for signing' };

  const id = randomUUID();
  const filePath = `${emailPathSegment(email)}/${id}/original.pdf`;

  const { error: upErr } = await supabase.storage
    .from(DOCUMENT_REQUESTS_BUCKET)
    .upload(filePath, bytes, { contentType: 'application/pdf', upsert: false });
  if (upErr) return { row: null, error: upErr.message };

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      id,
      employee_email: email,
      employee_name: params.employee_name?.trim() || null,
      document_type: params.document_type,
      period_label: params.period_label?.trim() || null,
      note: params.note?.trim() || null,
      file_path: filePath,
      file_name: params.file_name?.trim() || null,
      file_size: bytes.byteLength,
      status: 'pending' as const,
    })
    .select('*')
    .single();
  if (error) {
    // Don't strand the uploaded object if the row insert failed.
    await supabase.storage.from(DOCUMENT_REQUESTS_BUCKET).remove([filePath]).catch(() => {});
    return { row: null, error: error.message };
  }
  const row = data as DocumentRequestRow;

  void (async () => {
    const role = await resolveUserRole(email, 'Employee');
    await insertAuditLog({
      user_name: email,
      user_role: role,
      action: 'documents.request_submitted',
      resource: TABLE,
      resource_id: row.id,
      details: { document_type: row.document_type, period_label: row.period_label, file_name: row.file_name },
    });
  })();
  void notifyAccountingOfRequest(row);

  return { row, error: null };
}

/**
 * Employee submit for a **Certificate of Engagement** — the one document type
 * the worker does NOT supply. Nothing is uploaded: the HRIS resolves the facts
 * from the master list and the Payment Catalog, renders the certificate, and
 * files it as the request's "original" so Accounting reviews the real document
 * rather than an attachment.
 *
 * The stored copy is the WATERMARKED draft. Approving re-renders from live data
 * and draws the approver's signature into the certificate's own signature block
 * (see signDocumentRequest).
 *
 * Returns `blocked` when the certificate cannot honestly be issued — no start
 * date, no department, no rate on file. The message is written for the employee.
 */
export async function createCoeDocumentRequest(params: {
  employee_email: string;
  note?: string | null;
}): Promise<{ row: DocumentRequestRow | null; blocked: string | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, blocked: null, error: 'Supabase not configured' };

  const email = normEmail(params.employee_email) ?? params.employee_email.trim().toLowerCase();
  if (!email) return { row: null, blocked: null, error: 'Missing employee email' };

  const { facts, blocked, error: factsErr } = await resolveCoeFacts(email);
  if (factsErr) return { row: null, blocked: null, error: factsErr };
  if (blocked) return { row: null, blocked: blocked.message, error: null };
  if (!facts) return { row: null, blocked: null, error: 'Could not resolve certificate details' };

  const id = randomUUID();
  const generatedAtIso = new Date().toISOString();

  let bytes: Uint8Array;
  try {
    bytes = await renderCoeDocument({ facts, requestId: id, generatedAtIso });
  } catch (e) {
    return {
      row: null,
      blocked: null,
      error: e instanceof Error ? e.message : 'Could not generate the certificate',
    };
  }

  const filePath = `${emailPathSegment(email)}/${id}/original.pdf`;
  const { error: upErr } = await supabase.storage
    .from(DOCUMENT_REQUESTS_BUCKET)
    .upload(filePath, bytes, { contentType: 'application/pdf', upsert: false });
  if (upErr) return { row: null, blocked: null, error: upErr.message };

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      id,
      employee_email: email,
      employee_name: facts.workerName,
      document_type: 'coe' as const,
      // Rides the existing column so the queue chip shows what was certified
      // without opening the PDF — no schema change needed.
      period_label: coeSummaryLabel(facts),
      note: params.note?.trim() || null,
      file_path: filePath,
      file_name: 'certificate-of-engagement.pdf',
      file_size: bytes.byteLength,
      status: 'pending' as const,
    })
    .select('*')
    .single();
  if (error) {
    await supabase.storage.from(DOCUMENT_REQUESTS_BUCKET).remove([filePath]).catch(() => {});
    return { row: null, blocked: null, error: error.message };
  }
  const row = data as DocumentRequestRow;

  void (async () => {
    const role = await resolveUserRole(email, 'Employee');
    await insertAuditLog({
      user_name: email,
      user_role: role,
      action: 'documents.request_submitted',
      resource: TABLE,
      resource_id: row.id,
      details: {
        document_type: 'coe',
        generated: true,
        start_date: facts.startDateRaw,
        team: facts.team,
        hourly_rate: facts.hourlyRate,
        overtime_rate: facts.overtimeRate,
        currency: facts.currency,
        rate_source: facts.rateSource,
      },
    });
  })();
  void notifyAccountingOfRequest(row);

  return { row, blocked: null, error: null };
}

/** Employee cancel — own request, while still pending. Removes the objects too. */
export async function cancelDocumentRequest(
  id: string,
  requesterEmail: string,
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const email = normEmail(requesterEmail) ?? requesterEmail.trim().toLowerCase();
  const { row, error: fetchErr } = await getDocumentRequestById(id);
  if (fetchErr) return { error: fetchErr };
  if (!row) return { error: 'Request not found' };
  if (row.employee_email.trim().toLowerCase() !== email) {
    return { error: 'Not authorized — you can only cancel your own requests' };
  }
  if (row.status !== 'pending') {
    return { error: 'Only pending requests can be cancelled' };
  }

  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) return { error: error.message };

  const paths = [row.file_path, row.signed_file_path].filter((p): p is string => !!p);
  if (paths.length > 0) {
    await supabase.storage.from(DOCUMENT_REQUESTS_BUCKET).remove(paths).catch(() => {});
  }

  void (async () => {
    const role = await resolveUserRole(email, 'Employee');
    await insertAuditLog({
      user_name: email,
      user_role: role,
      action: 'documents.request_cancelled',
      resource: TABLE,
      resource_id: id,
      details: { document_type: row.document_type },
    });
  })();

  return { error: null };
}

/**
 * Accounting approve: stamp the approver's saved signature into the original
 * PDF and store the signed copy. Requires the approver's OWN signature row to
 * exist AND be enabled (the revoke switch) — route-level feature authz is the
 * caller's job. Returns the updated row.
 */
export async function signDocumentRequest(
  id: string,
  approverEmail: string,
): Promise<{ row: DocumentRequestRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const approver = normEmail(approverEmail) ?? approverEmail.trim().toLowerCase();
  const { row, error: fetchErr } = await getDocumentRequestById(id);
  if (fetchErr) return { row: null, error: fetchErr };
  if (!row) return { row: null, error: 'Request not found' };
  if (row.status !== 'pending') return { row: null, error: 'Request is no longer pending' };

  const { row: signature, error: sigErr } = await getDocumentSignature(approver);
  if (sigErr) return { row: null, error: sigErr };
  if (!signature) {
    return { row: null, error: 'No saved signature — draw and save your signature in the Documents tab first' };
  }
  if (!signature.enabled) {
    return { row: null, error: 'Your signature is switched off — turn it back on to sign documents' };
  }

  const signedAtIso = new Date().toISOString();
  const signerName = signature.owner_name?.trim() || approver;
  const signerTitle = signature.title?.trim() || 'Accounting Head';

  // A Certificate of Engagement is generated by us, so the signed copy is
  // RE-RENDERED from live data rather than stamped over the stored draft: a
  // certificate asserts current engagement terms, and signing a draft written
  // days earlier could attest a rate that has since changed. The signature goes
  // into the certificate's own signature block, and the shared certification
  // page is appended behind it for the Reference ID and both dates.
  let baseBytes: Uint8Array | ArrayBuffer;
  if (row.document_type === 'coe') {
    const { facts, blocked, error: factsErr } = await resolveCoeFacts(row.employee_email);
    if (factsErr) return { row: null, error: `Could not re-check the certificate details: ${factsErr}` };
    if (blocked) {
      return {
        row: null,
        error: `This certificate can no longer be issued as written — ${blocked.message}`,
      };
    }
    if (!facts) return { row: null, error: 'Could not resolve certificate details' };
    try {
      baseBytes = await renderCoeDocument({
        facts,
        requestId: row.id,
        generatedAtIso: signedAtIso,
        signature: {
          dataUrl: signature.image_data_url,
          name: signerName,
          title: signerTitle,
          email: approver,
          signedAtIso,
        },
      });
    } catch (e) {
      return {
        row: null,
        error: e instanceof Error ? e.message : 'Could not generate the signed certificate',
      };
    }
  } else {
    const { data: original, error: dlErr } = await supabase.storage
      .from(DOCUMENT_REQUESTS_BUCKET)
      .download(row.file_path);
    if (dlErr || !original) {
      return { row: null, error: `Could not load the submitted PDF: ${dlErr?.message ?? 'not found'}` };
    }
    baseBytes = await original.arrayBuffer();
  }

  let signedBytes: Uint8Array;
  try {
    signedBytes = await stampSignedDocument({
      originalBytes: baseBytes,
      signatureDataUrl: signature.image_data_url,
      signerName,
      signerTitle,
      signerEmail: approver,
      employeeName: row.employee_name?.trim() || row.employee_email,
      employeeEmail: row.employee_email,
      documentLabel: documentTypeLabel(row.document_type),
      periodLabel: row.period_label,
      requestId: row.id,
      requestedAtIso: row.requested_at,
      signedAtIso,
    });
  } catch (e) {
    return { row: null, error: e instanceof Error ? e.message : 'Could not stamp the PDF' };
  }

  const signedPath = row.file_path.replace(/original\.pdf$/, 'signed.pdf');
  const { error: upErr } = await supabase.storage
    .from(DOCUMENT_REQUESTS_BUCKET)
    .upload(signedPath, signedBytes, { contentType: 'application/pdf', upsert: true });
  if (upErr) return { row: null, error: `Could not store the signed copy: ${upErr.message}` };

  const { data: updated, error: updErr } = await supabase
    .from(TABLE)
    .update({
      status: 'signed' as const,
      signed_file_path: signedPath,
      signed_at: signedAtIso,
      signed_by: approver,
      signed_by_name: signerName,
      signed_by_title: signerTitle,
      decision_note: null,
      updated_at: signedAtIso,
    })
    .eq('id', id)
    .eq('status', 'pending') // guard against a concurrent decision
    .select('*')
    .maybeSingle();
  if (updErr) return { row: null, error: updErr.message };
  if (!updated) return { row: null, error: 'Request was decided by someone else just now' };
  const signedRow = updated as DocumentRequestRow;

  void (async () => {
    const role = await resolveUserRole(approver, 'Accounting');
    await insertAuditLog({
      user_name: approver,
      user_role: role,
      action: 'documents.request_signed',
      resource: TABLE,
      resource_id: id,
      details: {
        employee: row.employee_email,
        document_type: row.document_type,
        signed_at: signedAtIso,
        requested_at: row.requested_at,
      },
    });
  })();
  void notifyEmployeeOfDecision(signedRow);

  return { row: signedRow, error: null };
}

/** Accounting reject — records the reason and notifies the employee. */
export async function rejectDocumentRequest(
  id: string,
  approverEmail: string,
  note?: string | null,
): Promise<{ row: DocumentRequestRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const approver = normEmail(approverEmail) ?? approverEmail.trim().toLowerCase();
  const { row, error: fetchErr } = await getDocumentRequestById(id);
  if (fetchErr) return { row: null, error: fetchErr };
  if (!row) return { row: null, error: 'Request not found' };
  if (row.status !== 'pending') return { row: null, error: 'Request is no longer pending' };

  const nowIso = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from(TABLE)
    .update({
      status: 'rejected' as const,
      decision_note: note?.trim() || null,
      signed_by: approver,
      signed_at: null,
      signed_file_path: null,
      updated_at: nowIso,
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  if (!updated) return { row: null, error: 'Request was decided by someone else just now' };
  const rejectedRow = updated as DocumentRequestRow;

  void (async () => {
    const role = await resolveUserRole(approver, 'Accounting');
    await insertAuditLog({
      user_name: approver,
      user_role: role,
      action: 'documents.request_rejected',
      resource: TABLE,
      resource_id: id,
      details: { employee: row.employee_email, document_type: row.document_type, note: note ?? null },
    });
  })();
  void notifyEmployeeOfDecision(rejectedRow);

  return { row: rejectedRow, error: null };
}

/** Short-lived (1h) signed URL for the original or the signed copy. */
export async function signedUrlForDocumentFile(
  row: DocumentRequestRow,
  which: 'original' | 'signed',
): Promise<{ url: string | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { url: null, error: 'Supabase not configured' };

  const path = which === 'signed' ? row.signed_file_path : row.file_path;
  if (!path) return { url: null, error: which === 'signed' ? 'No signed copy yet' : 'No file' };

  // Signed copies download with a friendly filename; originals open INLINE so
  // "preview" actually renders the PDF in the browser tab.
  const options = which === 'signed'
    ? { download: `signed-${documentTypeLabel(row.document_type).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf` }
    : undefined;
  const { data, error } = await supabase.storage
    .from(DOCUMENT_REQUESTS_BUCKET)
    .createSignedUrl(path, 3600, options);
  if (error || !data?.signedUrl) return { url: null, error: error?.message ?? 'Could not sign URL' };
  return { url: data.signedUrl, error: null };
}

// ── Notifications (best-effort; never fail the write they ride on) ──────────

/** New request → accounting + admin role holders (visibility of the accounting
 *  leg is feature-gated on the Documents grant, see notification-views.ts). */
async function notifyAccountingOfRequest(row: DocumentRequestRow): Promise<void> {
  try {
    const supabase = createSupabaseServiceRoleClient();
    if (!supabase) return;
    const { data: roleRows } = await supabase
      .from('employee_roles')
      .select('work_email')
      .in('role', ['admin', 'accounting'])
      .is('revoked_at', null);
    const recipients = Array.from(
      new Set(
        (roleRows ?? [])
          .map((r: { work_email?: string | null }) => (r.work_email ?? '').trim().toLowerCase())
          .filter(Boolean),
      ),
    );
    if (recipients.length === 0) return;
    const who = row.employee_name?.trim() || row.employee_email;
    await supabase.from('employee_notifications').insert(
      recipients.map((to) => ({
        recipient_email: to,
        type: 'documents.requested',
        tone: 'neutral',
        title: 'New document signing request',
        message: `${who} asked Accounting to sign: ${documentTypeLabel(row.document_type)}${
          row.period_label ? ` (${row.period_label})` : ''
        }. Review it in the Documents tab.`,
        details: { request_id: row.id, document_type: row.document_type, employee: row.employee_email },
      })),
    );
  } catch {
    /* notification failure must never fail the submit */
  }
}

/** Signed / rejected → the requesting employee ("returned back as a signed document"). */
async function notifyEmployeeOfDecision(row: DocumentRequestRow): Promise<void> {
  try {
    const supabase = createSupabaseServiceRoleClient();
    if (!supabase) return;
    const label = documentTypeLabel(row.document_type);
    const signed = row.status === 'signed';
    await supabase.from('employee_notifications').insert({
      recipient_email: row.employee_email,
      type: signed ? 'documents.signed' : 'documents.rejected',
      tone: signed ? 'positive' : 'neutral',
      title: signed ? 'Your document has been signed' : 'Document request rejected',
      message: signed
        ? `${row.signed_by_name || 'Accounting'} signed your ${label}. Download the signed copy from Profile → Request Documents.`
        : `Accounting did not sign your ${label}${row.decision_note ? `: "${row.decision_note}"` : '.'}`,
      details: {
        request_id: row.id,
        document_type: row.document_type,
        signed_at: row.signed_at,
        decision_note: row.decision_note,
      },
    });
  } catch {
    /* notification failure must never fail the decision */
  }
}
