'use client';

/**
 * What Accounting / CEO → People puts in, and takes back out of, the shared
 * Accounting tab cache (`src/lib/accounting/tab-cache.ts`).
 *
 * Both shells unmount the tab on every switch (`AnimatePresence key={activeTab}`),
 * so before 2026-10-06 only the roster ROWS came back from the cache. The week
 * KPI cards painted `0` until the read landed, the week selector read "Current
 * week", and Statistics and Bank changes sat on a skeleton every visit. Kane:
 * *"Accounting - People - Cache store the data in cache"*.
 *
 * ## The seed PAINTS; it never DECIDES
 *
 * Every dataset here carries a per-person pay figure (rates, OT payout) or is a
 * live feed, so it is the banned category of `accounting-dashboard-cache.md`
 * § *The skip-flag policy*: the seed paints, the mount fetch always runs, and
 * `tab-cache.test.ts` greps the call sites so `hasFetchedThisSession` can never
 * gate one. Each entry is written from SERVER TRUTH only, after a read that
 * succeeded; a failed read never reaches the store.
 *
 * ## One key for the roster, its summary and its week
 *
 * The KPI cards print "N of {rows.length}", and the period label names the week
 * the rows are. Across separate keys the store's per-key age eviction could
 * pair one read's rows with another read's summary or week, so the three share
 * ONE entry (the Payment Catalog's CAS pairing, `catalog-cache.ts`).
 *
 * ## Statistics keeps each point's top five
 *
 * The live `/api/people/stats` answer was measured at 3.2M characters on
 * 2026-10-06, nearly all of it the full OT leaderboard repeated inside every
 * daily / weekly / monthly point. sessionStorage has roughly 5M characters per
 * origin, shared with the roster (~0.96M), NPD and every other Accounting tab.
 * The chart reads a point's leaders ONLY through its tooltip's top
 * {@link STATS_TOOLTIP_LEADERS}, so the cached copy keeps exactly those (0.43M).
 * The live state keeps the full answer. Nothing else is trimmed.
 *
 * ## Why the envelope is not enough
 *
 * The store guarantees identity, schema version and a 12h ceiling, not the
 * shape inside. Every reader re-validates field by field and rejects the WHOLE
 * entry on anything malformed, so a bad copy costs a fetch and never paints a
 * partial table.
 */

import { getTabCache, readTabCacheStamp, setTabCache, TAB_CACHE_KEYS } from '@/lib/accounting/tab-cache';
import { isProcessorId } from '@/lib/employee-payment-processors';
import { PAY_CURRENCIES, type PayCurrency } from '@/lib/payment-catalog/pay-structure';
import type {
  PeopleHours,
  PeopleRate,
  PeopleRosterRow,
  PeopleStatsDept,
  PeopleStatsLeader,
  PeopleStatsPoint,
  PeopleSummary,
} from './people-roster';
import type { RailMix, RailSlice } from './rail-mix';
import type { PayoutRequirement } from '@/lib/employee/payout-completeness';
import type { BankChangeEntry, BankChangeField } from '@/components/people/bank-change-detail';

/** How many of a point's OT leaders the Statistics tooltip lists, and so how many the cache keeps. */
export const STATS_TOOLTIP_LEADERS = 5;

// ── Shapes ──────────────────────────────────────────────────────────────────

/** The default week's roster, exactly as `/api/people` answered it. */
export interface CachedPeopleRoster {
  rows: PeopleRosterRow[];
  summary: PeopleSummary;
  /** The week the rows are (`/api/people`'s `sourceFile`); null when no upload resolved. */
  sourceFile: string | null;
  /** A good read's server warning (bank change history unavailable), shown above the rows. */
  warning: string | null;
}

/** The pay-week selector: every uploaded week, and which one is current. */
export interface CachedPeopleWeeks {
  files: string[];
  defaultFile: string;
}

