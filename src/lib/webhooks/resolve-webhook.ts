import { getAppSetting } from "@/lib/supabase/app-settings";
import {
  parseWebhookConfig,
  type WebhookConfigEntry,
  type WebhookRecipientOverride,
} from "@/lib/webhooks/webhook-config";

/**
 * Single source of truth for resolving an outbound webhook URL by slug.
 *
 * The Admin -> Webhooks tab stores a JSON array under the `webhooks.config`
 * app_settings key. Each entry has a stable `slug`, a `url`, and an `active`
 * flag. Code looks up its endpoint by slug so URLs can be rotated from the UI
 * without a redeploy.
 *
 * Resolution order (first match wins):
 *   1. Active `webhooks.config` entry whose slug matches.
 *   2. Legacy bare-URL app_settings key (pre-slug system), if provided.
 *   3. Environment variables, in the order given.
 *   4. Hardcoded production default, if provided.
 *
 * Returns `null` when nothing is configured.
 */
const WEBHOOKS_CONFIG_KEY = "webhooks.config";

export interface ResolveWebhookOptions {
  /** Legacy app_settings key holding a bare URL string (pre-slug system). */
  legacyKey?: string;
  /** Env var names to check, in order, after the config + legacy key. */
  envVars?: string[];
  /** Hardcoded production default, used last. */
  defaultUrl?: string;
}

/** The active `webhooks.config` entry for a slug, or null. Malformed config
 *  reads as "no entry" so the other sources still get their turn. */
async function readActiveEntry(slug: string): Promise<WebhookConfigEntry | null> {
  try {
    const raw = await getAppSetting(WEBHOOKS_CONFIG_KEY);
    const list = parseWebhookConfig(raw);
    return list.find((e) => e.slug === slug && e.active && e.url.trim()) ?? null;
  } catch {
    return null;
  }
}

export async function resolveWebhookUrl(
  slug: string,
  options: ResolveWebhookOptions = {},
): Promise<string | null> {
  // 1. Admin -> Webhooks config (active entry for this slug).
  const entry = await readActiveEntry(slug);
  if (entry?.url) return entry.url.trim();

  // 2. Legacy bare-URL key.
  if (options.legacyKey) {
    try {
      const legacy = (await getAppSetting(options.legacyKey))?.trim();
      if (legacy) return legacy;
    } catch {
      // ignore
    }
  }

  // 3. Environment variables.
  for (const name of options.envVars ?? []) {
    const val = process.env[name]?.trim();
    if (val) return val;
  }

  // 4. Hardcoded default.
  return options.defaultUrl?.trim() || null;
}

/**
 * URL plus the automation overrides an admin saved on the entry (2026-09-04).
 *
 * Same URL precedence as `resolveWebhookUrl`. The overrides come ONLY from the
 * active `webhooks.config` entry — an env-var or legacy-key URL has nowhere to
 * hang them, so both are null there. Callers that only need the URL keep using
 * `resolveWebhookUrl`; nothing about them changed.
 */
export interface WebhookDelivery {
  url: string;
  /** 'config' when the URL came from Admin → Webhooks; otherwise no overrides apply. */
  source: "config" | "legacy" | "env" | "default";
  recipients: WebhookRecipientOverride | null;
  payloadOverrides: Record<string, unknown> | null;
}

export async function resolveWebhookDelivery(
  slug: string,
  options: ResolveWebhookOptions = {},
): Promise<WebhookDelivery | null> {
  const entry = await readActiveEntry(slug);
  if (entry?.url) {
    return {
      url: entry.url.trim(),
      source: "config",
      recipients: entry.recipients,
      payloadOverrides: entry.payload_overrides,
    };
  }
  if (options.legacyKey) {
    try {
      const legacy = (await getAppSetting(options.legacyKey))?.trim();
      if (legacy) return { url: legacy, source: "legacy", recipients: null, payloadOverrides: null };
    } catch {
      // ignore
    }
  }
  for (const name of options.envVars ?? []) {
    const val = process.env[name]?.trim();
    if (val) return { url: val, source: "env", recipients: null, payloadOverrides: null };
  }
  const def = options.defaultUrl?.trim();
  return def ? { url: def, source: "default", recipients: null, payloadOverrides: null } : null;
}
