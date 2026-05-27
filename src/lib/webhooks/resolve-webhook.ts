import { getAppSetting } from "@/lib/supabase/app-settings";

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

interface WebhookEntry {
  slug: string;
  url: string;
  active: boolean;
}

export interface ResolveWebhookOptions {
  /** Legacy app_settings key holding a bare URL string (pre-slug system). */
  legacyKey?: string;
  /** Env var names to check, in order, after the config + legacy key. */
  envVars?: string[];
  /** Hardcoded production default, used last. */
  defaultUrl?: string;
}

export async function resolveWebhookUrl(
  slug: string,
  options: ResolveWebhookOptions = {},
): Promise<string | null> {
  // 1. Admin -> Webhooks config (active entry for this slug).
  try {
    const raw = await getAppSetting(WEBHOOKS_CONFIG_KEY);
    if (raw) {
      const list = JSON.parse(raw) as WebhookEntry[];
      if (Array.isArray(list)) {
        const match = list.find((e) => e.slug === slug && e.active && e.url);
        if (match?.url) return match.url.trim();
      }
    }
  } catch {
    // Malformed config -> fall through to the other sources.
  }

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
