/**
 * Server-only Hubstaff REST API v2 client for the Payroll Wizard "Sync from Hubstaff"
 * action. Never import from client components — it reads HUBSTAFF_PAT and persists
 * rotating tokens via the service-role Supabase client.
 *
 * Auth model (per developer.hubstaff.com): the Personal Access Token created at
 * https://developer.hubstaff.com/personal_access_tokens is NOT a bearer token — it is
 * a long-lived (90-day) OAuth refresh token. It must be exchanged at the token
 * endpoint for a short-lived (~24h) access token, and Hubstaff ROTATES the refresh
 * token on every exchange. The newest refresh token is persisted in app_settings so
 * the rotation chain survives restarts/redeploys; the HUBSTAFF_PAT env var only seeds
 * the chain (changing it starts a fresh chain). The token endpoint is rate-limited to
 * ~5 requests/hour, so the access token is cached and reused until near expiry.
 */
import { getAppSetting, upsertAppSetting } from "@/lib/supabase/app-settings";

const TOKEN_ENDPOINT = "https://account.hubstaff.com/access_tokens";
const API_BASE = "https://api.hubstaff.com";
/** app_settings key holding the rotating token chain (JSON `StoredHubstaffToken`). */
const TOKEN_SETTING_KEY = "hubstaff.api.token";
/** Refresh the access token this many seconds before its reported expiry. */
const EXPIRY_SAFETY_SECONDS = 300;

/** Retry budget for transient Hubstaff responses (429 rate limit / 5xx). */
const MAX_RETRIES = 4;
/** Never hold a single request open longer than this waiting out a throttle;
 *  a longer `Retry-After` is surfaced as a 429 so the operator can retry later. */
const MAX_RETRY_WAIT_MS = 10_000;
/** Small gap between paginated activity calls so a wide range doesn't burst. */
const PAGE_GAP_MS = 150;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `fetch()` that transparently rides out transient Hubstaff throttling: on a 429
 * (or 5xx) it waits — honoring the server's `Retry-After` header (seconds) when
 * present, else exponential backoff — and retries, up to {@link MAX_RETRIES}.
 * Bounded on both attempts and per-wait duration: if the throttle window is longer
 * than {@link MAX_RETRY_WAIT_MS} it returns the 429 unmodified so the caller can map
 * it to a retryable response instead of holding the request open indefinitely.
 */
async function fetchHubstaff(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt >= MAX_RETRIES) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(MAX_RETRY_WAIT_MS, 500 * 2 ** attempt);
    if (waitMs > MAX_RETRY_WAIT_MS) return res;
    await res.text().catch(() => {}); // release the socket before waiting
    await sleep(waitMs);
  }
}

export type HubstaffUser = {
  id: number;
  name: string | null;
  email: string | null;
};

/** One user's aggregated tracking for one organization-timezone calendar day. */
export type HubstaffDailyActivity = {
  id: number;
  /** ISO date (YYYY-MM-DD), already bucketed by the ORGANIZATION's timezone. */
  date: string;
  user_id: number;
  /** Total tracked seconds. */
  tracked: number;
  /** Seconds of overall activity (keyboard+mouse) — used for the Activity % column. */
  overall?: number;
};

type StoredHubstaffToken = {
  /** The env PAT this rotation chain was seeded from; a changed env PAT restarts the chain. */
  seed_pat: string;
  refresh_token: string;
  access_token: string | null;
  /** Epoch ms after which access_token must not be reused (safety margin applied). */
  access_expires_at: number | null;
};

export function getHubstaffOrgId(): string | null {
  return process.env.HUBSTAFF_ORG_ID?.trim() || null;
}

export function hubstaffApiConfigured(): boolean {
  return Boolean(process.env.HUBSTAFF_PAT?.trim() && getHubstaffOrgId());
}

async function exchangeRefreshToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string | null;
  expires_in: number | null;
}> {
  const res = await fetchHubstaff(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // `status`/`upstream` let callers map Hubstaff's HTTP status to a meaningful
    // response (e.g. 429 rate limit) instead of a blanket 500.
    throw Object.assign(new Error(`Hubstaff token endpoint returned ${res.status}: ${body.slice(0, 300)}`), {
      status: res.status,
      upstream: true,
    });
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("Hubstaff token endpoint responded without an access_token.");
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? null,
    expires_in: typeof json.expires_in === "number" ? json.expires_in : null,
  };
}

