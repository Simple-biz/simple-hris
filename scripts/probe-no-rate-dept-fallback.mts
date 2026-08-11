/**
 * READ-ONLY: prove the No Pay Rate dept-fallback ordering bug on live data.
 *
 *   node --import tsx scripts/probe-no-rate-dept-fallback.mts
 *
 * The bug (fixed 2026-08-11): `buildMissingRates` resolved each worker's rate
 * with a department read from `active_employees`, then `enrichMissingRatesFromMaster`
 * filled the real department in AFTERWARDS, for display only. Anyone absent from
 * `active_employees` — every off-boarded person on their final pay week, plus
 * sheet-sync-race misses — therefore resolved with `department = null`, and
 * `resolveDeptCatalogRate` short-circuits on a null department.
 *
 * This replays BOTH orderings over the same rate context and reports every
 * person for whom they disagree: rate-less under the old ordering, resolvable
 * under the new one. Each such person was a false hard blocker pinning the
 * week's Pay-rate dimension to 10/50.
 *
 * READ-ONLY BY CONSTRUCTION — plain `select` only. `.env.local` holds PRODUCTION
 * service-role credentials, so nothing here may write.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase();

/** Page past PostgREST's silent 1000-row cap (CLAUDE.md: always page). */
async function selectAllPaged<T>(table: string, cols: string): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select(cols).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function main(): Promise<void> {
  // 1. Who is in the ACTIVE view the old ordering read its departments from?
  const active = await selectAllPaged<Record<string, unknown>>(
    'active_employees',
    '"Work Email","Personal Email",Department',
  );
  const activeDeptByEmail = new Map<string, string | null>();
  for (const r of active) {
    for (const col of ['Work Email', 'Personal Email']) {
      const em = norm(r[col]);
      if (em && !activeDeptByEmail.has(em)) {
        activeDeptByEmail.set(em, (r['Department'] as string | null) ?? null);
      }
    }
  }

  // 2. The master list — what the enrichment pass would have filled in.
  const master = await selectAllPaged<Record<string, unknown>>(
    'global_master_list',
    '"Work Email","Personal Email",Department,Name,off_boarded_at',
  );
  const masterDeptByEmail = new Map<string, { dept: string | null; name: string; off: boolean }>();
  for (const r of master) {
    for (const col of ['Work Email', 'Personal Email']) {
      const em = norm(r[col]);
      if (!em) continue;
      const prev = masterDeptByEmail.get(em);
      // Prefer a live row over an off-boarded one, like the enrichment does.
      const off = r['off_boarded_at'] != null;
      if (!prev || (prev.off && !off)) {
        masterDeptByEmail.set(em, {
          dept: (r['Department'] as string | null) ?? null,
          name: String(r['Name'] ?? ''),
          off,
        });
      }
    }
  }

  // 3. Department base rates in the Payment Catalog — the tier the null
  //    department was short-circuiting past.
  const structures = await selectAllPaged<Record<string, unknown>>(
    'payment_catalog_pay_structures',
    'scope,department_key,employee_email,regular_rate,currency',
  );
  const deptRate = new Map<string, string>();
  const individualRate = new Set<string>();
  for (const s of structures) {
    const email = norm(s['employee_email']);
    if (norm(s['scope']) === 'employee' || email) {
      if (email) individualRate.add(email);
      continue;
    }
    const key = norm(s['department_key']);
    if (key && s['regular_rate'] != null) {
      deptRate.set(key, `${s['regular_rate']} ${String(s['currency'] ?? 'PHP')}`);
    }
  }

  // 4. Sheet rates — the middle tier, which is email-keyed and so was never
  //    affected by the department ordering.
  const sheet = await selectAllPaged<Record<string, unknown>>(
    'employee_hourly_rates',
    '"Work Email","Personal Email","Regular Rate"',
  );
  const sheetRate = new Set<string>();
  for (const r of sheet) {
    if (r['Regular Rate'] == null) continue;
    for (const col of ['Work Email', 'Personal Email']) {
      const em = norm(r[col]);
      if (em) sheetRate.add(em);
    }
  }

  const slug = (s: string): string =>
    s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

  /** The department-base tier, mirroring resolveDeptCatalogRate's slug fallback. */
  const deptResolves = (dept: string | null): string | null => {
    if (!dept || !dept.trim()) return null; // <- the short-circuit that caused this
    const raw = norm(dept);
    // HSL family collapses onto the one Hogan Smith Law key.
    const candidates = [raw, slug(dept), raw === 'hsl' ? 'hogan_smith_law' : ''];
    for (const c of candidates) if (c && deptRate.has(c)) return deptRate.get(c) ?? null;
    return null;
  };

  // 5. Everyone on the master list who is NOT in the active view — the exact
  //    population the old ordering resolved with a null department.
  console.log('=== No Pay Rate dept-fallback ordering — live divergence probe ===\n');
  console.log(`active_employees ...... ${active.length} rows / ${activeDeptByEmail.size} emails`);
  console.log(`global_master_list .... ${master.length} rows / ${masterDeptByEmail.size} emails`);
  console.log(`dept base rates ....... ${deptRate.size} departments`);
  console.log(`individual catalog .... ${individualRate.size} people`);
  console.log(`sheet rates ........... ${sheetRate.size} emails\n`);

  const diverge: { email: string; name: string; dept: string; rate: string; off: boolean }[] = [];
  for (const [email, m] of masterDeptByEmail) {
    if (activeDeptByEmail.has(email)) continue; // old ordering had the dept already
    if (individualRate.has(email) || sheetRate.has(email)) continue; // resolved on an earlier tier
    const rate = deptResolves(m.dept);
    if (!rate) continue; // genuinely rate-less either way — correctly listed
    diverge.push({ email, name: m.name, dept: m.dept ?? '', rate, off: m.off });
  }

  console.log(
    `PEOPLE INVISIBLE TO active_employees WHOSE DEPARTMENT HAS A BASE RATE: ${diverge.length}\n`,
  );
  console.log(
    'Each is rate-less under the OLD ordering (dept=null → dept tier skipped) and resolves\n' +
      'under the NEW one. They only reach the No Pay Rate list on a week they logged hours.\n',
  );
  diverge.sort((a, b) => a.dept.localeCompare(b.dept) || a.name.localeCompare(b.name));
  for (const d of diverge.slice(0, 40)) {
    console.log(
      `  ${d.off ? 'off-boarded' : 'ACTIVE-ish '}  ${d.email.padEnd(34)} ${d.dept.padEnd(26)} → ${d.rate}`,
    );
  }
  if (diverge.length > 40) console.log(`  … and ${diverge.length - 40} more`);

  const byDept = new Map<string, number>();
  for (const d of diverge) byDept.set(d.dept, (byDept.get(d.dept) ?? 0) + 1);
  console.log('\nBy department:');
  for (const [dept, n] of [...byDept.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${dept}`);
  }

  const shaina = diverge.find((d) => d.email.startsWith('shainan@'));
  console.log(
    `\nThe memory's named live case (shainan@simple.biz): ${
      shaina ? `REPRODUCED — ${shaina.dept} → ${shaina.rate}` : 'not in the divergent set now'
    }`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
