/**
 * READ-ONLY probe — is Payroll Notes → Offboarded → "Set rate" actually sticking?
 *
 *   npx tsx scripts/probe-offboarded-setrate-health.mts [sinceIso]
 *
 * The 2026-09-15 complete-override made four promises (rate-override.ts):
 *   1. the write is keyed to the HUBSTAFF email (the payable identity);
 *   2. exactly ONE employee-scope structure survives per person (shadows retired);
 *   3. `employee_rate_history` is SUPERSEDED from min(today, effective), not stacked;
 *   4. the `employee_hourly_rates` cache is updated, and a failure is a 500.
 *
 * This measures each one against production. Writes nothing.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
const sb = createClient(url, key, { auth: { persistSession: false } });

const SINCE = process.argv[2] ?? '2026-09-15';
const norm = (s: unknown): string | null => {
  const t = String(s ?? '').trim().toLowerCase();
  return t || null;
};

async function paged<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

type AuditRow = { created_at: string; user_name: string | null; action: string; resource_id: string | null; details: Record<string, unknown> | null };
type StructRow = { id: string; scope: string; department_key: string; employee_email: string | null; regular_rate: string | number; ot_rate: string | number | null; currency: string; created_at: string | null };
type HistRow = { employee_email: string; regular_rate: string | null; ot_rate: string | null; effective_from: string; created_by: string | null; note: string | null; created_at?: string | null };

function main() {
  return (async () => {
    // ── 1. Every "Set rate" the fixer made ──────────────────────────────────
    const audits = await paged<AuditRow>((f, t) =>
      sb
        .from('audit_log')
        .select('created_at, user_name, action, resource_id, details')
        .eq('action', 'payroll.rate.set')
        .gte('created_at', SINCE)
        .order('created_at', { ascending: true })
        .range(f, t),
    );
    const fixer = audits.filter((a) => String(a.details?.source ?? '') === 'payroll_wizard_readiness');
    const catalog = audits.filter((a) => String(a.details?.source ?? '') !== 'payroll_wizard_readiness');
    console.log(`\n=== payroll.rate.set audit rows since ${SINCE} ===`);
    console.log(`  fixer (Readiness/Offboarded): ${fixer.length}`);
    console.log(`  Payment Catalog editor:       ${catalog.length}`);

    const touched = new Map<string, AuditRow[]>();
    for (const a of fixer) {
      const em = norm(a.details?.employee_email ?? a.resource_id);
      if (!em) continue;
      if (!touched.has(em)) touched.set(em, []);
      touched.get(em)!.push(a);
    }
    // The baseline for "did it stick" is the newest save from ANY source, never the
    // fixer's own. A later Payment Catalog edit legitimately outranks it: on the
    // first run of this probe, four people (michaelsy@ / vanessas@ / cinderellar@ /
    // ronaldt@) read as "*** HISTORY DISAGREES ***" purely because carla@ re-rated
    // them from the catalog on 09-21, six days after the fixer save.
    const newestAny = new Map<string, AuditRow>();
    for (const a of audits) {
      const em = norm(a.details?.employee_email ?? a.resource_id);
      if (!em || !touched.has(em)) continue;
      const prev = newestAny.get(em);
      if (!prev || String(a.created_at) > String(prev.created_at)) newestAny.set(em, a);
    }
    console.log(`  distinct people re-rated by the fixer: ${touched.size}`);
    for (const [em, rows] of touched) {
      const last = rows[rows.length - 1];
      const sup = (last.details?.superseded_structures as unknown[] | undefined) ?? [];
      console.log(
        `    ${em.padEnd(34)} ${rows.length}× · last ${String(last.created_at).slice(0, 16)} by ${last.user_name ?? '?'}` +
          ` · ₱${last.details?.regular_rate} ${last.details?.currency} · dept ${last.details?.department_key}` +
          ` · eff ${last.details?.effective_date ?? '(today)'} · override=${last.details?.override}` +
          ` · retired ${sup.length}`,
      );
    }

    // ── 2. Shadow structures: exactly ONE per person? ───────────────────────
    const structs = await paged<StructRow>((f, t) =>
      sb.from('payment_catalog_pay_structures').select('id, scope, department_key, employee_email, regular_rate, ot_rate, currency, created_at').range(f, t),
    );
    const empStructs = structs.filter((s) => s.scope === 'employee');
    const byEmail = new Map<string, StructRow[]>();
    for (const s of empStructs) {
      const em = norm(s.employee_email);
      if (!em) continue;
      if (!byEmail.has(em)) byEmail.set(em, []);
      byEmail.get(em)!.push(s);
    }
    const dupes = [...byEmail.entries()].filter(([, v]) => v.length > 1);
    console.log(`\n=== employee-scope pay structures ===`);
    console.log(`  rows: ${empStructs.length} · people: ${byEmail.size} · holding 2+: ${dupes.length} (19 on 2026-09-15)`);
    for (const [em, rows] of dupes) {
      const wasFixed = touched.has(em) ? '  ← FIXER TOUCHED THIS PERSON' : '';
      console.log(
        `    ${em.padEnd(34)} ${rows
          .map((r) => `${r.department_key}=${r.currency}${r.regular_rate}@${String(r.created_at).slice(0, 10)}`)
          .join(' | ')}${wasFixed}`,
      );
    }

    // ── 3. Rate history: superseded, or stacked? ────────────────────────────
    const emails = [...touched.keys()];
    const hist: HistRow[] = [];
    for (let i = 0; i < emails.length; i += 100) {
      const slice = emails.slice(i, i + 100);
      hist.push(
        ...(await paged<HistRow>((f, t) =>
          sb
            .from('employee_rate_history')
            .select('employee_email, regular_rate, ot_rate, effective_from, created_by, note, created_at')
            .in('employee_email', slice)
            .order('effective_from', { ascending: true })
            .range(f, t),
        )),
      );
    }
    const histBy = new Map<string, HistRow[]>();
    for (const h of hist) {
      const em = norm(h.employee_email);
      if (!em) continue;
      if (!histBy.has(em)) histBy.set(em, []);
      histBy.get(em)!.push(h);
    }
    console.log(`\n=== rate history for the ${emails.length} people the fixer re-rated ===`);
    let mismatched = 0;
    let stacked = 0;
    for (const em of emails) {
      const rows = (histBy.get(em) ?? []).slice().sort((a, b) => a.effective_from.localeCompare(b.effective_from));
      const last = rows[rows.length - 1];
      const decisive = newestAny.get(em)!;
      const bySomeoneElse = String(decisive.details?.source ?? '') !== 'payroll_wizard_readiness';
      const wanted = Number(decisive.details?.regular_rate);
      const got = last ? Number(last.regular_rate) : null;
      const agree = got != null && Math.abs(got - wanted) < 0.005;
      // ANY of the person's structures may be the one the resolver lands on
      // (newest-created wins), so agreement means the newest-created one agrees.
      const mine = (byEmail.get(em) ?? [])
        .slice()
        .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
      const struct = mine[mine.length - 1];
      const structRate = struct ? Number(struct.regular_rate) : null;
      const structAgree = structRate != null && Math.abs(structRate - wanted) < 0.005;
      // Same effective_from twice = the stacking the override was built to end.
      const effs = rows.map((r) => r.effective_from);
      const dupEff = effs.length !== new Set(effs).size;
      if (!agree || !structAgree) mismatched += 1;
      if (dupEff) stacked += 1;
      console.log(
        `    ${em.padEnd(34)} newest save ₱${wanted}${bySomeoneElse ? ' (Payment Catalog, AFTER the fixer)' : ''}` +
          ` · history ${rows.length} row(s), newest ₱${got ?? '—'} eff ${last?.effective_from ?? '—'}` +
          ` ${agree ? 'OK' : '*** HISTORY DISAGREES ***'} · structure ₱${structRate ?? '—'} ${structAgree ? 'OK' : '*** STRUCTURE DISAGREES ***'}` +
          `${dupEff ? ' *** DUPLICATE effective_from ***' : ''}`,
      );
      if (rows.length <= 8) {
        for (const r of rows) console.log(`        ${r.effective_from}  ₱${r.regular_rate}  by ${r.created_by ?? '?'}  ${r.note ?? ''}`);
      }
    }

    // ── 4. The employee_hourly_rates cache — did the write find a row? ──────
    const cache = await paged<Record<string, unknown>>((f, t) =>
      sb.from('employee_hourly_rates').select('"Work Email", "Personal Email", "Regular Rate", "OT Rate"').range(f, t),
    );
    const cacheByWork = new Map<string, Record<string, unknown>>();
    const cacheByAny = new Map<string, Record<string, unknown>>();
    for (const c of cache) {
      const w = norm(c['Work Email']);
      const p = norm(c['Personal Email']);
      if (w) {
        cacheByWork.set(w, c);
        cacheByAny.set(w, c);
      }
      if (p && !cacheByAny.has(p)) cacheByAny.set(p, c);
    }
    console.log(`\n=== employee_hourly_rates cache (${cache.length} rows) — the route updates by "Work Email" ONLY ===`);
    let noWorkRow = 0;
    let cacheStale = 0;
    for (const em of emails) {
      const wanted = Number(newestAny.get(em)!.details?.regular_rate);
      const byWork = cacheByWork.get(em);
      const byAny = cacheByAny.get(em);
      const cached = byWork ? Number(byWork['Regular Rate']) : null;
      if (!byWork) {
        noWorkRow += 1;
        console.log(
          `    ${em.padEnd(34)} *** NO "Work Email" ROW *** — the UPDATE matched 0 rows and returned no error` +
            (byAny ? ` (a row DOES exist under Personal Email: ₱${byAny['Regular Rate']})` : ' (no cache row at all)'),
        );
      } else if (cached == null || Math.abs(cached - wanted) >= 0.005) {
        cacheStale += 1;
        console.log(`    ${em.padEnd(34)} *** CACHE ₱${cached ?? '—'} ≠ saved ₱${wanted} ***`);
      }
    }
    console.log(
      `  cache: ${emails.length - noWorkRow - cacheStale}/${emails.length} agree · ${noWorkRow} with no Work-Email row · ${cacheStale} stale`,
    );

    // ── 5. Did the MONEY follow? ────────────────────────────────────────────
    // `disbursement_records.regular_rate_php` is the rate FROZEN when the week was
    // staged. A save made after that timestamp cannot reach the row — the week must
    // be re-locked (payroll-rule-changes-forward-only). This is where a save that is
    // correct in every table above still pays the old figure.
    type DisbRow = {
      cycle_period_start: string; cycle_period_end: string; recipient_email: string;
      total_hours: number | string | null; regular_rate_php: number | string | null;
      amount_php: number | string | null; status: string | null; kind: string | null;
      created_at: string | null;
    };
    const disb: DisbRow[] = [];
    for (let i = 0; i < emails.length; i += 100) {
      const slice = emails.slice(i, i + 100);
      disb.push(
        ...(await paged<DisbRow>((f, t) =>
          sb
            .from('disbursement_records')
            .select('cycle_period_start, cycle_period_end, recipient_email, total_hours, regular_rate_php, amount_php, status, kind, created_at')
            .in('recipient_email', slice)
            .gte('cycle_period_start', SINCE.slice(0, 7) + '-01')
            .order('cycle_period_start', { ascending: true })
            .range(f, t),
        )),
      );
    }
    console.log(`\n=== did the money follow? (disbursement_records since ${SINCE.slice(0, 7)}) ===`);
    let staleRows = 0;
    let stalePesos = 0;
    for (const d of disb) {
      if (d.kind === 'special') continue;
      const em = norm(d.recipient_email);
      if (!em) continue;
      // The rate in force for that week, per the history, as of today.
      const rows = (histBy.get(em) ?? []).filter((h) => h.effective_from <= d.cycle_period_end);
      const inForce = rows.length ? Number(rows[rows.length - 1].regular_rate) : null;
      const frozen = d.regular_rate_php == null ? null : Number(d.regular_rate_php);
      if (inForce == null || frozen == null) continue;
      const gap = frozen - inForce;
      const hours = Number(d.total_hours) || 0;
      if (Math.abs(gap) < 0.005) continue;
      staleRows += 1;
      stalePesos += gap * hours;
      // Which save the row missed, and whether it could ever have caught it.
      const missed = (histBy.get(em) ?? []).find(
        (h) => h.effective_from <= d.cycle_period_end && Number(h.regular_rate) === inForce,
      );
      const stagedFirst = missed?.created_at && d.created_at ? String(d.created_at) < String(missed.created_at) : null;
      console.log(
        `    ${em.padEnd(24)} ${d.cycle_period_start}→${d.cycle_period_end.slice(5)} ${String(d.status).padEnd(8)}` +
          ` ${hours.toFixed(2).padStart(6)}h · frozen ₱${frozen} vs in-force ₱${inForce}` +
          ` = ₱${(gap * hours).toFixed(2)} ${gap > 0 ? 'OVER' : 'UNDER'}` +
          (stagedFirst === true ? ' · STAGED BEFORE THE SAVE — needs a re-lock' : stagedFirst === false ? ' *** staged AFTER the save and still missed it ***' : ''),
      );
    }
    if (staleRows === 0) console.log('    none — every week prices from the rate in force');

    console.log(
      `\n=== verdict inputs ===\n  fixer saves: ${fixer.length} · people: ${touched.size}` +
        `\n  people still holding 2+ employee structures: ${dupes.length}` +
        `\n  fixer people whose history/structure disagrees with the saved figure: ${mismatched}` +
        `\n  fixer people with a duplicate effective_from: ${stacked}` +
        `\n  fixer people the cache write could not reach: ${noWorkRow}` +
        `\n  pay rows frozen at a superseded rate: ${staleRows} · net ₱${stalePesos.toFixed(2)}`,
    );
  })();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
