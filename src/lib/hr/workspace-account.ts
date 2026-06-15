import { resolveWebhookUrl } from "@/lib/webhooks/resolve-webhook";

/**
 * Fires the n8n combined onboarding webhook when HR assigns a work email to a
 * new hire. The webhook handles everything in one shot:
 *   1. Provisions the @simple.biz Google Workspace account
 *   2. Invites the hire to Hubstaff (project_names required)
 *   3. Sends the Roboform (password manager) instructional email
 *   4. Sends the Hubstaff Overview instructional email
 *
 * This fires at work-email-set time (NOT at promote time). Promote is now
 * master-list-only and fires no automation.
 *
 * URL resolution order:
 *   1. Admin -> Webhooks entry with slug `create_workspace_account` (active).
 *   2. N8N_CREATE_WORKSPACE_WEBHOOK_URL env var.
 *   3. The hardcoded production default below.
 */

export const CREATE_WORKSPACE_WEBHOOK_SLUG = "create_workspace_account";
export const VERIFY_WORKSPACE_WEBHOOK_SLUG = "verify_workspace_account";

const DEFAULT_WEBHOOK_URL =
  "https://auto.simple.biz/webhook/create-workspace-account";
const DEFAULT_VERIFY_WEBHOOK_URL =
  "https://auto.simple.biz/webhook/verify-workspace-account";

const ORGANIZATION_ID = 724122;
const DEFAULT_ROLE = "project_user";

function resolveCreateWorkspaceUrl(): Promise<string> {
  return resolveWebhookUrl(CREATE_WORKSPACE_WEBHOOK_SLUG, {
    envVars: ["N8N_CREATE_WORKSPACE_WEBHOOK_URL"],
    defaultUrl: DEFAULT_WEBHOOK_URL,
  }).then((url) => url ?? DEFAULT_WEBHOOK_URL);
}

function resolveVerifyWorkspaceUrl(): Promise<string | null> {
  // Conventional default mirrors the create webhook path, so verification works
  // out of the box once the read-only n8n workflow (slug
  // `verify_workspace_account`) is published there; override via Admin ->
  // Webhooks or the env var if it lives elsewhere. If the workflow doesn't
  // exist yet, n8n returns 404 and the caller surfaces a clear "couldn't
  // verify" message rather than flipping any status.
  return resolveWebhookUrl(VERIFY_WORKSPACE_WEBHOOK_SLUG, {
    envVars: ["N8N_VERIFY_WORKSPACE_WEBHOOK_URL"],
    defaultUrl: DEFAULT_VERIFY_WEBHOOK_URL,
  });
}

export type CreateWorkspaceAccountInput = {
  firstName: string;
  lastName: string;
  workEmail: string;
  personalEmail: string;
  /** Hubstaff project names the hire will be assigned to. */
  projectNames?: string[];
  /** Regular pay rate (from the Payment Catalog). Hubstaff requires >= 0.01, so
   *  it's floored to a placeholder when unset; the real rate lives in payroll. */
  payRate?: number | null;
  /** OT pay rate (from the Payment Catalog). Passed through to the webhook for
   *  Hubstaff/payroll; null when Accounting hasn't set one. */
  otRate?: number | null;
  /** Hubstaff role. Defaults to "project_user". */
  role?: string;
  /** Whether the hire is trackable in Hubstaff. Defaults to true. */
  trackable?: boolean;
};

export type CreateWorkspaceAccountResult = {
  ok: boolean;
  status?: number;
  error?: string;
};

/**
 * POSTs the combined onboarding payload to the n8n webhook. Never throws —
 * the caller treats account creation as best-effort so a webhook outage
 * does not block staging the hire. Returns whether the call succeeded so
 * HR can be warned and retry manually.
 */
