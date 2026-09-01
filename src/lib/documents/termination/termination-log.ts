/** [TERMINATION-DOCS]
 * `termination_documents` — the permanent log, its storage object, its audit row.
 *
 * G8 (zero leak to the employee surface) is proved HERE, by a literal: `TABLE`
 * is a module const string and every read/write names it as `TABLE`. There is
 * no table-name parameter and no variable-named table in this module, so no
 * option a future caller passes can point this code at `document_requests` —
 * the table `GET /api/employee/documents` serves (src/lib/documents/requests.ts:32,
 * itself a module-const literal). Separate tables, both named by literals, is
 * the proof rather than the policy.
 *
 * Storage reuses the EXISTING private bucket `document-requests` under the
 * distinct `termination/` prefix, so no new bucket and no new storage policy
 * migration exists — and the revert is a prefix delete that cannot reach a
 * `document_requests` object.
 *
 * Reads page. This table gains a row per generated letter and will cross
 * PostgREST's 1000-row cap, which truncates even an explicit `.range()`.
 */
import 'server-only';

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { resolveUserRole } from '@/lib/supabase/pab-day-disputes';
import { normEmail } from '@/lib/email/norm-email';
import { DOCUMENT_REQUESTS_BUCKET, MAX_DOCUMENT_BYTES } from '@/lib/documents/types';
import { escapeLikePattern } from './reason-key';
import { isRealCalendarDay } from './termination-arbitration';
import {
  isTerminationDepartureReason,
  type TerminationBlankField,
  type TerminationDocumentRow,
  type TerminationFacts,
  type TerminationWritebackRecord,
} from './types';

/** G8: a module const LITERAL. Never a parameter, never interpolated. */
const TABLE = 'termination_documents';

/** Storage folder prefix inside DOCUMENT_REQUESTS_BUCKET. The teardown deletes
 *  this prefix; anything outside it belongs to `document_requests`. */
export const TERMINATION_STORAGE_PREFIX = 'termination';

/** Signed-URL lifetime, matching the Documents precedent (requests.ts:523). */
const SIGNED_URL_TTL_SECONDS = 3600;

/** Rows per log response, and the ceiling a caller may ask for. */
const LOG_PAGE_DEFAULT = 100;
const LOG_PAGE_MAX = 500;

/** `YYYY-MM-DD`. A letter states a calendar day; the DB columns are `date`.
 *
 *  SHAPE ONLY — `2026-02-31`, `2026-04-31` and `2026-13-05` all satisfy it. Every
 *  use is therefore paired with `isRealCalendarDay`, because an impossible day
 *  otherwise ROLLS instead of failing: `formatCoeStartDate('2026-02-31')` prints
 *  "March 2, 2026" on the signed page, and the `date` column answers with an
 *  opaque `date/time field value out of range` AFTER the storage object has
 *  already been uploaded. Both are the errors this gate exists to name. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A PostgREST `timestamptz` as it comes back, used as the keyset cursor. */
const TIMESTAMPTZ =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}:?\d{2}|Z)?$/;

/** Only a well-formed uuid can name a row; anything else is NOT FOUND, never a
 *  500. Keeps id-probing indistinguishable from a miss (the employee-documents
 *  precedent returns 404 for an unknown id). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Storage folder that owns one person's termination objects. Duplicate of the
 *  private helper at requests.ts:35 — lowercase FIRST, then strip, or an
 *  uppercase local-part survives as `_`s and two people share a folder. */
function emailPathSegment(email: string): string {
  return (email || 'unknown').toLowerCase().replace(/[^a-z0-9._-]/g, '_');
}

/** Content check so a renderer that silently produced non-PDF bytes cannot be
 *  logged as a document. Duplicate of the private helper at requests.ts:40. */
function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.slice(0, 5));
  return head === '%PDF-';
}

/** Download filename. The signed URL carries it as the Content-Disposition
 *  name, so it is what lands in the rep's Downloads folder. */
