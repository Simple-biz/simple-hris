/**
 * MESA disbursement receipts — shape and limits shared by the browser and the
 * server. Kept free of server-only imports so the upload dialog can validate a
 * file BEFORE spending a round trip on it, against the exact same rules the API
 * re-checks on arrival. (Server logic lives in ./receipts.ts.)
 */

/** Private bucket. Read exclusively through short-lived signed URLs. */
export const MESA_RECEIPTS_BUCKET = 'mesa-receipts';

/** Receipts per disbursement request. Also the DB's (request_id, slot) cap. */
export const MAX_MESA_RECEIPTS = 3;

/** Per file. Matches time-adjustment evidence and S-Wall media, and keeps a
 *  single upload request body inside the serverless body limit. */
export const MAX_MESA_RECEIPT_BYTES = 5 * 1024 * 1024;

/**
 * Accepted types. Photos of a paper receipt and PDF invoices are what members
 * actually have; anything else (a .docx "receipt", a spreadsheet) isn't evidence
 * Accounting can rely on. HEIC is here because iPhone photos default to it.
 */
export const MESA_RECEIPT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
] as const;

export type MesaReceiptMime = (typeof MESA_RECEIPT_MIME_TYPES)[number];

/** `accept` for the file input. Extensions are included because some browsers
 *  report an empty type for HEIC, which would otherwise be un-pickable. */
export const MESA_RECEIPT_ACCEPT =
  'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.pdf';

export interface MesaReceiptRow {
  id: string;
  request_id: string;
  work_email: string;
  /** 1–3. Stable display order; the unique (request_id, slot) is the cap. */
  slot: number;
  file_path: string;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
}

/** A receipt as the client sees it: the row plus a short-lived signed URL. */
export interface MesaReceiptWithUrl extends MesaReceiptRow {
  url: string | null;
}

/** Extension → mime, for the browsers that hand us an empty `File.type`. */
const EXT_TO_MIME: Record<string, MesaReceiptMime> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
};

/**
 * Best-effort type for a picked file. `File.type` is empty for HEIC on some
 * browsers and occasionally wrong, so the extension is the fallback. The server
 * does not trust either — it sniffs the bytes (see ./receipts.ts) — this exists
 * to give the member an instant, accurate "that file won't work" instead of a
 * failed upload.
 */
export function mesaReceiptMimeOf(file: { type?: string; name?: string }): string {
  const declared = (file.type ?? '').toLowerCase().trim();
  if (declared && (MESA_RECEIPT_MIME_TYPES as readonly string[]).includes(declared)) return declared;
  const ext = (file.name ?? '').split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_MIME[ext] ?? declared;
}

export function isAllowedMesaReceiptType(mime: string | null | undefined): boolean {
  return (MESA_RECEIPT_MIME_TYPES as readonly string[]).includes((mime ?? '').toLowerCase().trim());
}

export function isMesaReceiptImage(mime: string | null | undefined): boolean {
  const m = (mime ?? '').toLowerCase();
  return m.startsWith('image/');
}

/** Canonical file extension for a stored object. */
export function mesaReceiptExt(mime: string, fileName?: string | null): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/heic':
      return 'heic';
    case 'image/heif':
      return 'heif';
    case 'application/pdf':
      return 'pdf';
    default: {
      const ext = (fileName ?? '').split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '');
      return ext || 'bin';
    }
  }
}

/** "1.4 MB" — compact, one decimal below 10 units, for the file list. */
export function formatReceiptSize(bytes: number | null | undefined): string {
  const n = bytes ?? 0;
  if (n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
