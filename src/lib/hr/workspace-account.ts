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

const DEFAULT_WEBHOOK_URL =
  "https://auto.simple.biz/webhook/create-workspace-account";

const ORGANIZATION_ID = 724122;
const DEFAULT_ROLE = "project_user";

function resolveCreateWorkspaceUrl(): Promise<string> {
  return resolveWebhookUrl(CREATE_WORKSPACE_WEBHOOK_SLUG, {
    envVars: ["N8N_CREATE_WORKSPACE_WEBHOOK_URL"],
    defaultUrl: DEFAULT_WEBHOOK_URL,
  }).then((url) => url ?? DEFAULT_WEBHOOK_URL);
}

export type CreateWorkspaceAccountInput = {
  firstName: string;
  lastName: string;
  workEmail: string;
  personalEmail: string;
  /** Hubstaff project names the hire will be assigned to. */
  projectNames?: string[];
  /** Hubstaff pay rate. Defaults to 0 (prevents the "USD" display bug). */
  payRate?: number | null;
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

  const payload: Record<string, unknown> = {
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    workEmail,
    personalEmail: input.personalEmail.trim().toLowerCase(),
    organization_id: ORGANIZATION_ID,
    project_names: projectNames,
    role: input.role ?? DEFAULT_ROLE,
    pay_rate:
      typeof input.payRate === "number" && Number.isFinite(input.payRate)
        ? input.payRate
        : 0,
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
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Try to extract a human-readable message from the webhook's JSON response
      // rather than dumping raw JSON into the toast.
      let friendlyError = `Webhook returned ${res.status}`;
      try {
        const json = JSON.parse(text) as Record<string, unknown>;
        // Common shapes: { message }, { error }, { errors: [{...}] }, n8n status objects
        const msg =
          (typeof json.message === "string" && json.message) ||
          (typeof json.error === "string" && json.error) ||
          (typeof json.status === "string" && json.status !== "ok" && json.status) ||
          null;
        if (msg) friendlyError = msg;
      } catch {
        // Not JSON — keep the status code message.
      }
      return { ok: false, status: res.status, error: friendlyError };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Network error calling webhook.",
    };
  }
}