function documentFileName(workerName: string, terminationDate: string): string {
  const slug = workerName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `termination-letter-${slug || 'employee'}-${terminationDate}.pdf`;
}

/**
 * The DDL's six CHECK constraints, restated in code so a violation is a named
 * error the rep can act on instead of an opaque 23514 arriving AFTER the
 * storage object was uploaded. Returns null when the facts are loggable.
 *
 * This is the last gate on facts the rep filled in: the route merges their
 * answers into `facts` before calling, so a blank left blank arrives here.
 */
function describeUnloggableFacts(facts: TerminationFacts): string | null {
  if (!facts.workerName?.trim()) return 'Missing worker name';

  if (!facts.terminationDate || !DATE_ONLY.test(facts.terminationDate)) {
    return 'Termination date is required, as YYYY-MM-DD';
  }
  if (!isRealCalendarDay(facts.terminationDate)) {
    return `Termination date ${facts.terminationDate} is not a real calendar day`;
  }
  if (!isTerminationDepartureReason(facts.reasonKey)) {
    // G2 in code, ahead of the same allowlist as a CHECK. A suspension can
    // never become a termination letter.
    return `Not a documentable departure reason: ${String(facts.reasonKey)}`;
  }
  if (!facts.reasonLabel?.trim()) return 'Missing reason label';

  const deptLabel = facts.endingDepartmentLabel?.trim();
  if (!deptLabel) return 'Ending department is required';
  if (deptLabel.startsWith('hsl:')) {
    // A raw sub-dept slug must never reach a human-readable column.
    return `Ending department was not formatted for display: ${deptLabel}`;
  }

  if (facts.startDate !== null) {
    if (!DATE_ONLY.test(facts.startDate)) return 'Start date must be YYYY-MM-DD';
    if (!isRealCalendarDay(facts.startDate)) {
      return `Start date ${facts.startDate} is not a real calendar day`;
    }
    // G4 as data: string compare is correct for zero-padded ISO days.
    if (facts.terminationDate <= facts.startDate) {
      return `Termination date ${facts.terminationDate} is not after the start date ${facts.startDate}`;
    }
  }

  for (const [which, rate] of [
    ['Starting', facts.startingRate],
    ['Ending', facts.endingRate],
  ] as const) {
    if (rate.amount === null) continue;
    if (!Number.isFinite(rate.amount) || rate.amount <= 0) {
      // "A zero rate is not a rate" — a blank is honest, a printed 0 is false.
      return `${which} rate must be greater than zero`;
    }
    if (!rate.currency) {
      // Money with no unit is not a fact. The DDL says the same thing
      // (`termination_documents_currency_present_with_rate`); saying it here is
      // what turns a 23514 arriving AFTER the upload into a named refusal.
      return `${which} rate has no currency — a figure with no denomination cannot be printed or stored`;
    }
  }

  return null;
}

/**
 * Upload the rendered PDF, insert the log row, write the audit row.
 *
 * Order is load-bearing, and it is the OPPOSITE way round from what it looks:
 * this row is inserted BEFORE the write-back runs, because the row id is what
 * the write-back's undo trail is attached to. So `params.writebacks` is the
 * row's INITIAL value and is always `[]` in practice; the trail is appended
 * incrementally by the caller as each master cell lands (route.ts's
 * `persistWritebackTrail` sink), and the write-back gets its own audit entry
 * from `auditTerminationWriteback` once it has actually run.
 *
 * `field_writebacks` on this row is the ONLY undo data for the blank-only
 * write-back — `audit_log` cannot hold it, because `clearAuditLog()` truncates
 * the whole table behind DELETE /api/audit-log.
 */
