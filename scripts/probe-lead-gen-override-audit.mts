/**
 * READ-ONLY. What wrote Lead Gen's 218 applied rows for week 2026-09-06 at
 * 2026-09-14T22:08:41Z, and did a Compare override run?
 *
 * `applyOverride` logs exactly one audit row per bulk action
 * (`qc.compare_override_applied`) carrying every change it made. Its presence,
 * timing and payload distinguish two very different stories:
 *
 *   - Override ran and the save that followed materialised every UNTOUCHED
 *     member at Appts_Set 0, discarding a QC first pass that was only ever
 *     load-seeded  →  a defect in what the save persists.
 *   - No override row, or one that does not line up  →  the table was already
 *     all-zero before Carla touched it, and the QC seed never fired at all.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/probe-lead-gen-override-audit.mts
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');

const sb = createSupabaseServiceRoleClient();
if (!sb) {
  console.error('Supabase is not configured (.env.local)');
  process.exit(1);
}

const { data, error } = await sb
  .from('audit_log')
  .select('*')
  .ilike('action', '%compare_override%')
  .order('created_at', { ascending: false })
  .limit(20);

if (error) {
  console.error(`audit_log: ${error.message}`);
} else {
  console.log(`\nqc.compare_override_applied rows: ${data?.length ?? 0}`);
  for (const r of data ?? []) {
    const row = r as Record<string, unknown>;
    const d = (row.details ?? {}) as Record<string, unknown>;
    const changes = (d.changes ?? []) as Array<Record<string, unknown>>;
    console.log(`\n  ${String(row.created_at)}  ${String(row.user_name)}  ${String(row.resource_id)}`);
    console.log(`    pasted_rows=${String(d.pasted_rows)}  overridden=${String(d.overridden)}`);
    for (const c of changes.slice(0, 25)) {
      console.log(`      ${String(c.email).padEnd(32)} ${String(c.variable)}: ${String(c.from)} → ${String(c.to)}   (QC by ${String(c.scored_by)})`);
    }
    if (changes.length > 25) console.log(`      … ${changes.length - 25} more`);
  }
}

// Anything else touching this dept-week around that instant.
const { data: near, error: nearErr } = await sb
  .from('audit_log')
  .select('created_at, user_name, action, resource, resource_id')
  .gte('created_at', '2026-09-14T21:00:00Z')
  .order('created_at', { ascending: true })
  .limit(80);
if (nearErr) console.error(`\naudit_log (window): ${nearErr.message}`);
else {
  console.log(`\n── audit_log since 2026-09-14T21:00Z (${near?.length ?? 0} rows) ───────────`);
  for (const r of near ?? []) {
    const row = r as Record<string, unknown>;
    console.log(`  ${String(row.created_at)}  ${String(row.user_name).padEnd(24)} ${String(row.action).padEnd(34)} ${String(row.resource_id ?? '')}`);
  }
}

console.log('\nREAD-ONLY. Nothing was written.\n');
