/**
 * READ-ONLY diagnostic: why does Payroll Wizard step 6 show "Nobody is ineligible"
 * while the Additions table shows Ineligible pills?
 *
 * Reproduces BOTH verdicts over live data using the REAL shared helpers (not a
 * re-implementation, which would only prove my re-implementation agrees with itself):
 *   A) the Additions pill — pabStatusByEmail: any PAST Mon–Fri below 7h, not forgiven
 *   B) step 6 severity    — computePabIneligibility over the same day breakdown
 *
 * Writes nothing.
 *   npx tsx scripts/diagnose-pab-step6.mts [YYYY-MM]
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

// Namespace import: named-export detection fails for this module under tsx's
// ESM loader, so bind the functions at runtime instead.
import * as CCD from '../src/lib/hubstaff/calendar-column-dedupe';
import * as PABI from '../src/lib/payroll/pab-ineligibility';
import type { PabDayEntry } from '../src/lib/payroll/pab-ineligibility';

// tsx loads these through CJS interop, so the named exports land on `.default`.
const ccd: any = (CCD as any).default ?? CCD;
const pabi: any = (PABI as any).default ?? PABI;
const {
  columnsAreAllCanonical, resolveCanonicalColumnsToIso, groupDateColumnsByCalendarDay,
  filterColumnGroupsByPabRange, parseColDate,
} = ccd;
const computePabIneligibility = pabi.computePabIneligibility;

dotenv.config({ path: '.env.local' });
dotenv.config();

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const H7 = 7 * 3600;
const MONTH = process.argv[2] ?? '2026-08';

async function pageAll<T>(table: string, select: string): Promise<T[]> {
  const out: T[] = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await sb.from(table).select(select).range(from, from + SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < SIZE) break;
  }
  return out;
}

const isoOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Mirrors PayrollWizard's file-local helpers (they are not exported).
const NON_DATE = new Set(['organization','time zone','member','email','job title','job type','employee id','tax info','location','date added','total worked','activity','spent total','currency','source_file','upload_id','id']);
function rawValueToTotalSeconds(v: unknown): number {
  if (v == null) return 0;
  const s = String(v).trim(); if (!s) return 0;
  const hms = /^(\d+):(\d{2}):(\d{2})$/.exec(s);
  if (hms) return +hms[1] * 3600 + +hms[2] * 60 + +hms[3];
  const hm = /^(\d+):(\d{2})$/.exec(s);
  if (hm) return +hm[1] * 3600 + +hm[2] * 60;
  const dec = parseFloat(s);
  return Number.isFinite(dec) ? Math.round(dec * 3600) : 0;
}
function parseColDateParts(col: string) {
  const d = parseColDate(col);
  return d ? { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() } : null;
}
function colIsWeekday(col: string): boolean {
  // After resolveCanonicalColumnsToIso every day column is a plain ISO date, so
  // the date itself decides — no day-name-prefix branch needed here.
  const s = col.trim(); const lower = s.toLowerCase();
  for (const nd of NON_DATE) if (lower === nd || lower.startsWith(nd + ' ')) return false;
  const date = parseColDate(s);
  if (date !== null) { const dow = date.getDay(); return dow >= 1 && dow <= 5; }
  return false;
}

function groupWeekdayColumnsByDate(cols: string[]): string[][] {
  return groupDateColumnsByCalendarDay(cols.filter(colIsWeekday), cols);
}
function isoDateFromColumnGroup(group: string[]): string | null {
  for (const col of group) {
    const p = parseColDateParts(col);
    if (p) return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  }
  return null;
}

async function main() {
  const { data: settings } = await sb
    .from('app_settings')
    .select('key,value')
    .in('key', ['pab_period_overrides', 'pab_period_exclusions']);
  const byKey = Object.fromEntries((settings ?? []).map((r: any) => [r.key, r.value]));

  let overrides: Record<string, { start: string; end: string }> = {};
  try { overrides = JSON.parse(byKey.pab_period_overrides ?? '{}'); } catch {}
  const ov = overrides[MONTH];
  if (!ov) { console.error(`No override for ${MONTH}; keys: ${Object.keys(overrides).join(',')}`); process.exit(1); }
  const [sy, sm, sd] = ov.start.split('-').map(Number);
  const [ey, em2, ed] = ov.end.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em2 - 1, ed);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const periodEnded = today.getTime() > new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
  console.log(`\nPAB window ${MONTH}: ${isoOf(start)} → ${isoOf(end)} · today ${isoOf(today)} · periodEnded=${periodEnded}`);

  let exclusions: Record<string, string[]> = {};
  try { exclusions = JSON.parse(byKey.pab_period_exclusions ?? '{}'); } catch {}
  const excluded = new Set((exclusions[MONTH] ?? []).map((e) => e.trim().toLowerCase()));

  // Merge every source_file the way the wizard's PAB merge does.
  const raw = await pageAll<any>('hubstaff_hours', '*');
  console.log(`hubstaff_hours rows: ${raw.length}`);

  const bySource = new Map<string, any[]>();
  for (const r of raw) {
    const sf = r.source_file ?? '';
    if (!bySource.has(sf)) bySource.set(sf, []);
    bySource.get(sf)!.push(r);
  }
  console.log(`source files: ${bySource.size}`);

  const allCols = new Set<string>();
  const rowsByEmail = new Map<string, Record<string, unknown>>();
  for (const [sf, rows] of bySource) {
    for (let row of rows) {
      const clean: Record<string, unknown> = { ...row };
      delete clean.id; delete clean.upload_id;
      if (sf && columnsAreAllCanonical(Object.keys(clean))) {
        row = resolveCanonicalColumnsToIso(clean, sf);
      } else { row = clean; }
      for (const k of Object.keys(row)) allCols.add(k);
      const em = String(row['Email'] ?? row['email'] ?? '').trim().toLowerCase();
      if (!em) continue;
      rowsByEmail.set(em, { ...(rowsByEmail.get(em) ?? {}), ...row });
    }
  }
  console.log(`merged emails: ${rowsByEmail.size} · merged columns: ${allCols.size}`);

  const cols = [...allCols];
  const weekdayGroups = filterColumnGroupsByPabRange(groupWeekdayColumnsByDate(cols), cols, start, end);
  console.log(`Mon–Fri column groups inside the window: ${weekdayGroups.length}`);
  if (weekdayGroups.length === 0) {
    console.log('  !! no dated weekday columns resolved — the merge produced nothing PAB can score');
    const sample = cols.filter((c) => parseColDate(c)).slice(0, 8);
    console.log(`  sample dated cols: ${sample.join(' | ') || '(none)'}`);
  }

  const pick = ccd.pickPreferredHubstaffColumn;
  console.log('-- column groups: preferred label vs resolvable date --');
  for (const g of weekdayGroups.slice(0, 6)) {
    const col = pick(g);
    console.log(`  group=[${g.join(' | ')}]  preferred="${col}"  parseColDate(col)=${parseColDate(col) ? 'OK' : 'NULL'}  groupIso=${isoDateFromColumnGroup(g)}`);
  }
  const brokenPreferred = weekdayGroups.filter((g: string[]) => !parseColDate(pick(g))).length;
  console.log(`  groups whose PREFERRED column is unparseable: ${brokenPreferred} / ${weekdayGroups.length}`);

  const disputes = await pageAll<any>('pab_day_disputes', 'work_email,dispute_date,status,override_hours');
  const forgiven = new Map<string, Map<string, number | null>>();
  for (const d of disputes) {
    if (d.status !== 'approved' && d.status !== 'accounting_approved') continue;
    const em = String(d.work_email ?? '').trim().toLowerCase();
    if (!forgiven.has(em)) forgiven.set(em, new Map());
    forgiven.get(em)!.set(d.dispute_date, d.override_hours);
  }

  let additionsIneligible = 0, severityPositive = 0, noCells = 0;
  const disagree: string[] = [];

  for (const [em, row] of rowsByEmail) {
    const fdates = forgiven.get(em);
    const breakdown = weekdayGroups.map((group) => {
      const rawSec = Math.max(0, ...group.map((c) => rawValueToTotalSeconds(row[c])));
      const iso = isoDateFromColumnGroup(group);
      const override = iso ? fdates?.get(iso) : undefined;
      const seconds = override != null ? override * 3600 : rawSec;
      const disputeForgiven = !!(iso && fdates?.has(iso) && seconds >= 4 * 3600 && seconds < H7);
      return { iso, seconds, passes: seconds >= H7 || disputeForgiven, disputeForgiven };
    });
    if (breakdown.length === 0) { noCells++; continue; }

    // (A) Additions verdict
    const pastFail = breakdown.some((b) => {
      if (b.passes || !b.iso) return false;
      const d = parseColDate(b.iso);
      return !!d && new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() <= today.getTime();
    });
    const aIneligible = excluded.has(em) || pastFail;

    // (B) step-6 severity, via the real module
    const entries: PabDayEntry[] = breakdown
      .filter((b) => b.iso)
      .map((b) => ({
        iso: b.iso!,
        seconds: b.seconds,
        passes: b.passes,
        forgivenByDispute: b.disputeForgiven,
        forgivenByHoliday: false,
      }));
    const { severity } = computePabIneligibility({
      entries, isHsl: false, hslSunSat: true, periodStart: start, periodEnd: end,
    });

    if (aIneligible) additionsIneligible++;
    if (severity > 0) severityPositive++;
    if (aIneligible !== severity > 0) disagree.push(`${em} additions=${aIneligible} severity=${severity}`);
  }

  console.log(`\nemails with no weekday cells : ${noCells}`);
  console.log(`Additions says INELIGIBLE     : ${additionsIneligible}`);
  console.log(`step-6 severity > 0           : ${severityPositive}`);
  console.log(`disagreements                 : ${disagree.length}`);
  disagree.slice(0, 20).forEach((d) => console.log('  ' + d));
}

main().catch((e) => { console.error(e); process.exit(1); });
