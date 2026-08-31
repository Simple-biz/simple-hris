/**
 * READ-ONLY: who is really in Payment Catalog -> Pay Structure -> "No department",
 * and does each of them belong there?
 *
 * The bucket is not a department. It is the residue of `railKeyForCell`: every
 * active-roster person whose `global_master_list` Department cell resolves to no
 * rail entry (see src/lib/payment-catalog/dept-rail.ts). Kane's report is that it
 * reads as "USEE" — so the question is which of these people are genuinely
 * off-channel US employees and which are there because of a bad cell, a stale
 * duplicate master row, or a department the rail cannot render.
 *
 * Reproduces the tab exactly: same view (`active_employees`), same dedupe
 * (`buildRoster`), same rail (built-ins + HSL subs + registry), same assignment
 * function. Then goes BACK to global_master_list for every row each person owns,
 * so a second row carrying a real department shows up as the finding.
 *
 * STRICTLY READ-ONLY. No insert / update / delete / upsert.
 *
 *   npx tsx scripts/audit-pay-structure-no-department.mts
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import type { DeptRailEntry } from '@/lib/payment-catalog/dept-rail';

/** The app's own modules transpile to CJS under tsx, so their named exports
 *  arrive on `default` when this ESM script imports them. One unwrap, in one
 *  place, so the audit runs the SHIPPED functions rather than a copy of them. */
async function load<T = Record<string, unknown>>(spec: string): Promise<T> {
  const mod = (await import(spec)) as Record<string, unknown>;
  const ns = (mod.default ?? mod) as Record<string, unknown>;
  return (Object.keys(ns).length ? ns : mod) as T;
}

const { overrideDeptLabel } = await load<{
  overrideDeptLabel: (d: string | null, w: string | null, p: string | null, a1: string | null, a2: string | null) => string | null;
}>('@/lib/departments/dept-email-overrides');
const { DEPARTMENTS } = await load<{ DEPARTMENTS: { key: string; name: string }[] }>(
  '@/lib/payroll/department-bonus',
);
const { hslSubDeptOptions } = await load<{ hslSubDeptOptions: () => { value: string; label: string }[] }>(
  '@/lib/departments/hsl-subdept',
);
const { subDeptStructureKey } = await load<{ subDeptStructureKey: (p: string, s: string) => string }>(
  '@/lib/departments/registry',
);
const { buildDeptRail, assignRosterToRail, RAIL_NO_DEPARTMENT_KEY } = await load<{
  buildDeptRail: (entries: DeptRailEntry[]) => unknown[];
  assignRosterToRail: <T>(roster: readonly T[], rail: readonly unknown[]) => Map<string, T[]>;
  RAIL_NO_DEPARTMENT_KEY: string;
}>('@/lib/payment-catalog/dept-rail');

dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (.env.local)');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

