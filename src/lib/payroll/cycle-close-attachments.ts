import 'server-only';

/**
 * The close-out reports as email attachments (2026-09-04).
 *
 * When a pay cycle is closed, the `payment_cycle_complete` email carries the
 * FINAL close-out in three formats — CSV, XLSX, PDF — built from the FILED
 * record plus the cycle's live paid rows (paged; a single cycle has passed
 * 1,000 rows). Same builders the Stop dialog's browser download uses, so the
 * emailed file and the downloaded file cannot disagree.
 *
 * NEVER throws. A report can cost the report, never the celebration: on any
 * failure the caller gets `attachments: []` and a human `error` to put in the
 * payload (`attachments_error`), and the email still goes out.
 *
 * Size: n8n cloud accepts request bodies up to 16 MB. Base64 costs 4/3, and the
 * rest of the payload is small, so the RAW total is capped at 8 MB. Over the cap
 * the paid-detail section is dropped first (record-only files are a few KB) and
 * the error says so; if even that does not fit — it cannot, but the guard is
 * cheap — nothing is attached.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';
import type { CycleCloseoutRecord } from './cycle-closeout';
import {
  buildFinalCloseoutCsv,
  buildFinalCloseoutWorkbook,
  finalCloseReportFilename,
  projectPaidDetailRows,
  workbookToBytes,
  type FinalCloseReportModel,
  type PaidDetailRow,
} from './cycle-close-report-export';
import { buildFinalCloseoutPdf } from './cycle-close-report-pdf';

export interface CycleCloseAttachment {
  filename: string;
  content_type: string;
  /** Raw size, before base64. */
  bytes: number;
  content_base64: string;
}

export interface CycleCloseAttachmentsResult {
  attachments: CycleCloseAttachment[];
  /** Human sentence when anything was degraded or dropped; null when all three shipped in full. */
  error: string | null;
  /** How many live paid rows were available (0 when the read failed or the section was dropped). */
  livePaidRowCount: number;
}

export const MAX_ATTACHMENTS_RAW_BYTES = 8 * 1024 * 1024;

const CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
} as const;

/** Every dispatch row of the cycle, paged. `null` on read failure (never an
 *  empty array — an empty array means "nothing paid", which is a different fact). */
async function loadPaidDetailRows(
  supabase: SupabaseClient,
  sourceFile: string,
): Promise<PaidDetailRow[] | null> {
  const { rows, error } = await selectAllPaged<PaymentDispatchRow>((from, to) =>
    supabase
      .from('payment_dispatches')
      .select('*')
      .eq('cycle_source_file', sourceFile)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to),
  );
  if (error) return null;
  return projectPaidDetailRows(rows);
}

/** The three files for a model the caller already assembled — no DB read. The
 *  Admin test run uses this with a fictional record. */
export async function buildCycleCloseAttachmentsFromModel(model: FinalCloseReportModel): Promise<CycleCloseAttachment[]> {
  return buildThree(model);
}

async function buildThree(model: FinalCloseReportModel): Promise<CycleCloseAttachment[]> {
  const now = model.generatedAt;
  const label = model.record.label;
  const csv = Buffer.from(buildFinalCloseoutCsv(model), 'utf8');
  const xlsx = Buffer.from(workbookToBytes(buildFinalCloseoutWorkbook(model)));
  const pdf = Buffer.from(await buildFinalCloseoutPdf(model));
  return [
    { filename: finalCloseReportFilename(label, now, 'csv'), content_type: CONTENT_TYPES.csv, bytes: csv.length, content_base64: csv.toString('base64') },
    { filename: finalCloseReportFilename(label, now, 'xlsx'), content_type: CONTENT_TYPES.xlsx, bytes: xlsx.length, content_base64: xlsx.toString('base64') },
    { filename: finalCloseReportFilename(label, now, 'pdf'), content_type: CONTENT_TYPES.pdf, bytes: pdf.length, content_base64: pdf.toString('base64') },
  ];
}

const rawTotal = (list: CycleCloseAttachment[]) => list.reduce((s, a) => s + a.bytes, 0);

/**
 * Build the three attachments for a filed record. Pure apart from the paged
 * dispatch read; the record itself is never re-derived.
 */
export async function buildCycleCloseAttachments(
  supabase: SupabaseClient | null,
  record: CycleCloseoutRecord,
  now: Date = new Date(),
): Promise<CycleCloseAttachmentsResult> {
  try {
    let livePaidRows: PaidDetailRow[] | null = null;
    let note: string | null = null;
    if (supabase) {
      livePaidRows = await loadPaidDetailRows(supabase, record.source_file);
      if (livePaidRows === null) note = 'Live paid-detail rows could not be read; the files carry the frozen record only.';
    } else {
      note = 'Database unavailable while building the files; they carry the frozen record only.';
    }

    let attachments = await buildThree({ kind: 'final', record, livePaidRows, generatedAt: now });
    let livePaidRowCount = livePaidRows?.length ?? 0;

    if (rawTotal(attachments) > MAX_ATTACHMENTS_RAW_BYTES && livePaidRows && livePaidRows.length > 0) {
      attachments = await buildThree({ kind: 'final', record, livePaidRows: null, generatedAt: now });
      livePaidRowCount = 0;
      note = `The paid-detail section (${livePaidRows.length} rows) was omitted from the attached files to stay under the size limit; the frozen record is complete.`;
    }
    if (rawTotal(attachments) > MAX_ATTACHMENTS_RAW_BYTES) {
      return {
        attachments: [],
        error: 'The close-out files exceeded the attachment size limit even without paid detail; nothing was attached. Download them from Payment Dispatch instead.',
        livePaidRowCount: 0,
      };
    }
    return { attachments, error: note, livePaidRowCount };
  } catch (e) {
    return {
      attachments: [],
      error: `Could not build the close-out files: ${e instanceof Error ? e.message : String(e)}. Download them from Payment Dispatch instead.`,
      livePaidRowCount: 0,
    };
  }
}

/** Attachment metadata without the base64 body — for audit rows and previews. */
export function describeAttachments(list: readonly CycleCloseAttachment[]): Array<{ filename: string; content_type: string; bytes: number }> {
  return list.map(({ filename, content_type, bytes }) => ({ filename, content_type, bytes }));
}