export async function createTerminationDocument(params: {
  facts: TerminationFacts;
  filled: TerminationBlankField[];
  bytes: Uint8Array;
  generatedBy: string;
  generatedByName: string | null;
  generatedByTitle: string | null;
  generatedAtIso: string;
  documentId: string;
  writebacks: TerminationWritebackRecord[];
}): Promise<{ row: TerminationDocumentRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const { facts } = params;
  const workEmail = normEmail(facts.identity.workEmail);
  if (!workEmail) return { row: null, error: 'Missing work email' };

  const id = params.documentId?.trim();
  if (!id || !UUID.test(id)) return { row: null, error: 'Missing or malformed document id' };

  const generatedBy = normEmail(params.generatedBy);
  if (!generatedBy) return { row: null, error: 'Missing generating rep' };

  const unloggable = describeUnloggableFacts(facts);
  if (unloggable) return { row: null, error: unloggable };

  if (params.bytes.byteLength === 0) return { row: null, error: 'Empty document' };
  if (params.bytes.byteLength > MAX_DOCUMENT_BYTES) {
    return { row: null, error: 'Rendered document exceeds the 10 MB storage limit' };
  }
  if (!looksLikePdf(params.bytes)) return { row: null, error: 'Rendered bytes are not a PDF' };

  // describeUnloggableFacts already refused each of these; re-reading them into
  // locals is what NARROWS them for the NOT NULL columns below, since the guard
  // ran in another function.
  const { terminationDate, reasonKey, reasonLabel, endingDepartmentLabel } = facts;
  if (!terminationDate || !reasonKey || !reasonLabel || !endingDepartmentLabel) {
    return { row: null, error: 'Missing a required printed fact' };
  }

  const filePath = `${TERMINATION_STORAGE_PREFIX}/${emailPathSegment(workEmail)}/${id}/termination.pdf`;
  const fileName = documentFileName(facts.workerName, terminationDate);

  // `upsert: false` — a regeneration mints a new id and a new path, so no
  // signed document is ever overwritten in place.
  const uploaded = await supabase.storage
    .from(DOCUMENT_REQUESTS_BUCKET)
    .upload(filePath, params.bytes, { contentType: 'application/pdf', upsert: false });
  if (uploaded.error) return { row: null, error: uploaded.error.message };

  // Currency and source are stored verbatim even when `amount` is null: they
  // record which carrier was consulted, and the DDL permits it.
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      id,
      work_email: workEmail,
      personal_email: facts.identity.personalEmail,
      master_row_id: facts.identity.masterRowId,
      worker_name: facts.workerName.trim(),
      termination_date: terminationDate,
      reason_key: reasonKey,
      reason_label: reasonLabel,
      ending_department_raw: facts.endingDepartmentRaw,
      ending_department_label: endingDepartmentLabel,
      start_date: facts.startDate,
      starting_rate: facts.startingRate.amount,
      starting_rate_currency: facts.startingRate.currency,
      starting_rate_source: facts.startingRate.source,
      ending_rate: facts.endingRate.amount,
      ending_rate_currency: facts.endingRate.currency,
      ending_rate_source: facts.endingRate.source,
      facts,
      filled_by_rep: params.filled,
      field_writebacks: params.writebacks,
      generated_by: generatedBy,
      generated_by_name: params.generatedByName?.trim() || null,
      generated_by_title: params.generatedByTitle?.trim() || null,
      generated_at: params.generatedAtIso,
      file_path: filePath,
      file_name: fileName,
      file_size: params.bytes.byteLength,
    })
    .select('*')
    .single();
  if (error) {
    // Don't strand the uploaded object if the row insert failed.
    await supabase.storage.from(DOCUMENT_REQUESTS_BUCKET).remove([filePath]).catch(() => {});
    return { row: null, error: error.message };
  }

  const row = data as TerminationDocumentRow;

  // DEPARTURE from the Documents precedent, deliberate: the sibling audit
  // writes are fire-and-forget `void (async () => …)()` with `{error}`
  // discarded. Here the audit insert is AWAITED and its error surfaced — a
  // signed legal document with no audit row is not a thing this feature ships.
  // This entry records the GENERATION; the write-back that may follow it is
  // audited separately by `auditTerminationWriteback`, because it has not
  // happened yet when this row is written.
  const role = await resolveUserRole(generatedBy, 'Accounting');
  const audit = await insertAuditLog({
    user_name: generatedBy,
    user_role: role,
    action: 'documents.termination_generated',
    resource: TABLE,
    resource_id: row.id,
    details: {
      work_email: workEmail,
      master_row_id: facts.identity.masterRowId,
      termination_date: terminationDate,
      reason_key: reasonKey,
      raw_reason: facts.rawReason,
      filled_by_rep: params.filled,
      field_writebacks: params.writebacks,
      // Say so explicitly rather than letting a future auditor read the empty
      // array above as "nothing was written back": the write-back runs AFTER
      // this row exists and carries its own audit action.
      field_writebacks_note:
        'the write-back runs after this row is inserted — see action documents.termination_writeback',
      file_path: filePath,
    },
  });
  if (audit.error) {
    // The row and its object STAY. `field_writebacks` on this row is the only
    // undo data for the write-back that already landed — deleting the row to
    // "clean up" would destroy it. The generation still FAILS: a non-null
    // error here always means the caller must not report success.
    return {
      row: null,
      error: `Audit write failed (${audit.error}); document ${row.id} is logged and its file stored, but the generation was not confirmed`,
    };
  }

  return { row, error: null };
}