export async function createWorkspaceAccount(
  input: CreateWorkspaceAccountInput,
): Promise<CreateWorkspaceAccountResult> {
  const workEmail = input.workEmail.trim().toLowerCase();
  if (!workEmail) {
    return { ok: false, error: "Missing work email." };
  }

  const projectNames = (input.projectNames ?? [])
    .map((p) => String(p).trim())
    .filter(Boolean);

  // Hubstaff's invite API REJECTS a pay rate of 0 ("Pay rate must be greater
  // than or equal to 0.01"). Since compensation is now owned by Accounting and
  // can be unset at staging time (rate null -> 0), floor the Hubstaff pay_rate
  // to this minimum placeholder so the invite still succeeds. It's only the
  // Hubstaff-side rate; real pay comes from the Payment Catalog / payroll, and
  // the pending hire's stored rate stays null until Accounting sets it.
  const HUBSTAFF_MIN_PAY_RATE = 0.01;
  const rawRate =
    typeof input.payRate === "number" && Number.isFinite(input.payRate) && input.payRate > 0
      ? input.payRate
      : HUBSTAFF_MIN_PAY_RATE;
  // OT rate is informational for the workflow/payroll — pass the real catalog
  // value (or null). Hubstaff's invite only validates pay_rate, not OT.
  const otRate =
    typeof input.otRate === "number" && Number.isFinite(input.otRate) && input.otRate >= 0
      ? input.otRate
      : null;

  // n8n's bulk-capable Workspace provisioning workflow reads snake_case
  // identity fields (first_name / last_name / work_email / personal_email).
  // The internal TS input stays camelCase; only the wire payload is snake_case.
  // pay_rate = the regular rate (floored for Hubstaff); regular_rate + ot_rate
  // carry the actual Payment Catalog figures set by Accounting.
  const payload: Record<string, unknown> = {
    first_name: input.firstName.trim(),
    last_name: input.lastName.trim(),
    work_email: workEmail,
    personal_email: input.personalEmail.trim().toLowerCase(),
    organization_id: ORGANIZATION_ID,
    project_names: projectNames,
    role: input.role ?? DEFAULT_ROLE,
    pay_rate: rawRate,
    regular_rate: rawRate,
    ot_rate: otRate,
    trackable: input.trackable ?? true,
  };

  let url: string;
  try {
    url = await resolveCreateWorkspaceUrl();
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Could not resolve webhook URL.",
    };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // Always read + inspect the body. n8n's "Respond to Webhook" node routinely
    // returns HTTP 200 even when the workflow logically FAILED (e.g. the Google
    // Workspace create step errored), with a body like:
    //   [{ "ok": false, "status": "create_error",
    //      "error": "Operation \"create\" failed for resource \"user\"." }]
    // So a 2xx alone does NOT mean the account was provisioned — treating a
    // 200-with-error as success is the exact false-confirmed bug we guard
    // against. We mark the call failed when EITHER the HTTP status is non-2xx
    // OR the body reports a failure, and surface the body's error message.
    const text = await res.text().catch(() => "");
    const body = inspectWorkspaceWebhookBody(text);

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: body.message ?? `Webhook returned ${res.status}`,
      };
    }
    if (body.failed) {
      return {
        ok: false,
        status: res.status,
        error: body.message ?? "Workspace automation reported a failure.",
      };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Network error calling webhook.",
    };
  }
}

/**
 * Inspects the webhook's response body for a logical failure signal. n8n can
 * return HTTP 200 while reporting a failed run in the body, so the HTTP status
 * is not enough. The body is usually an ARRAY of result items (one per hire);
 * any item that signals failure marks the whole call failed.
 *
 * Failure signals (any): `ok === false`, `success === false`, a non-empty
 * `error` string, or a `status` string matching /error|fail/i (e.g.
 * "create_error"). Returns the first failure's message when present, else any
 * non-trivial message found (used to dress up non-2xx responses too).
 *
 * Conservative by design: an empty/non-JSON body or a clean success item is
 * NOT treated as a failure, so genuine 200s still confirm.
 */
function inspectWorkspaceWebhookBody(text: string): {
  failed: boolean;
  message: string | null;
} {
  const raw = text.trim();
  if (!raw) return { failed: false, message: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON (e.g. a plain "OK") — no failure signal we can read.
    return { failed: false, message: null };
  }

  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

  let failed = false;
  let failMessage: string | null = null;
  let anyMessage: string | null = null;

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    const errStr =
      typeof obj.error === "string" && obj.error.trim() ? obj.error.trim() : null;
    const msgStr =
      typeof obj.message === "string" && obj.message.trim()
        ? obj.message.trim()
        : null;
    // `reason` is what the workflow's "Save Pending License Request" node sets,
    // e.g. "No Business Starter or Enterprise Standard licenses are currently
    // available." — surface it so HR sees the real (license) limitation.
    const reasonStr =
      typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : null;
    const statusStr =
      typeof obj.status === "string" && obj.status.trim()
        ? obj.status.trim()
        : null;

    // Best human-readable string for this item: prefer error, then message,
    // then reason, then a status that isn't a plain "ok".
    const best =
      errStr ??
      msgStr ??
      reasonStr ??
      (statusStr && statusStr.toLowerCase() !== "ok" ? statusStr : null);
    if (anyMessage == null && best) anyMessage = best;

    const itemFailed =
      obj.ok === false ||
      obj.success === false ||
      errStr != null ||
      (statusStr != null && /error|fail/i.test(statusStr));

    if (itemFailed) {
      failed = true;
      if (failMessage == null) failMessage = best;
    }
  }

  return { failed, message: failMessage ?? anyMessage };
}