const PAGE = 1000;
async function paged<T>(
  run: (from: number) => Promise<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await run(from);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const lc = (s: unknown) => String(s ?? '').trim().toLowerCase();

type ActiveRow = {
  id?: string | null;
  Name?: string | null;
  Department?: string | null;
  'Work Email'?: string | null;
  'Personal Email'?: string | null;
  'Alternate Work Email'?: string | null;
  'Alternate Work Email 2'?: string | null;
  'Start Date'?: string | null;
  off_boarded_at?: string | null;
  off_boarded_reason?: string | null;
  last_seen_upload_id?: string | null;
};

async function main() {
  // 1. The roster the tab renders: active_employees, mapped like getEmployees().
  const active = await paged<ActiveRow>((from) =>
    sb
      .from('active_employees')
      .select(
        'id, "Name", "Department", "Work Email", "Personal Email", "Alternate Work Email", "Alternate Work Email 2", "Start Date", off_boarded_at',
      )
      .order('Name', { ascending: true })
      .range(from, from + PAGE - 1),
  );

  // buildRoster(): first row per email wins, work email preferred as identity.
  const seen = new Set<string>();
  const roster: { email: string; name: string; department: string; work: string; personal: string }[] = [];
  for (const r of active) {
    const work = lc(r['Work Email']);
    const personal = lc(r['Personal Email']);
    const email = work || personal;
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const dept = overrideDeptLabel(
      r.Department != null ? String(r.Department) : null,
      r['Work Email'] != null ? String(r['Work Email']) : null,
      r['Personal Email'] != null ? String(r['Personal Email']) : null,
      r['Alternate Work Email'] != null ? String(r['Alternate Work Email']) : null,
      r['Alternate Work Email 2'] != null ? String(r['Alternate Work Email 2']) : null,
    );
    roster.push({
      email,
      name: String(r.Name || email).trim(),
      department: String(dept || '').trim(),
      work,
      personal,
    });
  }

  // 2. The rail: built-ins + HSL sub-teams + the in-app registry, + the sentinel.
  const setting = await sb
    .from('app_settings')
    .select('value')
    .eq('key', 'payment_catalog.departments.registry')
    .maybeSingle();
  let registry: { key: string; name: string; subDepartments: { key: string; name: string }[] }[] = [];
  if (!setting.error && setting.data?.value) {
    const rawValue = setting.data.value as unknown;
    const raw = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
    if (Array.isArray(raw)) {
      registry = raw
        .filter((e: unknown) => e && typeof e === 'object')
        .map((e: Record<string, unknown>) => ({
          key: String(e.key ?? '').trim(),
          name: String(e.name ?? '').trim(),
          subDepartments: (Array.isArray(e.subDepartments) ? e.subDepartments : [])
            .map((s: Record<string, unknown>) => ({
              key: String(s?.key ?? '').trim(),
              name: String(s?.name ?? '').trim(),
            }))
            .filter((s: { key: string; name: string }) => s.key && s.name),
        }))
        .filter((e: { key: string; name: string }) => e.key && e.name);
    }
  }
  const builtin = new Set(DEPARTMENTS.map((d) => d.key));
  const customDepartments = registry
    .filter((e) => !builtin.has(e.key))
    .flatMap((e) => [
      { key: e.key, name: e.name },
      ...e.subDepartments.map((s) => ({
        key: subDeptStructureKey(e.key, s.key),
        name: `${e.name} — ${s.name}`,
      })),
    ]);
  const railEntries: DeptRailEntry[] = [
    ...DEPARTMENTS.map((d) => ({ key: d.key, name: d.name })),
    ...hslSubDeptOptions().map((o) => ({ key: o.value, name: o.label })),
    ...customDepartments,
    { key: RAIL_NO_DEPARTMENT_KEY, name: 'No department' },
  ];
  const rail = buildDeptRail(railEntries) as unknown[];
  const byKey = assignRosterToRail(roster, rail);
  const noDept = byKey.get(RAIL_NO_DEPARTMENT_KEY) ?? [];

  console.log(`active_employees rows: ${active.length}`);
  console.log(`roster after dedupe:   ${roster.length}`);
  console.log(`rail entries:          ${railEntries.length} (registry: ${registry.length})`);
  console.log(`NO DEPARTMENT bucket:  ${noDept.length}\n`);

  const byLabel = new Map<string, typeof noDept>();
  for (const p of noDept) {
    const label = p.department || '(blank)';
    const arr = byLabel.get(label);
    if (arr) arr.push(p);
    else byLabel.set(label, [p]);
  }
  const siteBuilding = (byKey.get('site_building') ?? []).length;
  console.log(`Site Building rail entry holds: ${siteBuilding} member(s)`);
  console.log('');
  console.log('-- unresolved department cells ------------------------------');
  for (const [label, people] of [...byLabel].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(people.length).padStart(3)}  ${label}`);
  }

  // 3. Every global_master_list row each of these people owns — the cross-check.
  const emails = new Set(noDept.flatMap((p) => [p.work, p.personal].filter(Boolean)));
  const master = await paged<ActiveRow>((from) =>
    sb
      .from('global_master_list')
      .select(
        'id, "Name", "Department", "Work Email", "Personal Email", "Start Date", off_boarded_at, off_boarded_reason, last_seen_upload_id',
      )
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1),
  );
  const currentUpload = await sb
    .from('master_list_uploads')
    .select('id, uploaded_at, is_current')
    .eq('is_current', true)
    .maybeSingle();
  const currentUploadId = (currentUpload.data?.id as string | undefined) ?? null;

  const rowsByEmail = new Map<string, ActiveRow[]>();
  for (const r of master) {
    for (const em of [lc(r['Work Email']), lc(r['Personal Email'])]) {
      if (!em || !emails.has(em)) continue;
      const arr = rowsByEmail.get(em);
      if (arr) arr.push(r);
      else rowsByEmail.set(em, [r]);
    }
  }

  console.log('\n-- each person, and every master-list row they own ----------');
  console.log(`(current upload id: ${currentUploadId ?? 'unknown'})\n`);
  const conflicts: string[] = [];
  const sorted = [...noDept].sort(
    (a, b) => (a.department || '').localeCompare(b.department || '') || a.name.localeCompare(b.name),
  );
  for (const p of sorted) {
    const rows = [
      ...new Map(
        [...(rowsByEmail.get(p.work) ?? []), ...(rowsByEmail.get(p.personal) ?? [])].map((r) => [r.id, r]),
      ).values(),
    ];
    console.log(`${p.name}  <${p.email}>`);
    console.log(`   shown as: "${p.department || '(blank)'}"`);
    for (const r of rows) {
      const live = Boolean(r.last_seen_upload_id && currentUploadId && r.last_seen_upload_id === currentUploadId);
      const flags = [
        live ? 'ACTIVE' : 'stale',
        r.off_boarded_at
          ? `offboarded ${String(r.off_boarded_at).slice(0, 10)}${r.off_boarded_reason ? ` (${r.off_boarded_reason})` : ''}`
          : null,
      ]
        .filter(Boolean)
        .join(', ');
      console.log(
        `     - "${r.Department ?? ''}"  start=${r['Start Date'] ?? '-'}  [${flags}]  work=${r['Work Email'] ?? '-'}`,
      );
    }
    const liveDepts = [
      ...new Set(
        rows
          .filter((r) => r.last_seen_upload_id && currentUploadId && r.last_seen_upload_id === currentUploadId)
          .map((r) => String(r.Department ?? '').trim())
          .filter(Boolean),
      ),
    ];
    if (liveDepts.length > 1) {
      conflicts.push(
        `${p.name} <${p.email}>: ${liveDepts.length} ACTIVE master rows, different departments - ${liveDepts
          .map((d) => `"${d}"`)
          .join(', ')}`,
      );
    }
    console.log('');
  }

  if (conflicts.length) {
    console.log('-- conflicting active rows ---------------------------------');
    for (const f of conflicts) console.log(`  ! ${f}`);
  }

  // 4. Does the label match the behaviour? "USEE" and the Site Building
  //    freelancer cohorts both mean OFF-CHANNEL: no Hubstaff tracking, no PHP
  //    rate, no dispatch. Someone carrying that evidence is mislabeled, and
  //    that is the "doesn't belong" the bucket cannot show on its own.
  const hours = await paged<{ Email?: string | null; Member?: string | null; 'Total worked'?: string | null; source_file?: string | null }>(
    (from) =>
      sb
        .from('hubstaff_hours')
        .select('"Email", "Member", "Total worked", source_file')
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1),
  );
  // A hubstaff_hours ROW proves nothing: the weekly CSV lists every org member,
  // most of them at 00:00:00. Only WORKED TIME separates a tracked worker from a
  // seat that merely exists in the directory.
  const workedHours = (raw: string | null | undefined): number => {
    if (!raw) return 0;
    const parts = String(raw).split(':');
    return (parseFloat(parts[0] ?? '0') || 0) + (parseFloat(parts[1] ?? '0') || 0) / 60 + (parseFloat(parts[2] ?? '0') || 0) / 3600;
  };
  // The rates sheet keeps a row per sync, so one person owns dozens; `upload_id`
  // is null on most of them, so NEWEST BY `updated_at` is the only usable "what
  // does the sheet say today".
  const rates = await paged<{ 'Work Email'?: string | null; 'Personal Email'?: string | null; 'Regular Rate'?: string | null; Department?: string | null; updated_at?: string | null }>(
    (from) =>
      sb
        .from('employee_hourly_rates')
        .select('"Work Email", "Personal Email", "Regular Rate", "Department", updated_at')
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1),
  );
  const dispatches = await paged<{ recipient_email?: string | null; sent_date?: string | null; amount_php?: number | null; status?: string | null }>(
    (from) =>
      sb
        .from('payment_dispatches')
        .select('recipient_email, sent_date, amount_php, status')
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1),
  );
  const structures = await paged<{ id?: string; scope?: string | null; employee_email?: string | null; employee_name?: string | null; regular_rate?: number | null; currency?: string | null; department_key?: string | null }>(
    (from) =>
      sb
        .from('payment_catalog_pay_structures')
        .select('id, scope, employee_email, employee_name, regular_rate, currency, department_key')
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1),
  );
  // The DB is snake_case; `homeKeyForStructure` reads the app's camelCase
  // `PayStructure`. Mapping is not cosmetic here — an unmapped row looks like it
  // has no owner at all, and every single one would "resolve" to No department.
  const asPayStructure = (r: (typeof structures)[number]) => ({
    id: String(r.id ?? ''),
    scope: String(r.scope ?? ''),
    departmentKey: String(r.department_key ?? ''),
    employeeEmail: r.employee_email ?? undefined,
    employeeName: r.employee_name ?? undefined,
    regularRate: Number(r.regular_rate ?? 0),
    currency: String(r.currency ?? 'PHP'),
  });

  const index = <T,>(rows: T[], keys: (r: T) => (string | null | undefined)[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      for (const k of keys(r)) {
        const kk = lc(k);
        if (!kk) continue;
        const arr = m.get(kk);
        if (arr) arr.push(r);
        else m.set(kk, [r]);
      }
    }
    return m;
  };
  const hoursBy = index(hours, (r) => [r.Email]);
  const ratesBy = index(rates, (r) => [r['Work Email'], r['Personal Email']]);
  const dispBy = index(dispatches, (r) => [r.recipient_email]);
  const structBy = index(structures, (r) => [r.employee_email]);

  console.log('');
  console.log('-- off-channel claim vs. the evidence -----------------------');
  console.log('(a USEE / Site-Building-freelancer row with hours, a PHP rate or a');
  console.log(' dispatch is a label that does not match how the person is paid)');
  console.log('');
  let flagged = 0;
  let flaggedShown = 0;
  for (const p of sorted) {
    const keys = [p.work, p.personal].filter(Boolean);
    const h = keys.flatMap((k) => hoursBy.get(k) ?? []);
    const ra = keys.flatMap((k) => ratesBy.get(k) ?? []);
    const d = keys.flatMap((k) => dispBy.get(k) ?? []);
    const st = keys.flatMap((k) => structBy.get(k) ?? []);
    if (h.length === 0 && ra.length === 0 && d.length === 0 && st.length === 0) continue;
    flagged += 1;
    const workedWeeks = [
      ...new Set(h.filter((r) => workedHours(r['Total worked']) > 0).map((r) => String(r.source_file ?? ''))),
    ].filter(Boolean).sort();
    const newestRate = [...ra].sort((a, b) => String(a.updated_at ?? '').localeCompare(String(b.updated_at ?? ''))).at(-1);
    const currentRateValue = Number(String(newestRate?.['Regular Rate'] ?? '0').replace(/,/g, '')) || 0;
    const everRated = [
      ...new Set(ra.map((r) => Number(String(r['Regular Rate'] ?? '0').replace(/,/g, '')) || 0).filter((n) => n > 0)),
    ];
    const lastDispatch = d
      .map((r) => String(r.sent_date ?? ''))
      .filter(Boolean)
      .sort()
      .at(-1);
    if (workedWeeks.length === 0 && currentRateValue === 0 && everRated.length === 0 && d.length === 0 && st.length === 0) {
      continue; // directory-only presence proves nothing
    }
    flaggedShown += 1;
    console.log(`${p.name}  <${p.email}>   "${p.department}"`);
    if (workedWeeks.length) {
      console.log(`   WORKED hours in ${workedWeeks.length} week file(s); latest ${workedWeeks.at(-1)}`);
    } else if (h.length) {
      console.log(`   hubstaff: listed in ${h.length} week file(s) but ZERO worked time in all of them`);
    }
    if (currentRateValue > 0) {
      console.log(`   rates sheet (newest row): ${currentRateValue} (dept cell "${newestRate?.Department ?? ''}", ${String(newestRate?.updated_at ?? '').slice(0, 10)})`);
    } else if (everRated.length) {
      console.log(`   rates sheet: 0 now, but non-zero historically (${everRated.join(', ')})`);
    }
    if (d.length) console.log(`   dispatched: ${d.length} payment(s), latest ${lastDispatch ?? '-'}`);
    if (st.length) console.log(`   catalog structure: ${st.map((r) => `${r.scope}/${r.department_key} ${r.regular_rate ?? '-'} ${r.currency ?? ''}`).join(' | ')}`);
    console.log('');
  }
  if (flaggedShown === 0) console.log('  (none - every person in the bucket is off-channel by every measure)');

  // 5. The bucket also collects RATE ROWS whose owner the roster cannot place —
  //    `homeKeyForStructure` sends an unresolvable owner here rather than let it
  //    keep its stored department key. Those are not people in a department; they
  //    are rate rows for addresses the master list no longer carries.
  const { buildStructureOwnerIndex, homeKeyForStructure } = await load<{
    buildStructureOwnerIndex: (roster: readonly { email: string; name: string; department: string; aliases: string[] }[]) => unknown;
    homeKeyForStructure: (s: unknown, owners: unknown, rail: readonly unknown[]) => string;
  }>('@/lib/payment-catalog/dept-rail');
  const ownerRoster = active
    .map((r) => {
      const work = lc(r['Work Email']);
      const personal = lc(r['Personal Email']);
      const email = work || personal;
      return {
        email,
        name: String(r.Name ?? '').trim(),
        department: String(
          overrideDeptLabel(
            r.Department != null ? String(r.Department) : null,
            r['Work Email'] != null ? String(r['Work Email']) : null,
            r['Personal Email'] != null ? String(r['Personal Email']) : null,
            r['Alternate Work Email'] != null ? String(r['Alternate Work Email']) : null,
            r['Alternate Work Email 2'] != null ? String(r['Alternate Work Email 2']) : null,
          ) ?? '',
        ).trim(),
        aliases: [work, personal, lc(r['Alternate Work Email']), lc(r['Alternate Work Email 2'])].filter(Boolean),
      };
    })
    .filter((r) => r.email);
  const owners = buildStructureOwnerIndex(ownerRoster);
  const homedHere = structures
    .filter((st) => st.scope === 'employee')
    .filter((st) => homeKeyForStructure(asPayStructure(st), owners, rail) === RAIL_NO_DEPARTMENT_KEY);
  const rosterEmails = new Set(roster.flatMap((p) => [p.work, p.personal].filter(Boolean)));
  const noDeptEmails = new Set(noDept.flatMap((p) => [p.work, p.personal].filter(Boolean)));
  const ghosts = homedHere.filter((st) => !noDeptEmails.has(lc(st.employee_email)));
  // 5b. Is anyone in the bucket actually GONE? The catalog hides a leaver only
  //     when all four guards agree (`isOffboardedForPaymentCatalog`); anyone who
  //     clears them is invisible in the tab, and anyone carrying evidence that
  //     does NOT clear them is a leaver still on display.
  const { isOffboardedForPaymentCatalog } = await load<{
    isOffboardedForPaymentCatalog: (i: {
      evidence: { offDate: string; reason: string | null } | null;
      startDate: string | null;
      cycleWeekStart: string;
      hasCycleHours: boolean;
    }) => boolean;
  }>('@/lib/payment-catalog/catalog-roster-visibility');
  const { payrollNotesWeekStart } = await load<{ payrollNotesWeekStart: (n?: Date) => string }>(
    '@/lib/payroll/manila-week',
  );
  const { normalizeMasterDate } = await load<{ normalizeMasterDate: (v: string | null) => string | null }>(
    '@/lib/roster/master-date',
  );
  const cycleWeekStart = payrollNotesWeekStart();
  const currentFile = await sb
    .from('hubstaff_uploads')
    .select('source_file')
    .eq('is_current', true)
    .maybeSingle();
  const currentSourceFile = (currentFile.data?.source_file as string | undefined) ?? null;
  const cycleEmails = new Set(
    hours.filter((h) => String(h.source_file ?? '') === currentSourceFile).map((h) => lc(h.Email)),
  );
  // Evidence, WORK-EMAIL keyed — a personal inbox is shared across duplicate
  // master identities and imports someone else's departure.
  const evidence = new Map<string, { offDate: string; reason: string | null }>();
  const note = (em: unknown, at: unknown, reason: unknown) => {
    const k = lc(em);
    const d = String(at ?? '').slice(0, 10);
    if (!k || !d) return;
    const prev = evidence.get(k);
    if (!prev || d > prev.offDate) evidence.set(k, { offDate: d, reason: reason == null ? null : String(reason) });
  };
  for (const r of master) note(r['Work Email'], r.off_boarded_at, r.off_boarded_reason);
  const sheetRows = await paged<{ work_email?: string | null; off_boarded_at?: string | null; off_boarded_reason?: string | null }>(
    (from) => sb.from('offboarded_sheet').select('work_email, off_boarded_at, off_boarded_reason').range(from, from + PAGE - 1),
  ).catch(() => []);
  for (const r of sheetRows) note(r.work_email, r.off_boarded_at, r.off_boarded_reason);
  const queueRows = await paged<{ employee_work_email?: string | null; decided_at?: string | null; reason?: string | null }>(
    (from) =>
      sb
        .from('offboarding_queue')
        .select('employee_work_email, decided_at, reason')
        .eq('status', 'completed')
        .range(from, from + PAGE - 1),
  ).catch(() => []);
  for (const r of queueRows) note(r.employee_work_email, r.decided_at, r.reason);

  const startByEmail = new Map<string, string | null>();
  for (const r of active) {
    const k = lc(r['Work Email']) || lc(r['Personal Email']);
    if (k && !startByEmail.has(k)) startByEmail.set(k, normalizeMasterDate(r['Start Date'] ?? null));
  }
  console.log('');
  console.log('-- leaver check ---------------------------------------------');
  console.log(`  pay week being processed: ${cycleWeekStart}; timesheet: ${currentSourceFile ?? 'unknown'}`);
  let hidden = 0;
  let lingering = 0;
  for (const p of sorted) {
    const ev = evidence.get(p.work) ?? null;
    if (!ev) continue;
    const hasCycleHours = cycleEmails.has(p.work) || cycleEmails.has(p.personal);
    const isHidden = isOffboardedForPaymentCatalog({
      evidence: ev,
      startDate: startByEmail.get(p.email) ?? null,
      cycleWeekStart,
      hasCycleHours,
    });
    if (isHidden) hidden += 1;
    else lingering += 1;
    console.log(
      `  ${isHidden ? 'HIDDEN ' : 'SHOWN  '} ${p.name} <${p.email}> "${p.department}" - off ${ev.offDate}` +
        ` (${ev.reason ?? 'no reason'})${hasCycleHours ? ', in this cycle timesheet' : ''}`,
    );
  }
  console.log(`  => ${hidden} hidden from the tab, ${lingering} carrying evidence but still shown`);
  console.log(`  => the bucket the tab actually renders: ${noDept.length - hidden} people`);

  console.log('');
  console.log('-- rate rows the bucket also holds -------------------------');
  console.log(`  employee pay structures homed to "No department": ${homedHere.length}`);
  console.log(`    of which belong to someone LISTED in the bucket: ${homedHere.length - ghosts.length}`);
  console.log(`    of which belong to NOBODY the roster can place:  ${ghosts.length}`);
  for (const g of ghosts) {
    const onRoster = rosterEmails.has(lc(g.employee_email)) ? 'on roster, unplaceable dept' : 'NOT on the active roster';
    console.log(`      - ${g.employee_name ?? '?'} <${g.employee_email}>  filed under ${g.department_key}  ${g.regular_rate ?? '-'} ${g.currency ?? ''}  (${onRoster})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
