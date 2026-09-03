/**
 * Backfill `paystub.recovered.<sourceFile>` snapshots for every Hubstaff upload
 * week that has NEITHER a wizard `payroll.wizard.final_pay.*` snapshot NOR a
 * staged `paystub_dispatch_queue` payload — the pre-launch weeks the employee
 * Pay Stubs tab otherwise reconstructs with a whole-company engine run
 * (~6.6 s per week, per viewer, per open).
 *
 * What it writes, and what it NEVER writes
 *   - Writes ONLY keys under `paystub.recovered.` (asserted before every upsert).
 *   - NEVER touches `payroll.wizard.final_pay.*` — that key means "what the wizard
 *     computed on the day" and prices Payment Dispatch; an engine run from today's
 *     rates is not that. See src/lib/payroll/paystub-recovered.ts.
 *   - Each snapshot is stamped with the file's CURRENT `hubstaff_uploads.id`; the
 *     route ignores it the moment that batch changes (re-upload).
 *
 * Usage (READ-ONLY dry run by default — prints the plan, writes nothing):
 *   node --import tsx scripts/backfill-paystub-recovered-snapshots.mts
 *   node --import tsx scripts/backfill-paystub-recovered-snapshots.mts --apply
 *   node --import tsx scripts/backfill-paystub-recovered-snapshots.mts --file <name> [--file <name>]
 *   --force   also recompute weeks that already have a snapshot for the current batch
 *
 * --apply first writes a SELECT backup of every existing `paystub.recovered.*` row
 * to references/backups/, then upserts. Reversal = delete the written keys (the
 * backup names them); nothing else in the database is changed.
 */
import dotenv from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

dotenv.config({ path: ".env.local" });
dotenv.config();

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const ONLY_FILES = process.argv
  .map((a, i, all) => (a === "--file" ? all[i + 1] : null))
  .filter((f): f is string => !!f);

const { computeCurrentPay } = await import("../src/lib/payroll/current-pay");
const { listHubstaffUploads } = await import("../src/lib/supabase/hubstaff-hours-db");
const { getAppSettings, upsertAppSetting } = await import("../src/lib/supabase/app-settings");
const { getEmployees } = await import("../src/lib/supabase/employees");
const { createSupabaseServiceRoleClient } = await import("../src/lib/supabase/server");
const { buildRecoveredSnapshot, recoveredSnapshotKey, RECOVERED_SNAPSHOT_PREFIX } = await import(
  "../src/lib/payroll/paystub-recovered"
);
const { finalPaySnapshotKey } = await import("../src/lib/payroll/paystub-fresh");
const { normEmail } = await import("../src/lib/email/norm-email");

const supabase = createSupabaseServiceRoleClient();
if (!supabase) throw new Error("Supabase service-role client unavailable — check .env.local");

const log = (...a: unknown[]) => console.log(...a);
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── 1. Upload archive: files + current batch id (is_current first, then newest) ──
const uploads = await listHubstaffUploads();
const files: string[] = [];
const uploadIdByFile = new Map<string, string>();
for (const u of uploads) {
  if (!u.source_file) continue;
  if (!uploadIdByFile.has(u.source_file)) {
    files.push(u.source_file);
    uploadIdByFile.set(u.source_file, u.id);
  } else if (u.is_current) {
    uploadIdByFile.set(u.source_file, u.id);
  }
}

// ── 2. Staged weeks (paged — a cycle stages 1,000+ rows) ──
const stagedFiles = new Set<string>();
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from("paystub_dispatch_queue")
    .select("cycle_source_file")
    .order("cycle_source_file", { ascending: true })
    .range(from, from + 999);
  if (error) throw new Error(`paystub_dispatch_queue: ${error.message}`);
  for (const r of data ?? []) {
    const f = (r as { cycle_source_file?: string | null }).cycle_source_file;
    if (f) stagedFiles.add(f);
  }
  if (!data || data.length < 1000) break;
}

// ── 3. Existing snapshots + additions blobs, one round-trip ──
const additionsKey = (f: string) => `payroll.wizard.additions.${f}`;
const settings = await getAppSettings(
  files.flatMap((f) => [finalPaySnapshotKey(f), recoveredSnapshotKey(f), additionsKey(f)]),
);

