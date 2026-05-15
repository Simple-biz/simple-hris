import { getAppSetting, upsertAppSetting } from '@/lib/supabase/app-settings';

const KEY = 'auth.force_logout_map';

/** Cached in-memory copy of the force-logout map. Refreshed every 30s, or
 *  immediately when something on this server calls `bumpForceLogoutFor`. */
let cache: { ts: number; map: Record<string, string> } | null = null;
const TTL_MS = 30_000;

async function loadMap(): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.map;
  const raw = await getAppSetting(KEY);
  let map: Record<string, string> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') map = parsed as Record<string, string>;
    } catch {
      map = {};
    }
  }
  cache = { ts: Date.now(), map };
  return map;
}

/**
 * Returns the Unix-seconds timestamp at which all sessions for `email` should
 * be considered invalid. JWTs whose `iat` is before this number must be
 * treated as logged out. Returns `null` when no force-logout is recorded.
 */
export async function getForceLogoutEpochFor(email: string): Promise<number | null> {
  const norm = email.trim().toLowerCase();
  if (!norm) return null;
  const map = await loadMap();
  const iso = map[norm];
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Records "every session for this email issued before NOW is invalid". The
 * next time the user's JWT callback runs, it will be neutered. Bumping
 * invalidates only existing sessions — fresh sign-ins (which get a new `iat`)
 * are unaffected.
 */
export async function bumpForceLogoutFor(email: string): Promise<{ error: string | null }> {
  const norm = email.trim().toLowerCase();
  if (!norm) return { error: 'email required' };
  const map = await loadMap();
  map[norm] = new Date().toISOString();
  // Keep the JSON compact — drop anything older than 30 days to bound size.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [k, v] of Object.entries(map)) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms < cutoff) delete map[k];
  }
  const { error } = await upsertAppSetting(KEY, JSON.stringify(map));
  if (error) return { error };
  // Refresh in-memory cache so the change takes effect immediately for
  // requests handled by this server process.
  cache = { ts: Date.now(), map };
  return { error: null };
}
