/**
 * STRICTLY READ-ONLY. No insert / update / delete / upsert.
 *
 * Before an HSL branch's CODE rules are deleted in favour of a Bonus Library
 * assignment (`hsl-subdepartments.md` §7d), answer the only question that can
 * make that unsafe:
 *
 *   Is any saved row's `calculated_bonus` STANDING ON the rules being removed?
 *
 * A stored `calculated_bonus` is frozen and is what the wizard dispatches, so
 * deleting rules cannot move money on its own. The exposure is a REOPEN: a
 * manager marks a past week unready, the card rescores with `calcBonus` now
 * returning 0 for those keys, and people are silently repriced DOWNWARD.
 *
 * Run it BEFORE the deletion. A branch that has already cut over — the live week
 * scored entirely from `catalog:` keys, the old weeks entirely from code — is
 * the safe case, and this prints exactly that split.
 *
 *   npx tsx scripts/probe-hsl-hardcoded-columns.mts --dept intake_specialist
 *   npx tsx scripts/probe-hsl-hardcoded-columns.mts --dept filing_specialist
 *
 * The rule tables below are DECLARED, not imported from `schema.ts`, for two
 * reasons: the script has to keep working after the rules are deleted (that is
 * when you re-run it to confirm), and tsx's CJS interop silently hands back
 * `undefined` for that module's named exports — a bug this script hit once
 * already, where an undefined key prefix matched nothing and reported a clean
 * sweep having checked nothing.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: '.env.local' });
dotenv.config();

type Tier = { min: number; max: number | null; rate: number };
type Spec = { perUnit: Record<string, number>; tiered?: { key: string; tiers: Tier[] } };

/**
 * What each branch's code rules paid, as they stood when the saved rows were
 * scored — NOT as they stand in `schema.ts` now. For `filing_specialist` that
 * means the ORIGINAL 30/40/50 Attested Cases ladder: the 20/30/40 bands lived in
 * code for exactly one commit (b3dc6a98) and were never deployed, so no stored
 * row was ever computed with them.
 */
const SPECS: Record<string, Spec> = {
  intake_specialist: {
    perUnit: { signed_rep_docs: 250, five_star_reviews: 100 },
  },
  filing_specialist: {
    perUnit: { portal_login: 100, bbb_reviews: 250, converted_referral: 250 },
    tiered: {
      key: 'attested_cases',
      tiers: [
        { min: 0, max: 29, rate: 0 },
        { min: 30, max: 39, rate: 50 },
        { min: 40, max: 49, rate: 75 },
        { min: 50, max: null, rate: 100 },
      ],
    },
  },
};

const argIdx = process.argv.indexOf('--dept');
const DEPT = argIdx >= 0 ? process.argv[argIdx + 1] : '';
const spec = SPECS[DEPT];
if (!spec) {
  console.error(`Usage: --dept <${Object.keys(SPECS).join(' | ')}>`);
  console.error('A branch with no declared rule table here has not been measured — add it, do not guess.');
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

/** PostgREST truncates at 1000 rows even with .range() — always page. */
async function selectAllPaged<T>(table: string, columns: string, refine: (q: any) => any = (q) => q): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await refine(db.from(table).select(columns)).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

type Entry = {
  employee_email: string;
  period_start: string;
  calculated_bonus: number | null;
  kpi_data: Record<string, unknown> | null;
};

const num = (v: unknown) => Number(v ?? 0) || 0;

/** Mirrors `calcBonus` exactly: per_unit is n x rate, tiered is the WHOLE count x the landed rate. */
function codeRulePesos(kpi: Record<string, unknown> | null): number {
  let total = 0;
  for (const [k, rate] of Object.entries(spec.perUnit)) total += num(kpi?.[k]) * rate;
  if (spec.tiered) {
    const n = num(kpi?.[spec.tiered.key]);
    const band = spec.tiered.tiers.find((t) => n >= t.min && (t.max === null || n <= t.max));
    if (band) total += n * band.rate;
  }
  return total;
}
const codeKeys = [...Object.keys(spec.perUnit), ...(spec.tiered ? [spec.tiered.key] : [])];

async function main() {
  const entries = await selectAllPaged<Entry>(
    'hsl_bonus_entries',
    'employee_email, period_start, calculated_bonus, kpi_data',
    (q) => q.eq('department', DEPT),
  );
  const statuses = await selectAllPaged<{ period_start: string; status: string | null }>(
    'hsl_bonus_period_status',
    'period_start, status',
    (q) => q.eq('department', DEPT),
  );
  const statusOf = new Map(statuses.map((s) => [s.period_start, s.status ?? 'draft']));
  const weeks = [...new Set(entries.map((e) => e.period_start))].sort();

  console.log(`\n${DEPT} — ${entries.length} saved rows across ${weeks.length} weeks`);
  console.log(`code rules measured: ${codeKeys.join(' · ')}\n`);
  console.log('week        status   rows   P from code rules       P stored   catalog rows');

  let exposure = 0;
  let exposureEditable = 0;
  const atRisk: { e: Entry; loss: number; status: string }[] = [];
  for (const w of weeks) {
    const rows = entries.filter((e) => e.period_start === w);
    const status = statusOf.get(w) ?? 'draft';
    const code = rows.reduce((s, e) => s + codeRulePesos(e.kpi_data), 0);
    const stored = rows.reduce((s, e) => s + (e.calculated_bonus ?? 0), 0);
    const cat = rows.filter((e) => Object.keys(e.kpi_data ?? {}).some((k) => k.startsWith('catalog:'))).length;
    if (code > 0) {
      exposure += code;
      if (status !== 'ready' && status !== 'locked') exposureEditable += code;
      for (const e of rows) {
        const loss = codeRulePesos(e.kpi_data);
        if (loss > 0) atRisk.push({ e, loss, status });
      }
    }
    console.log(
      `${w}  ${status.padEnd(7)} ${String(rows.length).padStart(5)} ` +
        `${`P${code.toLocaleString('en-PH')}`.padStart(19)} ${`P${stored.toLocaleString('en-PH')}`.padStart(14)} ` +
        `${String(cat).padStart(14)}`,
    );
  }

  console.log(`\nREOPEN EXPOSURE — pesos that rescore to P0 once the code rules are gone`);
  console.log(`  total                        P${exposure.toLocaleString('en-PH')}  (${atRisk.length} rows)`);
  console.log(`  of that, in EDITABLE weeks   P${exposureEditable.toLocaleString('en-PH')}  (no status row / draft — reopenable today)`);
  console.log(`  the rest are 'ready' and need a deliberate Mark as Unready first.`);

  const dir = path.join('references', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${new Date().toISOString().slice(0, 10)}-${DEPT}-hardcoded-columns.json`);
  fs.writeFileSync(
    out,
    JSON.stringify({ measuredAt: new Date().toISOString(), dept: DEPT, spec, statuses, entries }, null, 2),
  );
  console.log(`\nbefore-image written: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
