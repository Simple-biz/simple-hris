import { getAppSetting } from "@/lib/supabase/app-settings";

/**
 * Fires the n8n "hubstaff invite user" webhook when HR promotes a hire to the
 * master list, inviting the new hire to the Hubstaff workspace.
 *
 * Verified against the live endpoint: it's a **POST** that validates a JSON
 * body requiring email/Username + organizationId + project_names. Payload shape
 * (confirmed by the team):
 *   { username, email, organizationId, projectNames, role, pay_rate, trackable }
 *
 * URL resolution order:
 *   1. Admin -> Webhooks entry with slug `hubstaff_invite_user` (active).
 *   2. N8N_HUBSTAFF_INVITE_WEBHOOK_URL env var.
 *   3. The hardcoded production default below.
 */

export const HUBSTAFF_INVITE_WEBHOOK_SLUG = "hubstaff_invite_user";

const DEFAULT_WEBHOOK_URL =
  "https://simpledotbiz.app.n8n.cloud/webhook/hubstaff-invite-user";

// Constants per the agreed payload contract.
const ORGANIZATION_ID = 724122;
const ROLE = "project_user";
const TRACKABLE = true;

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
        (e) => e.slug === HUBSTAFF_INVITE_WEBHOOK_SLUG && e.active && e.url,
      );
      if (match?.url) return match.url;
    }
  } catch {
    // fall through to env / default
  }
  return process.env.N8N_HUBSTAFF_INVITE_WEBHOOK_URL || DEFAULT_WEBHOOK_URL;
}

export type HubstaffInviteInput = {
  /** Full @simple.biz work email; the local part becomes the username. */
  workEmail: string;
  projectNames: string[];
  payRate?: number | null;
};

export type HubstaffInviteResult = {
  ok: boolean;
  status?: number;
  error?: string;
};

/**
 * POSTs the hubstaff-invite payload to the n8n webhook. Never throws — the
 * caller treats the invite as best-effort so a webhook outage doesn't block the
 * promotion. Returns whether the call succeeded so the result can be surfaced.
 */
export async function inviteHubstaffUser(
  input: HubstaffInviteInput,
): Promise<HubstaffInviteResult> {
  const email = input.workEmail.trim().toLowerCase();
  const username = email.split("@")[0];
  if (!email || !username) {
    return { ok: false, error: "Missing work email." };
  }

  const projectNames = (input.projectNames ?? [])
    .map((p) => String(p).trim())
    .filter(Boolean);
  if (projectNames.length === 0) {
    return {
      ok: false,
      error: "No Hubstaff project(s) on file for this hire — the invite needs at least one.",
    };
  }

  const payload: Record<string, unknown> = {
    username,
    email,
    organizationId: ORGANIZATION_ID,
    projectNames,
    role: ROLE,
    trackable: TRACKABLE,
  };
  if (typeof input.payRate === "number" && Number.isFinite(input.payRate)) {
    payload.pay_rate = input.payRate;
  }

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
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        error: `Webhook returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
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
