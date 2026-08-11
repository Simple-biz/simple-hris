/**
 * Make the legacy rates-sheet routing EXPLICIT so the WIRES-lock guard can be
 * switched on without stranding anyone.
 *
 *   node --import tsx scripts/seed-legacy-cell-rail-then-guard.mts            # dry run (default)
 *   node --import tsx scripts/seed-legacy-cell-rail-then-guard.mts --apply    # writes
 *
 * ## Why this exists
 *
 * Payment Dispatch resolves the send-from rail as
 *   employee_ids.bank_preferred -> employee_ids.preferred_processor
 *     -> employee_hourly_rates."Bank Preferred"   (legacy free-text sheet cell)
 *
 * The WIRES lock (bank-preferred-routing.md §4) says a person whose stored
 * `bank_preferred` is null IS wires-preferred and can never be moved to
 * hurupay/higlobe. But for exactly those people, a sheet cell reading "Hurupay"
 * routes them to Hurupay anyway (§2's "known gap"). Guarding the READ looked
 * like the fix until it was measured: all 22 affected active people have NO
 * wire details in either bank slot, and 16 of them are being paid perfectly
 * well on the wallet rail today. A read guard would make all 22 `no_bank`.
 *
 * So: record the rail they are ALREADY on, then guard. After this runs, the
 * legacy cell is no longer load-bearing for these people -- their rail is
 * stored explicitly, tier 1 -- and the guard can refuse the cell without
 * changing where a single peso goes.
 *
 * ## This deliberately writes values the WIRES lock would REJECT as a live
 * ## transition, and that is the point
 *
 * `isBankPreferredTransitionAllowed(null, 'hurupay')` is false. This is not a
 * transition: nobody's rail changes. It reconciles the STORED value with the
 * rail Payment Dispatch already resolves and already pays on. Two hard rules
 * keep it honest:
 *
 *   1. It only ever writes the person's own CURRENT EFFECTIVE rail, computed
 *      with the exact precedence above. It never invents or infers a rail.
 *   2. It REFUSES anyone whose stored `bank_preferred` is already non-null.
 *      Overwriting a stored value WOULD be a transition, and the lock owns it.
 *
 * It also never touches a receiving account -- see the three-column warning at
 * the top of bank-preferred-routing.md. Only `bank_preferred` is written.
 *
 * ## Safety
 *
 * - Dry run by default. `--apply` is required to write anything.
 * - A SELECT backup of every row it would touch is written to disk BEFORE any
 *   write (CLAUDE.md), to references/backups/ (gitignored).
 * - Refuses to write if the backup cannot be written.
 * - Skips anyone with no `employee_ids` row: bootstrapping a row is a bigger
 *   decision than this script should make on its own. They are reported.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase();

/** Byte-for-byte `processorIdFromBankPreferredText` (employee-payment-processors.ts:62). */
function processorIdFromText(raw: unknown): string | null {
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  if (!v) return null;
  if (v === 'hurupay' || v === 'huru' || v === 'huropay') return 'hurupay';
  if (v === 'wepay') return 'wepay';
  if (v === 'higlobe' || v === 'higloble' || v === 'higlobel') return 'higlobe';
  if (v === 'wise' || v === 'transferwise') return 'wise';
  if (v === 'jeeves') return 'jeeves';
  if (/^x?\d{3,5}$/.test(v) || v === 'wire' || v === 'wires' || v.startsWith('wire')) return 'wires';
  return null;
}

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

interface Target {
  workEmail: string;
  matchedOn: string;
  rail: 'hurupay' | 'higlobe';
  cell: string;
  active: boolean;
}

