/**
 * [MEASUREMENT — READ ONLY]
 * Measures the true cost of ONE `/api/hubstaff-hours?live=1` refresh: the org-wide
 * daily-activities pull that `fetchDailyActivitiesCached` puts behind a 180s TTL.
 *
 *   node --import tsx <this file>
 *
 * SAFETY (both deliberate, do not loosen):
 *  1. Supabase is touched with exactly ONE SELECT (app_settings -> hubstaff.api.token).
 *     Nothing is written.
 *  2. It NEVER calls getHubstaffAccessToken(). That helper rotates a single-use
 *     refresh token and upserts the new one into PRODUCTION app_settings; running it
 *     from a local script would be a prod write and could strand the chain prod uses.
 *     This script reads the already-stored access token and EXITS if it is expired.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coveredDatesFromSourceFiles, resolveLiveOverlayWindow } from '@/lib/hubstaff/live-window';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local') });
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const PAT = process.env.HUBSTAFF_PAT?.trim();
const ORG = process.env.HUBSTAFF_ORG_ID?.trim();
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Supabase env missing');
if (!PAT || !ORG) throw new Error('HUBSTAFF_PAT / HUBSTAFF_ORG_ID missing');

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// ── 1. Read the stored token. READ ONLY. Refuse to rotate. ──────────────────
const { data, error } = await sb
  .from('app_settings')
  .select('value')
  .eq('key', 'hubstaff.api.token')
  .maybeSingle();
if (error) throw new Error(`app_settings read failed: ${error.message}`);
if (!data) {
  console.error('NO STORED TOKEN. Rotating one would write to prod app_settings — refusing.');
  process.exit(2);
}
const stored = JSON.parse((data as { value: string }).value) as {
  seed_pat?: string; refresh_token?: string; access_token?: string; access_expires_at?: number;
};
const msLeft = (stored.access_expires_at ?? 0) - Date.now();
console.log(`stored token: seed_pat matches env = ${stored.seed_pat === PAT}`);
console.log(`access token expires in ${(msLeft / 60000).toFixed(1)} min`);
if (!stored.access_token || msLeft <= 0) {
  console.error('STORED ACCESS TOKEN EXPIRED — refreshing it is a PROD WRITE. Refusing.');
  process.exit(3);
}
const accessToken = stored.access_token;

// ── 2. Replay the EXACT window the live route builds ────────────────────
// `.mts` is forced-ESM and cannot read named exports off the CJS-compiled `.ts`,
// so the resolver is pulled in dynamically. This script must use the SAME module
// the route uses — a re-derived window here would stop it being evidence.
const _lw: any = await import('../src/lib/hubstaff/live-window');
const { coveredDatesFromSourceFiles, resolveLiveOverlayWindow } = _lw.default ?? _lw;

const DAY_MS = 86_400_000;
const now = new Date();
const iso = (off: number) => new Date(now.getTime() + off * DAY_MS).toISOString().slice(0, 10);
const todayIso = iso(0);

const { data: ups, error: upErr } = await sb
  .from('hubstaff_uploads')
  .select('source_file')
  .order('uploaded_at', { ascending: false });
if (upErr) throw new Error(`hubstaff_uploads read failed: ${upErr.message}`);
const covered = coveredDatesFromSourceFiles((ups ?? []).map((u: any) => u.source_file));
const derived = resolveLiveOverlayWindow({ todayIso, coveredDates: covered });

// --old measures the pre-2026-09-12 fixed window instead, for comparison.
const measureOld = process.argv.includes('--old');
const rangeStart = measureOld ? iso(-13) : derived.rangeStart;
const rangeStop = measureOld ? iso(1) : derived.rangeStop;

console.log(`old fixed window : ${iso(-13)} -> ${iso(1)}  (15 dates)`);
console.log(`derived window   : ${derived.rangeStart} -> ${derived.rangeStop}  (${derived.days} dates, reason=${derived.reason})`);
console.log(`MEASURING        : ${rangeStart} -> ${rangeStop}${measureOld ? '  (--old)' : ''}`);

type Activity = { id: number; user_id: number; date: string; tracked?: number };
const activities: Activity[] = [];
const usersById = new Map<number, unknown>();
let pageStartId = 0;
let pages = 0;
let bytes = 0;
const pageMs: number[] = [];
const t0 = Date.now();

for (let page = 0; page < 50; page++) {
  const params = new URLSearchParams({
    'date[start]': rangeStart,
    'date[stop]': rangeStop,
    page_limit: '500',
    include: 'users',
  });
  if (pageStartId) params.set('page_start_id', String(pageStartId));
  const url = `https://api.hubstaff.com/v2/organizations/${encodeURIComponent(ORG)}/activities/daily?${params}`;

  const tp = Date.now();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, cache: 'no-store' });
  const text = await res.text();
  pageMs.push(Date.now() - tp);
  pages++;
  bytes += text.length;
  if (!res.ok) {
    console.error(`page ${pages} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
    break;
  }
  const json = JSON.parse(text) as {
    daily_activities?: Activity[];
    users?: { id: number }[];
    pagination?: { next_page_start_id?: number | null };
  };
  for (const a of json.daily_activities ?? []) activities.push(a);
  for (const u of json.users ?? []) if (u && typeof u.id === 'number') usersById.set(u.id, u);
  const next = json.pagination?.next_page_start_id;
  if (!next) break;
  pageStartId = next;
  await new Promise((r) => setTimeout(r, 150)); // PAGE_GAP_MS
}
const wallMs = Date.now() - t0;

// ── 3. Report ───────────────────────────────────────────────────────────────
const perUserDay = new Map<string, number>();
const byDate = new Map<string, number>();
for (const a of activities) {
  perUserDay.set(`${a.user_id}|${a.date}`, (perUserDay.get(`${a.user_id}|${a.date}`) ?? 0) + 1);
  byDate.set(a.date, (byDate.get(a.date) ?? 0) + 1);
}
const fanout = [...perUserDay.values()];
const avgFan = fanout.length ? fanout.reduce((s, n) => s + n, 0) / fanout.length : 0;

console.log('─'.repeat(58));
console.log(`HTTP requests (pages) : ${pages}`);
console.log(`wall clock            : ${(wallMs / 1000).toFixed(2)}s   (route maxDuration = 60s)`);
console.log(`slowest page          : ${Math.max(...pageMs)}ms`);
console.log(`payload               : ${(bytes / 1048576).toFixed(2)} MB`);
console.log(`activity rows         : ${activities.length}`);
console.log(`distinct users        : ${usersById.size}`);
console.log(`distinct user-days    : ${perUserDay.size}`);
console.log(`rows per user-day     : avg ${avgFan.toFixed(2)}, max ${fanout.length ? Math.max(...fanout) : 0}`);
console.log('─'.repeat(58));
console.log(`Hubstaff req/hour at 180s TTL, ONE warm instance : ${pages * 20}`);
console.log(`                                    cap is 1000 : ${((pages * 20 / 1000) * 100).toFixed(0)}% of budget`);
console.log(`instances before the cap blows                  : ${(1000 / (pages * 20)).toFixed(1)}`);
console.log('─'.repeat(58));
let settled = 0;
for (const [d, n] of byDate) if (d < todayIso) settled += n;
console.log(`rows for SETTLED days (< ${todayIso}) : ${settled} of ${activities.length}` +
  ` = ${activities.length ? ((settled / activities.length) * 100).toFixed(1) : '0'}% refetched every 3 min for nothing`);
console.log('\nrows by date:');
for (const d of [...byDate.keys()].sort()) console.log(`  ${d}  ${byDate.get(d)}`);
