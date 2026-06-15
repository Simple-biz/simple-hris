import { getServiceAccountAccessToken } from '@/lib/google-sheets/auth';

/**
 * Live "assigned licenses" count from the Google Enterprise License Manager API.
 *
 * Google does NOT expose total purchased seats via a public API for direct
 * customers (only resellers, via the Cloud Channel API). So we fetch the number
 * of *assigned* licenses here and let the admin enter the *total* manually;
 * available = total - assigned is computed by the caller.
 *
 * Requires domain-wide delegation: the service account's client ID must be
 * authorized for the `apps.licensing` scope in the Admin Console, and we
 * impersonate a Workspace admin (GOOGLE_WORKSPACE_ADMIN_EMAIL).
 *
 * https://developers.google.com/admin-sdk/licensing/reference/rest
 */

const LICENSING_SCOPE = 'https://www.googleapis.com/auth/apps.licensing';

// "Google-Apps" is the product that covers all Google Workspace SKUs
// (Business Starter/Standard/Plus, Enterprise, etc). Listing for the product
// returns assignments across every Workspace SKU in one paginated call.
const WORKSPACE_PRODUCT_ID = 'Google-Apps';

export interface AssignedLicensesResult {
  assigned: number;
  productId: string;
  customerId: string;
}

interface LicenseAssignmentListResponse {
  items?: Array<{ userId?: string; skuId?: string }>;
  nextPageToken?: string;
  error?: { message?: string };
}

/**
 * Returns the env config for the Licensing API, or a reason string if it is not
 * configured yet (so the caller can fall back to the manual count silently).
 */
function readConfig():
  | { ok: true; adminEmail: string; customerId: string; productId: string }
  | { ok: false; reason: string } {
  const adminEmail = process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL?.trim();
  if (!adminEmail) {
    return {
      ok: false,
      reason:
        'GOOGLE_WORKSPACE_ADMIN_EMAIL not set — license auto-count disabled (using manual numbers).',
    };
  }
  // The Licensing API accepts the primary domain as customerId. Default to the
  // admin email's domain; allow an explicit override for multi-domain orgs.
  const explicit = process.env.GOOGLE_WORKSPACE_CUSTOMER_ID?.trim();
  const customerId = explicit || adminEmail.split('@')[1] || '';
  if (!customerId) {
    return { ok: false, reason: 'Could not derive a customer domain from the admin email.' };
  }
  const productId = process.env.GOOGLE_WORKSPACE_PRODUCT_ID?.trim() || WORKSPACE_PRODUCT_ID;
  return { ok: true, adminEmail, customerId, productId };
}

/** True when the Licensing API env config is present. */
export function isLicenseAutoCountConfigured(): boolean {
  return readConfig().ok;
}

/**
 * Counts assigned Workspace licenses by paging through licenseAssignments.
 * Throws on a real API failure; the caller decides whether to fall back.
 */
export async function fetchAssignedLicenseCount(): Promise<AssignedLicensesResult> {
  const cfg = readConfig();
  if (!cfg.ok) {
    throw new Error(cfg.reason);
  }

  const token = await getServiceAccountAccessToken(LICENSING_SCOPE, cfg.adminEmail);

  let assigned = 0;
  let pageToken: string | undefined;
  // Bound the loop so a malformed nextPageToken can never spin forever.
  for (let page = 0; page < 200; page++) {
    const url = new URL(
      `https://licensing.googleapis.com/apps/licensing/v1/product/${encodeURIComponent(
        cfg.productId,
      )}/users`,
    );
    url.searchParams.set('customerId', cfg.customerId);
    url.searchParams.set('maxResults', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    const json = (await res.json()) as LicenseAssignmentListResponse;
    if (!res.ok) {
      throw new Error(
        `Licensing API failed (${res.status}): ${json.error?.message ?? res.statusText}`,
      );
    }
    assigned += json.items?.length ?? 0;
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }

  return { assigned, productId: cfg.productId, customerId: cfg.customerId };
}