async function main(): Promise<void> {
  console.log(`=== Seed the legacy-cell rail into employee_ids.bank_preferred ===`);
  console.log(APPLY ? 'MODE: --apply (WILL WRITE)\n' : 'MODE: dry run (no writes)\n');

  const ids = await selectAllPaged<Record<string, unknown>>(
    'employee_ids',
    'work_email,personal_email,bank_preferred,preferred_processor',
  );
  const idsByEmail = new Map<string, Record<string, unknown>>();
  for (const r of ids) {
    for (const col of ['work_email', 'personal_email']) {
      const em = norm(r[col]);
      if (em && !idsByEmail.has(em)) idsByEmail.set(em, r);
    }
  }

  const rates = await selectAllPaged<Record<string, unknown>>('employee_hourly_rates', '*');
  const field = (row: Record<string, unknown>, names: string[]): unknown => {
    const idx = new Map<string, unknown>();
    for (const [k, v] of Object.entries(row)) idx.set(k.trim().toLowerCase().replace(/\s+/g, ' '), v);
    for (const n of names) {
      const hit = idx.get(n.trim().toLowerCase().replace(/\s+/g, ' '));
      if (hit != null && String(hit).trim() !== '') return hit;
    }
    return null;
  };

  const active = await selectAllPaged<Record<string, unknown>>(
    'active_employees',
    '"Work Email","Personal Email"',
  );
  const activeEmails = new Set<string>();
  for (const r of active) {
    for (const col of ['Work Email', 'Personal Email']) {
      const em = norm(r[col]);
      if (em) activeEmails.add(em);
    }
  }

  const targets: Target[] = [];
  const noIdsRow: string[] = [];
  const seen = new Set<string>();

  for (const r of rates) {
    const email = norm(field(r, ['Work Email', 'work_email'])) || norm(field(r, ['Personal Email', 'personal_email']));
    if (!email || seen.has(email)) continue;
    seen.add(email);

    const cellRaw = field(r, ['Bank Preferred', 'bank_preferred', 'Bank preferred', 'BankPreferred']);
    const rail = processorIdFromText(cellRaw);
    // Only the two rails the WIRES lock forbids need to be made explicit. wise /
    // jeeves / wires / wepay keep resolving through the cell untouched, because
    // the guard will not block them.
    if (rail !== 'hurupay' && rail !== 'higlobe') continue;

    const idRow = idsByEmail.get(email);
    if (!idRow) {
      noIdsRow.push(email);
      continue;
    }

    // RULE 2: a stored value is the lock's business, never this script's.
    const stored = norm(idRow['bank_preferred']);
    if (stored) continue;
    // A Disbursement pick already outranks the cell, so the cell is not
    // load-bearing for them and the guard cannot strand them.
    if (norm(idRow['preferred_processor'])) continue;

    targets.push({
      workEmail: norm(idRow['work_email']) || email,
      matchedOn: email,
      rail,
      cell: String(cellRaw ?? '').trim(),
      active: activeEmails.has(email),
    });
  }

  const activeCount = targets.filter((t) => t.active).length;
  console.log(`Rows to seed: ${targets.length}  (${activeCount} on the active roster)`);
  const byRail = new Map<string, number>();
  for (const t of targets) byRail.set(t.rail, (byRail.get(t.rail) ?? 0) + 1);
  for (const [rail, n] of byRail) console.log(`  ${String(n).padStart(4)}  -> ${rail}`);
  if (noIdsRow.length) {
    console.log(
      `\nSKIPPED — no employee_ids row (bootstrapping one is not this script's call): ${noIdsRow.length}`,
    );
    for (const e of noIdsRow.slice(0, 10)) console.log(`  ${e}`);
    if (noIdsRow.length > 10) console.log(`  … and ${noIdsRow.length - 10} more`);
    console.log('  NOTE: the guard WILL strand these people. Decide them before switching it on.');
  }

  if (targets.length === 0) {
    console.log('\nNothing to do.');
    return;
  }

  // ── SELECT backup FIRST, always, before any write (CLAUDE.md) ──────────────
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const backupPath = join('references', 'backups', `${stamp}_bank_preferred_legacy_cell_seed.csv`);
  const header = 'work_email,matched_on,bank_preferred_before,bank_preferred_after,sheet_cell,active\n';
  const body = targets
    .map((t) => `${t.workEmail},${t.matchedOn},,${t.rail},"${t.cell.replace(/"/g, '""')}",${t.active}`)
    .join('\n');
  try {
    mkdirSync(dirname(backupPath), { recursive: true });
    writeFileSync(backupPath, header + body + '\n', 'utf8');
    console.log(`\nBackup written: ${backupPath}  (${targets.length} rows)`);
  } catch (e) {
    console.error(`\nREFUSING TO WRITE — backup failed: ${String(e)}`);
    process.exit(1);
  }

  console.log('\nFirst 20:');
  console.log(`  ${'work_email'.padEnd(34)} ${'before'.padEnd(8)} ${'after'.padEnd(8)} cell`);
  for (const t of targets.slice(0, 20)) {
    console.log(`  ${t.workEmail.padEnd(34)} ${'(null)'.padEnd(8)} ${t.rail.padEnd(8)} ${t.cell}`);
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to seed ${targets.length} rows.`);
    return;
  }

  let ok = 0;
  const failed: { email: string; error: string }[] = [];
  for (const t of targets) {
    // Re-check the stored value at write time: another session shares this
    // database, and a value that appeared between the read and now belongs to
    // the lock, not to this script.
    const { data: live, error: readErr } = await db
      .from('employee_ids')
      .select('bank_preferred')
      .eq('work_email', t.workEmail)
      .maybeSingle();
    if (readErr) {
      failed.push({ email: t.workEmail, error: `recheck: ${readErr.message}` });
      continue;
    }
    if (live && norm((live as Record<string, unknown>)['bank_preferred'])) {
      failed.push({ email: t.workEmail, error: 'stored value appeared since the read — skipped' });
      continue;
    }
    const { error } = await db
      .from('employee_ids')
      .update({ bank_preferred: t.rail })
      .eq('work_email', t.workEmail)
      .is('bank_preferred', null);
    if (error) failed.push({ email: t.workEmail, error: error.message });
    else ok += 1;
  }

  console.log(`\nAPPLIED: ${ok} seeded, ${failed.length} failed/skipped`);
  for (const f of failed.slice(0, 20)) console.log(`  ${f.email}: ${f.error}`);
  console.log(`\nBackup for rollback: ${backupPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