export type VerifyWorkspaceAccountResult = {
  /**
   * 'exists'  = the Google Workspace account was found (confirmed/designated).
   * 'missing' = the lookup ran but no account exists (needs provisioning).
   * 'error'   = could not determine (webhook down / not built / ambiguous);
   *             the caller must NOT change the stored status in this case.
   */
  state: "exists" | "missing" | "error";
  httpStatus?: number;
  error?: string;
};

/**
 * Read-only check of whether a hire's @simple.biz Google Workspace account
 * actually exists, via the n8n `verify_workspace_account` webhook. This NEVER
 * creates anything — it's the safe way to resolve an "Unverified" row without
 * risking a duplicate account.
 *
 * Expected webhook contract (POST body: `{ work_email }`):
 *   - HTTP 200 `{ "exists": true }`  -> account found
 *   - HTTP 200 `{ "exists": false }` -> account not found
 *   (also accepts `found`/`ok`/`active` booleans, a `status` string like
 *    "found"/"not_found", a returned `primaryEmail`/`id`/`user`, or a bare
 *    `true`/`false`). Anything unreadable, a non-2xx, or an `error` we can't
 *    classify -> 'error' (status left untouched).
 *
 * Never throws — returns a structured result so HR can be told what happened.
 */
export async function verifyWorkspaceAccount(
  workEmailRaw: string,
): Promise<VerifyWorkspaceAccountResult> {
  const workEmail = workEmailRaw.trim().toLowerCase();
  if (!workEmail) return { state: "error", error: "Missing work email." };

  let url: string | null;
  try {
    url = await resolveVerifyWorkspaceUrl();
  } catch (e) {
    return {
      state: "error",
      error:
        e instanceof Error ? e.message : "Could not resolve verify webhook URL.",
    };
  }
  if (!url) {
    return {
      state: "error",
      error:
        "Verify webhook is not configured (slug verify_workspace_account).",
    };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ work_email: workEmail }),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const body = inspectWorkspaceWebhookBody(text);
      return {
        state: "error",
        httpStatus: res.status,
        error: body.message ?? `Verify webhook returned ${res.status}`,
      };
    }
    return interpretVerifyBody(text, res.status);
  } catch (e) {
    return {
      state: "error",
      error:
        e instanceof Error ? e.message : "Network error calling verify webhook.",
    };
  }
}

/** Maps a 2xx verify response body to exists/missing/error. Conservative: only
 *  a clear signal flips state; anything ambiguous stays 'error' so we never
 *  clobber a known status on a fuzzy response. */
function interpretVerifyBody(
  text: string,
  httpStatus: number,
): VerifyWorkspaceAccountResult {
  const raw = text.trim();
  if (!raw) {
    return {
      state: "error",
      httpStatus,
      error: "Verify webhook returned an empty response.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Non-JSON 200 — accept a bare true/false/exists/not_found word.
    const low = raw.toLowerCase();
    if (/\b(true|exists|found|active)\b/.test(low))
      return { state: "exists", httpStatus };
    if (/\b(false|not[_ ]?found|missing|absent)\b/.test(low))
      return { state: "missing", httpStatus };
    return { state: "error", httpStatus, error: "Could not read verify response." };
  }

  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

  for (const item of items) {
    if (item === true) return { state: "exists", httpStatus };
    if (item === false) return { state: "missing", httpStatus };
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    if (obj.exists === true || obj.found === true || obj.active === true)
      return { state: "exists", httpStatus };
    if (obj.exists === false || obj.found === false)
      return { state: "missing", httpStatus };

    const statusStr =
      typeof obj.status === "string" ? obj.status.trim().toLowerCase() : null;
    if (statusStr) {
      if (/not[_ ]?found|missing|no[_ ]?user|absent/.test(statusStr))
        return { state: "missing", httpStatus };
      if (/\b(ok|found|exists|active|success)\b/.test(statusStr))
        return { state: "exists", httpStatus };
    }

    // A returned identity strongly implies the account exists.
    if (
      typeof obj.primaryEmail === "string" ||
      typeof obj.id === "string" ||
      (obj.user != null && typeof obj.user === "object")
    ) {
      return { state: "exists", httpStatus };
    }

    const errStr =
      typeof obj.error === "string" && obj.error.trim() ? obj.error.trim() : null;
    if (errStr) {
      if (/not[_ ]?found|no[_ ]?user|does not exist|doesn't exist/i.test(errStr))
        return { state: "missing", httpStatus };
      return { state: "error", httpStatus, error: errStr };
    }

    if (obj.ok === true) return { state: "exists", httpStatus };
    if (obj.ok === false) return { state: "missing", httpStatus };
  }

  return {
    state: "error",
    httpStatus,
    error: "Verify response did not indicate whether the account exists.",
  };
}
