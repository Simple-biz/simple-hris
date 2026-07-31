/**
 * Document Requests — shared types for the Employee "Request Documents" flow
 * and the Accounting "Documents" tab.
 *
 * Flow: an employee submits a PDF (their Pay Stubs export, a COE, an award)
 * from Profile → Request Documents. The request queues in Accounting →
 * Documents; approving stamps the Accounting Head's saved signature into the
 * PDF (appended certification page with the requested + signed dates and the
 * request id) and the signed copy is returned to the employee. Pure types +
 * labels only — safe on both server and client.
 */

export type DocumentRequestType = 'paystub' | 'coe' | 'award' | 'other';

export const DOCUMENT_REQUEST_TYPES: readonly DocumentRequestType[] = [
  'paystub',
  'coe',
  'award',
  'other',
];

/** "Engagement", not "Employment": the certificate's own body states the worker
 *  is a contractor rather than an employee, so the title has to match. The
 *  stored `coe` value is unchanged — existing rows keep working. */
export const DOCUMENT_TYPE_LABELS: Record<DocumentRequestType, string> = {
  paystub: 'Pay Stubs',
  coe: 'Certificate of Engagement (COE)',
  award: 'Award / Certificate',
  other: 'Other document',
};

/** Types the HRIS generates itself — the employee attaches nothing. */
export const SYSTEM_GENERATED_TYPES: readonly DocumentRequestType[] = ['coe'];

export function isSystemGeneratedType(type: string | null | undefined): boolean {
  return !!type && (SYSTEM_GENERATED_TYPES as readonly string[]).includes(type);
}

/** Shape of GET /api/employee/documents/coe-preview → { facts }. Mirrors
 *  CoeFacts in src/lib/documents/coe-facts.ts (server-only, hence the copy). */
export interface CoePreviewFacts {
  workerName: string;
  employeeEmail: string;
  employeeId: string | null;
  startDateLabel: string;
  startDateRaw: string;
  team: string;
  weeklyHours: number;
  hourlyRate: string;
  overtimeRate: string;
  currency: 'PHP' | 'USD' | 'COP';
  rateSource: 'individual' | 'sheet' | 'department';
  standardBonuses: { label: string; amount: string | null; qualifier?: string }[];
  performanceBonuses: { label: string; amount: string | null }[];
}

export function isDocumentRequestType(v: string): v is DocumentRequestType {
  return (DOCUMENT_REQUEST_TYPES as readonly string[]).includes(v);
}

export function documentTypeLabel(type: string | null | undefined): string {
  if (!type) return 'Document';
  return DOCUMENT_TYPE_LABELS[type as DocumentRequestType] ?? 'Document';
}

export type DocumentRequestStatus = 'pending' | 'signed' | 'rejected';

export const DOCUMENT_STATUS_LABELS: Record<DocumentRequestStatus, string> = {
  pending: 'Pending review',
  signed: 'Signed',
  rejected: 'Rejected',
};

/** Row shape of public.document_requests (snake_case, as the APIs return it). */
export interface DocumentRequestRow {
  id: string;
  employee_email: string;
  employee_name: string | null;
  document_type: DocumentRequestType;
  period_label: string | null;
  note: string | null;
  file_path: string;
  file_name: string | null;
  file_size: number | null;
  status: DocumentRequestStatus;
  signed_file_path: string | null;
  signed_at: string | null;
  signed_by: string | null;
  signed_by_name: string | null;
  signed_by_title: string | null;
  decision_note: string | null;
  requested_at: string;
  updated_at: string;
}

/** Row shape of public.document_signatures (the caller's own row only). */
export interface DocumentSignatureRow {
  owner_email: string;
  owner_name: string | null;
  title: string | null;
  image_data_url: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** Uploaded originals + stamped copies both live in this private bucket. */
export const DOCUMENT_REQUESTS_BUCKET = 'document-requests';

/** Max upload size — mirrored by the bucket's file_size_limit. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** App-level cap on the stored signature PNG data URL (DB check is 400k). */
export const MAX_SIGNATURE_DATA_URL_CHARS = 300_000;

/** "Mar 4, 2026" from an ISO timestamp; '—' when absent. */
export function formatDocumentDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Human file size ("1.4 MB"). */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