async function readStoredToken(seedPat: string): Promise<StoredHubstaffToken | null> {
  try {
    const raw = await getAppSetting(TOKEN_SETTING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredHubstaffToken;
    if (!parsed || typeof parsed.refresh_token !== "string") return null;
    // A different HUBSTAFF_PAT means the operator rotated the PAT — drop the old chain.
    if (parsed.seed_pat !== seedPat) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Returns a valid access token, exchanging/rotating the refresh token only when the
 * cached one is expired. Tries the persisted rotation chain first, then falls back to
 * the raw HUBSTAFF_PAT (fresh PAT, or first run before anything was persisted).
 */
export async function getHubstaffAccessToken(): Promise<string> {
  const pat = process.env.HUBSTAFF_PAT?.trim();
  if (!pat) {
    throw new Error("HUBSTAFF_PAT is not configured. Add it to .env / deployment settings.");
  }

  const stored = await readStoredToken(pat);
  if (
    stored?.access_token &&
    stored.access_expires_at &&
    Date.now() < stored.access_expires_at
  ) {
    return stored.access_token;
  }

  const candidates = [...new Set([stored?.refresh_token, pat].filter((t): t is string => !!t))];
  let lastErr: unknown = null;
  for (const refreshToken of candidates) {
    try {
      const tok = await exchangeRefreshToken(refreshToken);
      const next: StoredHubstaffToken = {
        seed_pat: pat,
        refresh_token: tok.refresh_token ?? refreshToken,
        access_token: tok.access_token,
        access_expires_at:
          Date.now() + Math.max(60, (tok.expires_in ?? 86400) - EXPIRY_SAFETY_SECONDS) * 1000,
      };
      const { error } = await upsertAppSetting(TOKEN_SETTING_KEY, JSON.stringify(next));
      if (error) {
        // Losing the rotated refresh token risks stranding the chain; surface loudly.
        console.warn("[hubstaff-api] could not persist rotated token:", error);
      }
      return tok.access_token;
    } catch (e) {
      lastErr = e;
    }
  }

  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  const status = (lastErr as { status?: number } | null)?.status;
  const err = new Error(
    `Could not obtain a Hubstaff access token (${detail}). If the Personal Access Token expired ` +
      `(90 days) or was revoked, create a new one at https://developer.hubstaff.com/personal_access_tokens ` +
      `and update HUBSTAFF_PAT.`,
  );
  // Preserve an upstream status (e.g. a 429 on the ~5/hour token endpoint) so the
  // route answers retryable/502 rather than a blanket 500.
  throw status ? Object.assign(err, { status, upstream: true }) : err;
}

function describeApiError(status: number): string {
  switch (status) {
    case 401:
      return "Hubstaff rejected the access token (401). Re-check HUBSTAFF_PAT.";
    case 403:
      return "Hubstaff denied access (403). The PAT may be missing read scopes, or the org plan lacks API access.";
    case 404:
      return "Hubstaff organization not found (404). Re-check HUBSTAFF_ORG_ID.";
    case 429:
      return "Hubstaff API rate limit hit (429). Wait a minute and try again.";
    default:
      return `Hubstaff API request failed (${status}).`;
  }
}

/**
 * Fetches org-timezone daily activity aggregates for an inclusive date range, with the
 * `users` sideload so names/emails come back in the same calls. Follows
 * `pagination.next_page_start_id` until exhausted. Range limit per Hubstaff: 31 days.
 */
export async function fetchDailyActivities(
  orgId: string,
  dateStartIso: string,
  dateStopIso: string,
): Promise<{ activities: HubstaffDailyActivity[]; users: HubstaffUser[] }> {
  const accessToken = await getHubstaffAccessToken();

  const activities: HubstaffDailyActivity[] = [];
  const usersById = new Map<number, HubstaffUser>();
  let pageStartId = 0;

  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({
      "date[start]": dateStartIso,
      "date[stop]": dateStopIso,
      page_limit: "500",
      include: "users",
    });
    if (pageStartId) params.set("page_start_id", String(pageStartId));

    const res = await fetchHubstaff(
      `${API_BASE}/v2/organizations/${encodeURIComponent(orgId)}/activities/daily?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Carry the upstream status so the API route can answer 429/502 (not 500).
      throw Object.assign(new Error(`${describeApiError(res.status)} ${body.slice(0, 300)}`.trim()), {
        status: res.status,
        upstream: true,
      });
    }

    const json = (await res.json()) as {
      daily_activities?: HubstaffDailyActivity[];
      users?: HubstaffUser[];
      pagination?: { next_page_start_id?: number | null };
    };

    for (const a of json.daily_activities ?? []) activities.push(a);
    for (const u of json.users ?? []) if (u && typeof u.id === "number") usersById.set(u.id, u);

    const next = json.pagination?.next_page_start_id;
    if (!next) break;
    pageStartId = next;
    await sleep(PAGE_GAP_MS);
  }

  return { activities, users: [...usersById.values()] };
}

/**
 * Short-TTL cache in front of {@link fetchDailyActivities} for the employee-facing
 * live "My Hours" overlay. The whole org's range is fetched once and every
 * employee's request within the TTL is served from the same promise — so N employees
 * polling costs 1–2 Hubstaff calls per TTL window (limit is 1000 req/hour), and
 * concurrent first requests dedupe onto one in-flight fetch. Per-instance memory
 * cache; serverless cold starts just refetch.
 */
const dailyActivitiesCache = new Map<
  string,
  { at: number; promise: Promise<{ activities: HubstaffDailyActivity[]; users: HubstaffUser[] }> }
>();
const LIVE_CACHE_TTL_MS = 180_000;

export async function fetchDailyActivitiesCached(
  orgId: string,
  dateStartIso: string,
  dateStopIso: string,
): Promise<{ activities: HubstaffDailyActivity[]; users: HubstaffUser[] }> {
  const now = Date.now();
  for (const [k, v] of dailyActivitiesCache) {
    if (now - v.at >= LIVE_CACHE_TTL_MS) dailyActivitiesCache.delete(k);
  }

  const key = `${orgId}:${dateStartIso}:${dateStopIso}`;
  const hit = dailyActivitiesCache.get(key);
  if (hit) return hit.promise;

  const promise = fetchDailyActivities(orgId, dateStartIso, dateStopIso);
  dailyActivitiesCache.set(key, { at: now, promise });
  // Never cache failures — the next poll should retry.
  promise.catch(() => dailyActivitiesCache.delete(key));
  return promise;
}
