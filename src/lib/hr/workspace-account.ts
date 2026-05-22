import { request as httpsRequest } from "https";
import { getAppSetting } from "@/lib/supabase/app-settings";

/**
 * Fires the n8n "create workspace account" webhook when HR stages a new hire
 * from an onboarding submission. The webhook provisions the hire's workspace
 * account from their name + emails.
 *
 * Quirk: the deployed n8n webhook node is configured as a **GET** request but
 * reads its input from the JSON **body** (verified against the live endpoint:
 * POST -> 404 "not registered for POST"; GET with a JSON body -> 200). The
 * fetch() API forbids a body on GET, so we issue the request via Node's https
 * module instead.
 *
 * URL resolution order:
 *   1. Admin -> Webhooks entry with slug `create_workspace_account` (active).
 *   2. N8N_CREATE_WORKSPACE_WEBHOOK_URL env var.
 *   3. The hardcoded production default below.
 */

export const CREATE_WORKSPACE_WEBHOOK_SLUG = "create_workspace_account";

const DEFAULT_WEBHOOK_URL =
  "https://simpledotbiz.app.n8n.cloud/webhook/create-workspace-account";

interface WebhookEntry {
  slug: string;
  url: string;
  active: boolean;
}

async function resolveWebhookUrl(): Promise<string> {
  try {
    const raw = await getAppSetting("webhooks.config");
    if (raw) {
      const list = JSON.parse(raw) as WebhookEntry[];
      const match = list.find(
        (e) => e.slug === CREATE_WORKSPACE_WEBHOOK_SLUG && e.active && e.url,
      );
      if (match?.url) return match.url;
    }
  } catch {
    // fall through to env / default
  }
  return process.env.N8N_CREATE_WORKSPACE_WEBHOOK_URL || DEFAULT_WEBHOOK_URL;
}

export type CreateWorkspaceAccountInput = {
  firstName: string;
  lastName: string;
  workEmail: string;
  personalEmail: string;
};

export type CreateWorkspaceAccountResult = {
  ok: boolean;
  status?: number;
  error?: string;
};

/** GET request carrying a JSON body, via Node https (fetch can't do this). */
function getWithBody(
  url: string,
  body: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`Invalid webhook URL: ${url}`));
      return;
    }
    const req = httpsRequest(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Sends the workspace-account payload to the n8n webhook. Never throws — the
 * caller treats account creation as best-effort so a webhook outage doesn't
 * block staging the hire. Returns whether the call succeeded so HR can be
 * warned and retry manually.
 */
export async function createWorkspaceAccount(
  input: CreateWorkspaceAccountInput,
): Promise<CreateWorkspaceAccountResult> {
  const workEmail = input.workEmail.trim().toLowerCase();
  if (!workEmail) {
    return { ok: false, error: "Missing work email." };
  }

  const payload = JSON.stringify({
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    workEmail,
    personalEmail: input.personalEmail.trim().toLowerCase(),
  });

  let url: string;
  try {
    url = await resolveWebhookUrl();
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Could not resolve webhook URL.",
    };
  }

  try {
    const { status, text } = await getWithBody(url, payload);
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        status,
        error: `Webhook returned ${status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }
    return { ok: true, status };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Network error calling webhook.",
    };
  }
}
