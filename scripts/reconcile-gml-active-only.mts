/**
 * Reconcile `global_master_list` to ACTIVE PEOPLE ONLY.
 *
 * Kane, 2026-09-21: *"I only want the active people not the offboarded in the
 * Global Master List … GML is different Offboarded is Different."*
 *
 * Two write sets, both re-derived at run time (the table moves — it grew
 * 2,761 → 2,833 rows inside one measuring session, so NOTHING here works from
 * ids captured earlier):
 *
 *   1. CORPSES — a transfer leftover. The sync keys on
 *      `(personal_email, department)`, so a department transfer inserted a second
 *      row and left the first active forever. A row is a corpse ONLY when the
 *      same person also holds an active row ON THE CURRENT UPLOAD. Stamped
 *      `duplicate_cleanup`, which is deliberately OUTSIDE `DEPARTURE_REASONS`
 *      (`src/lib/payment-catalog/catalog-roster-visibility.ts`) so not one of
 *      these living people reads as a departure on any surface.
 *
 *   2. LEAVERS — an active row for someone with a real departure record in
 *      `offboarded_sheet` and no active row on the current upload. Stamped with
 *      the record's OWN date (Kane's ruling), not today's.
 *
 * Everything else is REPORTED, never written: the people who are live but absent
 * from the HR screen, and the ones evidence cannot classify. Kane's ruling is
 * that they stay active and go to HR — this fails OPEN, like every other roster
 * guard in the codebase.
 *
 * Rehearsal by default. `--apply` performs the writes, and only after a full
 * SELECT backup is on disk (CLAUDE.md § Data).
 *
 *   node --import tsx scripts/reconcile-gml-active-only.mts
 *   node --import tsx scripts/reconcile-gml-active-only.mts --apply
 *
 * Every write is reversible: `revert-plan.csv` names each id with the values it
 * held before, so clearing `off_boarded_*` on exactly those ids restores them.
 */
import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const APPLY = process.argv.includes('--apply');
const OUT = 'references/backups/2026-09-21-gml-reconcile';
const ACTOR = 'system:gml-reconcile-2026-09-21';
/** A person paid or with hours on/after this is LIVE, whatever a stale record says. */
const LIVE_SINCE = '2026-08-07';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error('missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const s = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const EC = ['Work Email', 'Personal Email', 'Alternate Work Email', 'Alternate Work Email 2'] as const;
const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
const day = (v: unknown) => String(v ?? '').slice(0, 10);

async function retry<T>(fn: () => PromiseLike<{ data: T | null; error: unknown }>): Promise<T> {
  let last: unknown = null;
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fn();
      if (!r.error) return r.data as T;
      last = r.error;
    } catch (e) {
      last = e;
    }
    await new Promise((res) => setTimeout(res, 800 * (a + 1)));
  }
  throw new Error(`read failed after retries: ${String((last as { message?: string })?.message ?? last)}`);
}

async function paged(table: string, select: string): Promise<Record<string, unknown>[]> {
  const P = 1000;
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += P) {
    const batch = await retry(() => s.from(table).select(select).range(from, from + P - 1) as never);
    const b = (batch ?? []) as unknown as Record<string, unknown>[];
    rows.push(...b);
    if (b.length < P) break;
  }
  return rows;
}

