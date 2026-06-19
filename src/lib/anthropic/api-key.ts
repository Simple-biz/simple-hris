import 'server-only';

import { getAppSetting } from '@/lib/supabase/app-settings';

/**
 * app_settings key for the admin-managed Anthropic API key.
 *
 * The name contains "secret" ON PURPOSE: the generic `/api/app-settings` GET
 * treats any key containing "secret"/"token" as sensitive and refuses to return
 * it to non-elevated callers (see `isSensitiveKey` in
 * `app/api/app-settings/route.ts`). The stored value is the raw key string
 * (not JSON-wrapped).
 */
export const ANTHROPIC_API_KEY_SETTING = 'secret.anthropic_api_key';

export type AnthropicKeySource = 'db' | 'env' | null;

/**
 * Resolve the Anthropic API key. The admin-configured DB value takes precedence
 * over the `ANTHROPIC_API_KEY` environment variable, so the key can be set or
 * rotated from the Admin → API tokens page without a redeploy. Falls back to the
 * env var (and finally null) when no DB override is present.
 */
export async function resolveAnthropicApiKey(): Promise<{ key: string | null; source: AnthropicKeySource }> {
  try {
    const dbVal = (await getAppSetting(ANTHROPIC_API_KEY_SETTING))?.trim();
    if (dbVal) return { key: dbVal, source: 'db' };
  } catch {
    // DB unreachable — fall back to the env var below.
  }
  const envVal = process.env.ANTHROPIC_API_KEY?.trim();
  if (envVal) return { key: envVal, source: 'env' };
  return { key: null, source: null };
}

/**
 * Mask a key for display — keeps the recognizable `sk-ant-` prefix and the last
 * 4 characters, hiding everything in between. Used so the full secret is never
 * sent to the client.
 */
export function maskAnthropicKey(key: string): string {
  const k = key.trim();
  if (k.length <= 11) return '••••••••';
  const prefix = k.startsWith('sk-ant-') ? 'sk-ant-' : k.slice(0, 4);
  return `${prefix}…${'•'.repeat(6)}${k.slice(-4)}`;
}