// ── 4. Candidates ──
type Plan = { file: string; uploadId: string; reason: string };
const plan: Plan[] = [];
const skipped: Array<{ file: string; why: string }> = [];
for (const f of files) {
  if (ONLY_FILES.length && !ONLY_FILES.includes(f)) continue;
  if (settings[finalPaySnapshotKey(f)]) {
    skipped.push({ file: f, why: "wizard final_pay snapshot exists" });
    continue;
  }
  if (stagedFiles.has(f)) {
    skipped.push({ file: f, why: "staged payload exists" });
    continue;
  }
  const uploadId = uploadIdByFile.get(f);
  if (!uploadId) {
    skipped.push({ file: f, why: "no hubstaff_uploads batch id — cannot stamp" });
    continue;
  }
  const existingRaw = settings[recoveredSnapshotKey(f)];
  if (existingRaw && !FORCE) {
    try {
      const existing = JSON.parse(existingRaw) as { upload_id?: string | null };
      if (existing.upload_id === uploadId) {
        skipped.push({ file: f, why: "recovered snapshot already current for this batch" });
        continue;
      }
      plan.push({
        file: f,
        uploadId,
        reason: `stale snapshot (batch ${existing.upload_id ?? "?"} -> ${uploadId})`,
      });
      continue;
    } catch {
      /* unparseable -> recompute */
    }
  }
  plan.push({ file: f, uploadId, reason: existingRaw ? "forced recompute" : "no snapshot" });
}

log(
  `Upload weeks: ${files.length} | staged: ${stagedFiles.size} | to compute: ${plan.length} | skipped: ${skipped.length}`,
);
for (const s of skipped) log(`  skip  ${s.file}  -- ${s.why}`);
if (plan.length === 0) {
  log("Nothing to do.");
  process.exit(0);
}

// ── 5. Alias map (work -> personal + alternates) so the additions blob matches ──
const { employees } = await getEmployees();
const aliases = new Map<string, string[]>();
for (const e of employees ?? []) {
  const work = normEmail(e.work_email ?? "");
  if (!work) continue;
  const others = [e.personal_email, e.alternate_work_email, e.alternate_work_email_2]
    .map((x) => normEmail(x ?? ""))
    .filter((x): x is string => !!x && x !== work);
  aliases.set(work, [...new Set([...(aliases.get(work) ?? []), ...others])]);
}
const aliasesOf = (work: string) => aliases.get(work) ?? [];

// ── 6. Engine runs (sequential — each is a whole-company computation) ──
const built: Array<{ key: string; value: string; file: string; people: number; totalPhp: number; ms: number }> = [];
for (const p of plan) {
  const t0 = Date.now();
  const result = await computeCurrentPay({ sourceFile: p.file });
  const snapshot = buildRecoveredSnapshot({
    result,
    sourceFile: p.file,
    uploadId: p.uploadId,
    computedAt: new Date(),
    additionsRaw: settings[additionsKey(p.file)] ?? null,
    aliasesOf,
  });
  const people = Object.keys(snapshot.finals).length;
  const totalPhp = round2(Object.values(snapshot.finals).reduce((s, e) => s + e.final, 0));
  const key = recoveredSnapshotKey(p.file);
  if (!key.startsWith(RECOVERED_SNAPSHOT_PREFIX) || key.startsWith("payroll.wizard.")) {
    throw new Error(`Refusing to write outside the recovered prefix: ${key}`);
  }
  const ms = Date.now() - t0;
  built.push({ key, value: JSON.stringify(snapshot), file: p.file, people, totalPhp, ms });
  log(
    `  built ${p.file}  people=${people}  sum(final)=PHP ${totalPhp.toLocaleString("en-PH")}  fx=${snapshot.fx_rate}  ${ms}ms  (${p.reason})`,
  );
}

if (!APPLY) {
  log(`\nDRY RUN -- ${built.length} snapshot(s) built, nothing written. Re-run with --apply to write.`);
  process.exit(0);
}

// ── 7. Backup existing recovered rows, then write ──
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join("references", "backups");
mkdirSync(backupDir, { recursive: true });
const { data: existingRows, error: backupErr } = await supabase
  .from("app_settings")
  .select("key, value, updated_at")
  .like("key", `${RECOVERED_SNAPSHOT_PREFIX}%`)
  .range(0, 999);
if (backupErr) throw new Error(`Backup SELECT failed: ${backupErr.message}`);
const backupPath = path.join(backupDir, `paystub_recovered_pre_backfill_${stamp}.json`);
writeFileSync(
  backupPath,
  JSON.stringify(
    {
      taken_at: new Date().toISOString(),
      about_to_write: built.map((b) => b.key),
      rows: existingRows ?? [],
    },
    null,
    2,
  ),
);
log(`Backup written: ${backupPath} (${existingRows?.length ?? 0} existing recovered row(s))`);

let ok = 0;
for (const b of built) {
  const { error } = await upsertAppSetting(b.key, b.value);
  if (error) {
    log(`  FAILED ${b.key}: ${error}`);
    continue;
  }
  ok += 1;
  log(`  wrote ${b.key}`);
}
log(`\nDone: ${ok}/${built.length} written.`);
process.exit(ok === built.length ? 0 : 1);