function csv(rows: Record<string, unknown>[], cols: string[]): string {
  const cell = (v: unknown) => {
    const t = String(v ?? '');
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(APPLY ? '*** APPLY MODE — this writes to PRODUCTION ***\n' : 'rehearsal (no writes)\n');

  const ups = (await retry(() =>
    s.from('master_list_uploads').select('id,uploaded_at').eq('is_current', true) as never,
  )) as unknown as { id: string; uploaded_at: string }[];
  if (!ups?.length) throw new Error('no current master_list_upload — refusing to run');
  if (ups.length > 1) throw new Error(`${ups.length} uploads flagged is_current — refusing to run`);
  const CUR = ups[0].id;
  console.log(`current upload ${CUR.slice(0, 8)} (${ups[0].uploaded_at})`);

  const gml = await paged(
    'global_master_list',
    'id,"Name","Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2","Department","Start Date",off_boarded_at,off_boarded_reason,off_boarded_by,off_boarded_note,last_seen_upload_id',
  );
  writeFileSync(`${OUT}/00-gml-full-snapshot.csv`, csv(gml, Object.keys(gml[0] ?? {})));
  console.log(`snapshot written: ${gml.length} rows -> ${OUT}/00-gml-full-snapshot.csv`);

  const active = gml.filter((r) => !r.off_boarded_at);

  // Identity, alias-aware: fold every row's four email columns into one person.
  // A count keyed on a single column is unsound against this table — that is how
  // an earlier pass got "217 missing" when the true answer was 7.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const add = (x: string) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  const union = (a: string, b: string) => {
    add(a);
    add(b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const r of active) {
    const es = EC.map((c) => norm(r[c])).filter(Boolean);
    es.forEach(add);
    for (let i = 1; i < es.length; i++) union(es[0], es[i]);
  }
  const pkey = (r: Record<string, unknown>) => {
    const es = EC.map((c) => norm(r[c])).filter(Boolean);
    return es.length ? find(es[0]) : `row:${String(r.id)}`;
  };

  const onCurrent = new Set<string>();
  for (const r of active) if (r.last_seen_upload_id === CUR) onCurrent.add(pkey(r));

  // Departure evidence + liveness.
  const sheet = await paged('offboarded_sheet', 'work_email,personal_email,off_boarded_at,off_boarded_reason');
  const recBy = new Map<string, Record<string, unknown>>();
  for (const r of sheet) {
    for (const e of [norm(r.work_email), norm(r.personal_email)]) {
      if (e && !recBy.has(e)) recBy.set(e, r);
    }
  }
  const disb = await paged('disbursement_records', 'recipient_email,cycle_period_end,created_at');
  const paidBy = new Map<string, string>();
  for (const r of disb) {
    const e = norm(r.recipient_email);
    if (!e) continue;
    const d = day(r.cycle_period_end ?? r.created_at);
    if (d && (!paidBy.has(e) || d > paidBy.get(e)!)) paidBy.set(e, d);
  }
  const hours = await paged('hubstaff_hours', '"Email","Date added"');
  const workedBy = new Map<string, string>();
  for (const r of hours) {
    const e = norm(r['Email']);
    if (!e) continue;
    const d = day(r['Date added']);
    if (d && (!workedBy.has(e) || d > workedBy.get(e)!)) workedBy.set(e, d);
  }

  const emailsOf = (r: Record<string, unknown>) => EC.map((c) => norm(r[c])).filter(Boolean);
  const isLive = (r: Record<string, unknown>) =>
    emailsOf(r).some((e) => (paidBy.get(e) ?? '') >= LIVE_SINCE || (workedBy.get(e) ?? '') >= LIVE_SINCE);
  const recordFor = (r: Record<string, unknown>) => emailsOf(r).map((e) => recBy.get(e)).find(Boolean) ?? null;

  const corpses: Record<string, unknown>[] = [];
  const leavers: Record<string, unknown>[] = [];
  const liveMissing: Record<string, unknown>[] = [];
  const review: Record<string, unknown>[] = [];

  for (const r of active) {
    if (r.last_seen_upload_id === CUR) continue; // on the HR screen — correct, untouched
    const person = pkey(r);

    // CORPSE: the same person IS on the current upload under another row.
    if (onCurrent.has(person)) {
      corpses.push({ ...r, person, verdict: 'duplicate_cleanup' });
      continue;
    }

    // Live beats every stale record. Fails OPEN — hiding a live person means
    // their pay is never scored and never paid.
    if (isLive(r)) {
      liveMissing.push({ ...r, person, last_paid: emailsOf(r).map((e) => paidBy.get(e) ?? '').sort().pop() ?? '' });
      continue;
    }

    const rec = recordFor(r);
    const offDate = day(rec?.off_boarded_at);
    const start = day(r['Start Date']);
    // Re-hire guard: a record that pre-dates the person's own Start Date belongs
    // to a previous stint (or a predecessor) and is not evidence about this row.
    const usable = Boolean(rec) && Boolean(offDate) && (!start || offDate > start);
    if (usable) {
      leavers.push({ ...r, person, stamp_at: offDate, stamp_reason: String(rec!.off_boarded_reason ?? 'Resigned') });
    } else {
      review.push({ ...r, person, why: rec ? 'record does not post-date Start Date' : 'no departure record' });
    }
  }

  const COLS = ['id', 'Name', 'Work Email', 'Personal Email', 'Department', 'Start Date', 'last_seen_upload_id', 'person'];
  writeFileSync(`${OUT}/1-corpses.csv`, csv(corpses, [...COLS, 'verdict']));
  writeFileSync(`${OUT}/2-leavers.csv`, csv(leavers, [...COLS, 'stamp_at', 'stamp_reason']));
  writeFileSync(`${OUT}/3-live-missing-from-hr-screen.csv`, csv(liveMissing, [...COLS, 'last_paid']));
  writeFileSync(`${OUT}/4-needs-hr-review.csv`, csv(review, [...COLS, 'why']));
  writeFileSync(
    `${OUT}/revert-plan.csv`,
    csv(
      [...corpses, ...leavers].map((r) => ({
        id: r.id,
        prior_off_boarded_at: r.off_boarded_at ?? '',
        prior_off_boarded_reason: r.off_boarded_reason ?? '',
        prior_off_boarded_by: r.off_boarded_by ?? '',
        prior_off_boarded_note: r.off_boarded_note ?? '',
      })),
      ['id', 'prior_off_boarded_at', 'prior_off_boarded_reason', 'prior_off_boarded_by', 'prior_off_boarded_note'],
    ),
  );

  const people = (rows: Record<string, unknown>[]) => new Set(rows.map((r) => String(r.person))).size;
  console.log('\n--- plan ---');
  console.log(`  1 corpses (duplicate_cleanup)     rows=${corpses.length}  people=${people(corpses)}`);
  console.log(`  2 leavers (real offboard date)    rows=${leavers.length}  people=${people(leavers)}`);
  console.log(`  3 LIVE, missing from HR screen    rows=${liveMissing.length}  people=${people(liveMissing)}   <- NO WRITE, hand to HR`);
  console.log(`  4 needs HR review                 rows=${review.length}  people=${people(review)}   <- NO WRITE`);
  console.log(`\n  untouched (on the HR screen)      rows=${active.filter((r) => r.last_seen_upload_id === CUR).length}`);
  console.log(`  already offboarded                rows=${gml.length - active.length}`);

  if (!APPLY) {
    console.log('\nrehearsal only — nothing written. Re-run with --apply to perform it.');
    return;
  }

  console.log('\napplying...');
  const stamp = new Date().toISOString();
  let done = 0;
  for (const r of corpses) {
    await retry(() =>
      s
        .from('global_master_list')
        .update({
          off_boarded_at: stamp,
          off_boarded_reason: 'duplicate_cleanup',
          off_boarded_by: ACTOR,
          off_boarded_note: `transfer leftover; the person is active on upload ${CUR}`,
        })
        .eq('id', r.id)
        .is('off_boarded_at', null) // never re-stamp a row someone else just stamped
        .select('id') as never,
    );
    done++;
    if (done % 50 === 0) console.log(`  corpses ${done}/${corpses.length}`);
  }
  console.log(`  corpses stamped: ${done}`);

  let ldone = 0;
  for (const r of leavers) {
    await retry(() =>
      s
        .from('global_master_list')
        .update({
          off_boarded_at: r.stamp_at,
          off_boarded_reason: r.stamp_reason,
          off_boarded_by: ACTOR,
          off_boarded_note: 'stamped from offboarded_sheet during the 2026-09-21 GML reconcile',
        })
        .eq('id', r.id)
        .is('off_boarded_at', null)
        .select('id') as never,
    );
    ldone++;
    if (ldone % 50 === 0) console.log(`  leavers ${ldone}/${leavers.length}`);
  }
  console.log(`  leavers stamped: ${ldone}`);

  const after = await paged('global_master_list', 'id,off_boarded_at,last_seen_upload_id');
  const activeAfter = after.filter((r) => !r.off_boarded_at);
  const viewAfter = activeAfter.filter((r) => r.last_seen_upload_id === CUR);
  console.log(`\nafter: active rows ${activeAfter.length} · on current upload ${viewAfter.length} · gap ${activeAfter.length - viewAfter.length}`);
  console.log(`revert plan: ${OUT}/revert-plan.csv`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