/**
 * Audit the blank-only write-back, AFTER it ran and carrying its records.
 *
 * A distinct action (`documents.termination_writeback`) rather than a patch of
 * the generation entry, so the two facts stay separately timestamped: a letter
 * was signed, and then N pre-existing `global_master_list` cells were changed.
 * The generation entry cannot carry these records — it is inserted before the
 * write-back, so its own `field_writebacks` is always `[]`.
 *
 * This is the SECOND copy of the undo data, not a replacement for
 * `termination_documents.field_writebacks`: `clearAuditLog()` truncates the
 * whole audit table behind DELETE /api/audit-log, which is exactly why
 * `bank_update_history` was split out. It exists so that a lost trail patch, or
 * a dropped table, still leaves a record of which cells were touched and what
 * they held before.
 *
 * AWAITED by the caller and its error surfaced. An unaudited irreversible write
 * is not acceptable; the document itself is already saved by then, so a failure
 * here is reported to the rep rather than costing them the letter.
 */
export async function auditTerminationWriteback(params: {
  documentId: string;
  workEmail: string;
  masterRowId: string | null;
  actorEmail: string;
  /** Cells actually written. */
  applied: TerminationWritebackRecord[];
  /** The subset `field_writebacks` on the document row is known to hold. */
  persistedTrail: TerminationWritebackRecord[];
  skipped: Array<{ column: string; rowId: string; reason: string }>;
  writebackError: string | null;
  trailError: string | null;
}): Promise<{ error: string | null }> {
  const actor = normEmail(params.actorEmail);
  if (!actor) return { error: 'Missing actor email' };
  if (!params.documentId?.trim() || !UUID.test(params.documentId.trim())) {
    return { error: 'Missing or malformed document id' };
  }
  if (params.applied.length === 0) return { error: null };

  const role = await resolveUserRole(actor, 'Accounting');
  const audit = await insertAuditLog({
    user_name: actor,
    user_role: role,
    action: 'documents.termination_writeback',
    resource: TABLE,
    resource_id: params.documentId.trim(),
    details: {
      work_email: normEmail(params.workEmail),
      master_row_id: params.masterRowId,
      table: 'global_master_list',
      // The undo data itself. `before: null` and `before: ''` are different
      // prior states and must survive the jsonb trip distinguishable.
      field_writebacks: params.applied,
      field_writebacks_persisted: params.persistedTrail,
      // A record here but not in `field_writebacks_persisted` is a cell that was
      // WRITTEN while its undo record failed to reach the document row — the one
      // state that has to be reverted by hand.
      trail_not_persisted: params.applied.filter(
        (r) => !params.persistedTrail.some((p) => p.column === r.column && p.rowId === r.rowId),
      ),
      skipped: params.skipped,
      writeback_error: params.writebackError,
      trail_error: params.trailError,
    },
  });
  return { error: audit.error };
}