/** `/api/people/stats` (no `source_file`), each point's leaders cut to the tooltip's top five. */
export interface CachedPeopleStats {
  daily: PeopleStatsPoint[];
  weekly: PeopleStatsPoint[];
  monthly: PeopleStatsPoint[];
  otLeaders: PeopleStatsLeader[];
  otDepts: PeopleStatsDept[];
}

/** The Bank changes feed and when it was read, for its "synced … ago" line. */
export interface CachedBankChanges {
  rows: BankChangeEntry[];
  syncedAt: number | null;
}

// ── Primitive guards ────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown): v is number | null => v === null || isNum(v);
const isCount = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

const PAYOUT_REQUIREMENTS: readonly PayoutRequirement[] = ['wallet email', 'email + account name', 'bank + account'];
const RATE_SOURCES: readonly PeopleRate['source'][] = ['employee', 'sheet', 'department', null];

/** Every element through `parse`, or null when any one fails: one bad row rejects the entry. */
function parseAll<T>(raw: unknown, parse: (v: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const out: T[] = [];
  for (const item of raw) {
    const parsed = parse(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

// ── Roster ──────────────────────────────────────────────────────────────────

function parseRate(raw: unknown): PeopleRate | null {
  if (!isObj(raw)) return null;
  const { regular, ot, currency, source } = raw;
  if (!numOrNull(regular) || !numOrNull(ot)) return null;
  if (!PAY_CURRENCIES.includes(currency as PayCurrency)) return null;
  if (!RATE_SOURCES.includes(source as PeopleRate['source'])) return null;
  return { regular, ot, currency: currency as PayCurrency, source: source as PeopleRate['source'] };
}

function parseHours(raw: unknown): PeopleHours | null {
  if (!isObj(raw)) return null;
  const { thisWeek, ot, weekStart, weekEnd, inProgress, projectedHours, projectedOt } = raw;
  if (!isNum(thisWeek) || !isNum(ot)) return null;
  if (!strOrNull(weekStart) || !strOrNull(weekEnd) || !isBool(inProgress)) return null;
  if (!numOrNull(projectedHours) || !numOrNull(projectedOt)) return null;
  return { thisWeek, ot, weekStart, weekEnd, inProgress, projectedHours, projectedOt };
}

const ROSTER_TEXT_FIELDS = [
  'id', 'employee_id', 'name', 'work_email', 'personal_email', 'department', 'start_date',
  'street', 'city', 'province', 'postal_code', 'full_address', 'phone_number', 'location',
  'processor', 'accountLast4', 'bankUpdatedAt',
] as const satisfies readonly (keyof PeopleRosterRow)[];

function parseRosterRow(raw: unknown): PeopleRosterRow | null {
  if (!isObj(raw)) return null;
  const text: Partial<Record<(typeof ROSTER_TEXT_FIELDS)[number], string | null>> = {};
  for (const f of ROSTER_TEXT_FIELDS) {
    const v = raw[f];
    if (!strOrNull(v)) return null;
    text[f] = v;
  }
  const rate = parseRate(raw.rate);
  const hours = parseHours(raw.hours);
  if (!rate || !hours) return null;
  if (!isStrArray(raw.alternate_work_emails) || !isBool(raw.hasBanking)) return null;
  return {
    id: text.id ?? null,
    employee_id: text.employee_id ?? null,
    name: text.name ?? null,
    work_email: text.work_email ?? null,
    personal_email: text.personal_email ?? null,
    alternate_work_emails: [...raw.alternate_work_emails],
    department: text.department ?? null,
    start_date: text.start_date ?? null,
    street: text.street ?? null,
    city: text.city ?? null,
    province: text.province ?? null,
    postal_code: text.postal_code ?? null,
    full_address: text.full_address ?? null,
    phone_number: text.phone_number ?? null,
    location: text.location ?? null,
    rate,
    hours,
    processor: text.processor ?? null,
    hasBanking: raw.hasBanking,
    accountLast4: text.accountLast4 ?? null,
    bankUpdatedAt: text.bankUpdatedAt ?? null,
  };
}

function parseRailSlice(raw: unknown): RailSlice | null {
  if (!isObj(raw)) return null;
  const { key, label, count, payable, requires, wallet } = raw;
  if (!isStr(key) || !isProcessorId(key) || !isStr(label)) return null;
  if (!isCount(count) || !isCount(payable) || payable > count) return null;
  if (!PAYOUT_REQUIREMENTS.includes(requires as PayoutRequirement) || !isBool(wallet)) return null;
  return { key, label, count, payable, requires: requires as PayoutRequirement, wallet };
}

function parseRailMix(raw: unknown): RailMix | null {
  if (!isObj(raw)) return null;
  const { total, routed, unrouted, payable, wallet, bankRail } = raw;
  if (![total, routed, unrouted, payable, wallet, bankRail].every(isCount)) return null;
  const rails = parseAll(raw.rails, parseRailSlice);
  if (!rails) return null;
  return {
    total: total as number,
    routed: routed as number,
    unrouted: unrouted as number,
    rails,
    payable: payable as number,
    wallet: wallet as number,
    bankRail: bankRail as number,
  };
}

function parseSummary(raw: unknown): PeopleSummary | null {
  if (!isObj(raw)) return null;
  const { otEmployees, otHours, otPayoutPhp, otPayoutUsd } = raw;
  if (!isCount(otEmployees) || !isNum(otHours) || !isNum(otPayoutPhp) || !numOrNull(otPayoutUsd)) return null;
  const railMix = parseRailMix(raw.railMix);
  if (!railMix || !isObj(raw.railMixByDept)) return null;
  const railMixByDept: Record<string, RailMix> = {};
  for (const [dept, mix] of Object.entries(raw.railMixByDept)) {
    const parsed = parseRailMix(mix);
    if (!parsed) return null;
    railMixByDept[dept] = parsed;
  }
  return { otEmployees, otHours, otPayoutPhp, otPayoutUsd, railMix, railMixByDept };
}

/** A cached roster entry, re-checked field by field; null = do not trust it. */
export function parseCachedPeopleRoster(raw: unknown): CachedPeopleRoster | null {
  if (!isObj(raw)) return null;
  if (!strOrNull(raw.sourceFile) || !strOrNull(raw.warning)) return null;
  const rows = parseAll(raw.rows, parseRosterRow);
  const summary = parseSummary(raw.summary);
  if (!rows || !summary) return null;
  return { rows, summary, sourceFile: raw.sourceFile, warning: raw.warning };
}

/**
 * What `/api/people` answered, as the People tab reads it. Rows are typed loosely
 * because the tab holds its own mirror of the row type; the cache keeps the shape
 * and the parser above is what vouches for it on the way back out.
 */
export interface PeopleRosterAnswerLike<Row> {
  rows?: Row[];
  sourceFile?: string | null;
  summary?: PeopleSummary | null;
  error?: string | null;
}

/**
 * The entry to cache for a roster answer, or null when the answer must not be
 * cached. `/api/people` answers 200 with `error` and NO rows when the roster read
 * itself failed, and that is a failure, not "nobody works here". With rows,
 * `error` is a warning beside good data (bank change history unavailable) and is
 * cached alongside them so the paint repeats it.
 */
export function cacheableRoster<Row>(answer: PeopleRosterAnswerLike<Row>): {
  rows: Row[];
  summary: PeopleSummary;
  sourceFile: string | null;
  warning: string | null;
} | null {
  const rows = answer.rows ?? [];
  if (answer.error && rows.length === 0) return null;
  if (!answer.summary) return null;
  return { rows, summary: answer.summary, sourceFile: answer.sourceFile ?? null, warning: answer.error ?? null };
}

export function readCachedPeopleRoster(): CachedPeopleRoster | null {
  return parseCachedPeopleRoster(getTabCache<unknown>(TAB_CACHE_KEYS.peopleRoster));
}

/** Cache a roster answer when {@link cacheableRoster} allows it. Returns whether it wrote. */
export function writeCachedPeopleRoster<Row>(answer: PeopleRosterAnswerLike<Row>): boolean {
  const entry = cacheableRoster(answer);
  if (!entry) return false;
  setTabCache(TAB_CACHE_KEYS.peopleRoster, entry);
  return true;
}

/**
 * Swap a confirmed profile save into the cached rows, keeping the summary, week
 * and warning they were read with. No-op when nothing (trustworthy) is cached:
 * a save never creates an entry, because it carries no summary to pair with.
 */
export function patchCachedPeopleRosterRows<Row>(rows: Row[]): void {
  const current = readCachedPeopleRoster();
  if (!current) return;
  setTabCache(TAB_CACHE_KEYS.peopleRoster, { ...current, rows });
}

// ── Pay-week selector ───────────────────────────────────────────────────────

/** The selector's weeks from `/api/hubstaff-hours?source_files=1`, as the tab has always derived them. */
export function weeksFromSourceFilesAnswer(answer: {
  files?: string[];
  uploads?: { source_file: string | null; is_current: boolean }[];
}): CachedPeopleWeeks {
  const uploads = answer.uploads ?? [];
  const files = (answer.files ?? uploads.map((u) => u.source_file ?? '')).filter(Boolean);
  const defaultFile = uploads.find((u) => u.is_current)?.source_file ?? files[0] ?? '';
  return { files, defaultFile };
}

/** The cached week list, re-checked; null = do not trust it. */
export function parseCachedPeopleWeeks(raw: unknown): CachedPeopleWeeks | null {
  if (!isObj(raw)) return null;
  const { files, defaultFile } = raw;
  if (!isStrArray(files) || files.length === 0 || files.some((f) => f.trim() === '')) return null;
  if (!isStr(defaultFile)) return null;
  return { files: [...files], defaultFile };
}

export function readCachedPeopleWeeks(): CachedPeopleWeeks | null {
  return parseCachedPeopleWeeks(getTabCache<unknown>(TAB_CACHE_KEYS.peopleWeeks));
}

/** Cache the week list. An empty list is never cached: it is what a failed read looks like. */
export function writeCachedPeopleWeeks(weeks: CachedPeopleWeeks): void {
  if (weeks.files.length === 0) return;
  setTabCache(TAB_CACHE_KEYS.peopleWeeks, { files: [...weeks.files], defaultFile: weeks.defaultFile });
}

// ── Statistics ──────────────────────────────────────────────────────────────

function parseLeader(raw: unknown): PeopleStatsLeader | null {
  if (!isObj(raw)) return null;
  const { name, email, otHours, otPayoutPhp, otPayoutUsd, weeks } = raw;
  if (!strOrNull(name) || !strOrNull(email)) return null;
  if (!isNum(otHours) || !isNum(otPayoutPhp) || !numOrNull(otPayoutUsd) || !isCount(weeks)) return null;
  return { name, email, otHours, otPayoutPhp, otPayoutUsd, weeks };
}

function parseDept(raw: unknown): PeopleStatsDept | null {
  if (!isObj(raw)) return null;
  const { department, otHours, otPayoutPhp, otPayoutUsd, people } = raw;
  if (!isStr(department) || !isNum(otHours) || !isNum(otPayoutPhp) || !numOrNull(otPayoutUsd) || !isCount(people)) {
    return null;
  }
  return { department, otHours, otPayoutPhp, otPayoutUsd, people };
}

function parsePoint(raw: unknown): PeopleStatsPoint | null {
  if (!isObj(raw)) return null;
  const { sourceFile, weekStart, weekEnd, otEmployees, otHours, otPayoutPhp, otPayoutUsd } = raw;
  if (!isStr(sourceFile) || !isStr(weekStart) || !isStr(weekEnd)) return null;
  if (!isCount(otEmployees) || !isNum(otHours) || !isNum(otPayoutPhp) || !numOrNull(otPayoutUsd)) return null;
  const leaders = parseAll(raw.leaders, parseLeader);
  const depts = parseAll(raw.depts, parseDept);
  if (!leaders || !depts || leaders.length > STATS_TOOLTIP_LEADERS) return null;
  return { sourceFile, weekStart, weekEnd, otEmployees, otHours, otPayoutPhp, otPayoutUsd, leaders, depts };
}

/** The cached Statistics answer, re-checked; null = do not trust it. */
export function parseCachedPeopleStats(raw: unknown): CachedPeopleStats | null {
  if (!isObj(raw)) return null;
  const daily = parseAll(raw.daily, parsePoint);
  const weekly = parseAll(raw.weekly, parsePoint);
  const monthly = parseAll(raw.monthly, parsePoint);
  const otLeaders = parseAll(raw.otLeaders, parseLeader);
  const otDepts = parseAll(raw.otDepts, parseDept);
  if (!daily || !weekly || !monthly || !otLeaders || !otDepts) return null;
  return { daily, weekly, monthly, otLeaders, otDepts };
}

/** The cacheable copy of a successful Statistics answer: every point keeps its tooltip's top five leaders. */
export function toCachedPeopleStats(answer: CachedPeopleStats): CachedPeopleStats {
  const trim = (points: PeopleStatsPoint[]) =>
    points.map((p) => ({ ...p, leaders: p.leaders.slice(0, STATS_TOOLTIP_LEADERS) }));
  return {
    daily: trim(answer.daily),
    weekly: trim(answer.weekly),
    monthly: trim(answer.monthly),
    otLeaders: answer.otLeaders,
    otDepts: answer.otDepts,
  };
}

export function readCachedPeopleStats(): CachedPeopleStats | null {
  return parseCachedPeopleStats(getTabCache<unknown>(TAB_CACHE_KEYS.peopleStats));
}

export function writeCachedPeopleStats(answer: CachedPeopleStats): void {
  setTabCache(TAB_CACHE_KEYS.peopleStats, toCachedPeopleStats(answer));
}

// ── Bank changes ────────────────────────────────────────────────────────────

function parseBankChangeField(raw: unknown): BankChangeField | null {
  if (!isObj(raw)) return null;
  const { field, before, after, changed } = raw;
  if (!isStr(field) || !strOrNull(before) || !strOrNull(after) || !isBool(changed)) return null;
  return { field, before, after, changed };
}

function parseBankChange(raw: unknown): BankChangeEntry | null {
  if (!isObj(raw)) return null;
  const { id, name, email, fields, processor, createdNew, via, ip_address, created_at } = raw;
  if (!isStr(id) || id === '' || !isStr(name) || !strOrNull(email)) return null;
  if (!isStrArray(fields) || !strOrNull(processor) || !isBool(createdNew)) return null;
  if (!strOrNull(via) || !strOrNull(ip_address) || !isStr(created_at)) return null;
  const changes = parseAll(raw.changes, parseBankChangeField);
  if (!changes) return null;
  return { id, name, email, fields: [...fields], changes, processor, createdNew, via, ip_address, created_at };
}

/** The cached feed, re-checked; null = do not trust it. */
export function parseCachedBankChanges(raw: unknown): BankChangeEntry[] | null {
  return parseAll(raw, parseBankChange);
}

export function readCachedBankChanges(): CachedBankChanges | null {
  const rows = parseCachedBankChanges(getTabCache<unknown>(TAB_CACHE_KEYS.peopleBankChanges));
  if (!rows) return null;
  return { rows, syncedAt: readTabCacheStamp(TAB_CACHE_KEYS.peopleBankChanges) ?? null };
}

export function writeCachedBankChanges(rows: BankChangeEntry[]): void {
  setTabCache(TAB_CACHE_KEYS.peopleBankChanges, rows);
}
