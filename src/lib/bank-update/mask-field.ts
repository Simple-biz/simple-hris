/**
 * Masking for the People-tab "Bank changes" before→after view.
 *
 * The bank-changes feed records a masked snapshot of what changed on each
 * self-service payout edit. We mask at WRITE time (in the save route, before the
 * value ever lands in `audit_log`) so full account numbers are never persisted
 * into the audit trail — only the masked form reviewers actually see. Descriptive
 * fields (bank name, account holder, address, processor) are shown verbatim;
 * credentials (account/routing/phone numbers, payout emails) are partially hidden.
 */

/** Numeric-ish credentials — keep the last 4, hide the rest behind a capped dot run. */
const NUMERIC_TAIL_FIELDS = new Set([
  'account_number',
  'alt_account_number',
  'routing_number',
  'alt_routing_number',
  'phone_number',
]);

/** Payout emails — keep the first char + domain, hide the rest of the local part. */
const EMAIL_FIELDS = new Set([
  'wise_email',
  'hurupay_email',
  'wepay_email',
  'higlobe_email',
]);

const BULLET = '•'; // •

function maskTail(v: string, visible = 4): string {
  if (v.length <= visible) {
    // Too short to keep 4 — reveal only the final char.
    return BULLET.repeat(Math.max(0, v.length - 1)) + v.slice(-1);
  }
  // Cap the dot run so a long IBAN doesn't render as a wall of bullets.
  const hidden = Math.min(v.length - visible, 8);
  return BULLET.repeat(hidden) + v.slice(-visible);
}

function maskEmail(v: string): string {
  const at = v.indexOf('@');
  if (at <= 0) return maskTail(v); // not email-shaped — treat as a tail secret
  const local = v.slice(0, at);
  const domain = v.slice(at); // includes '@'
  const hidden = Math.min(Math.max(local.length - 1, 1), 6);
  return `${local.slice(0, 1)}${BULLET.repeat(hidden)}${domain}`;
}

/**
 * Mask a single payout field's value for the bank-changes feed. Returns null for
 * empty/absent values. Descriptive fields pass through unchanged; credentials are
 * partially hidden per the sets above.
 */
export function maskFieldValue(field: string, value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = String(value).trim();
  if (v === '') return null;
  if (NUMERIC_TAIL_FIELDS.has(field)) return maskTail(v);
  if (EMAIL_FIELDS.has(field)) return maskEmail(v);
  return v;
}