/**
 * The permanent log, newest first.
 *
 * `query` matches work email, personal email or worker name — one paged
 * `.ilike` per column, unioned. Never `.or()`: PostgREST parses an `.or()`
 * argument as `column.op.value` and the dots in an email mis-split the filter
 * into a bogus "column does not exist".
 *
 * Every pass drains through `selectAllPaged` rather than resting on a
 * `.limit()`, because PostgREST truncates at 1000 rows even with an explicit
 * `.range()` — a bare `.limit(200)` here would silently hide the tail once the
 * log grows. The display cap is applied AFTER ordering, so `truncated` reports
 * the real remainder instead of guessing at it.
 */
export async function listTerminationDocuments(opts?: {
  query?: string;
  before?: string;
  limit?: number;
}): Promise<{ rows: TerminationDocumentRow[]; truncated: boolean; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], truncated: false, error: 'Supabase not configured' };

  const asked = Math.trunc(Number(opts?.limit ?? LOG_PAGE_DEFAULT));
  const cap = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), LOG_PAGE_MAX) : LOG_PAGE_DEFAULT;

  // A malformed cursor is refused, not ignored: silently dropping it would hand
  // the caller page one again and page two would never arrive.
  const before = opts?.before?.trim() || null;
  if (before && !TIMESTAMPTZ.test(before)) {
    return { rows: [], truncated: false, error: 'Invalid cursor' };
  }

  const q = normEmail(opts?.query ?? '');
  const pattern = q ? `%${escapeLikePattern(q)}%` : null;
  // `_` is an ILIKE single-char wildcard and is legal in an email local-part,
  // so an unescaped pattern matches a DIFFERENT person.
  const columns: (string | null)[] = pattern
    ? ['work_email', 'personal_email', 'worker_name']
    : [null];

  const byId = new Map<string, TerminationDocumentRow>();
  let firstError: string | null = null;

  for (const column of columns) {
    const { rows, error } = await selectAllPaged<TerminationDocumentRow>((from, to) => {
      let page = supabase.from(TABLE).select('*');
      if (column && pattern) page = page.ilike(column, pattern);
      // Keyset cursor. Ties on the boundary microsecond would be skipped;
      // `generated_at` is `now()` at microsecond precision, so a tie needs two
      // documents generated in the same microsecond.
      if (before) page = page.lt('generated_at', before);
      return page
        .order('generated_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to);
    });
    // selectAllPaged returns PARTIAL rows plus the message; keep both — a
    // degraded read must never look like a short log.
    if (error && !firstError) firstError = error;
    for (const row of rows) byId.set(row.id, row);
  }

  const merged = [...byId.values()].sort((a, b) => {
    if (a.generated_at !== b.generated_at) return a.generated_at < b.generated_at ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });

  return {
    rows: merged.slice(0, cap),
    truncated: merged.length > cap,
    error: firstError,
  };
}

/** One log row. An unknown or malformed id is NOT FOUND (`row: null`, no
 *  error), so the download route answers 404 rather than leaking existence. */
export async function getTerminationDocumentById(
  id: string,
): Promise<{ row: TerminationDocumentRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const wanted = id?.trim();
  if (!wanted || !UUID.test(wanted)) return { row: null, error: null };

  const { data, error } = await supabase.from(TABLE).select('*').eq('id', wanted).maybeSingle();
  return { row: (data as TerminationDocumentRow) ?? null, error: error?.message ?? null };
}

/** Short-lived download URL for a stored document. The bucket is private;
 *  `download` sets the filename the rep sees. */
export async function signedUrlForTerminationDocument(
  row: TerminationDocumentRow,
): Promise<{ url: string | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { url: null, error: 'Supabase not configured' };

  const path = row?.file_path;
  if (!path) return { url: null, error: 'No file' };

  const { data, error } = await supabase.storage
    .from(DOCUMENT_REQUESTS_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS, {
      download: row.file_name || 'termination-letter.pdf',
    });
  if (error || !data?.signedUrl) return { url: null, error: error?.message ?? 'Could not sign URL' };
  return { url: data.signedUrl, error: null };
}
