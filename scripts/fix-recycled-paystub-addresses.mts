/**
 * Open item 432 (Kane ruled (b), 2026-10-09): re-point every paystub address
 * that belongs to someone who LEFT under a work email now held by someone else.
 *
 * It applies the SAME decision the code now enforces
 * (`decidePaystubDeliveryAddress`), so the data and the guard cannot disagree:
 *
 *  - `paystub_dispatch_queue`: each row is judged by the NAME on its statement.
 *    A statement named for the person who left keeps their address. Only
 *    `personal_email` and `payload.personal_email` change, together. Figures,
 *    `sent_at` and `send_count` are untouched.
 *  - `employee_hourly_rates`: `"Personal Email"` only, judged for the current
 *    holder (the next lock stages THEIR statement). Rates, phone and address
 *    are untouched. SKIPPED for an address where someone other than the
 *    current holder had a statement in the last 28 days: that leaver may still
 *    have final pay to stage, and a rate row re-pointed at the current holder
 *    would send it to them. The code guard handles those by name.
 *
 * A `withhold` verdict changes nothing here; it is listed for a human.
 * Addresses with NO active holder are out of this rule (Open item 432 residual).
 *
 * The script holds no personal email; it derives every value from the database.
 * The backup it writes does, and goes to `references/backups/` (gitignored).
 *
 *   node --import tsx scripts/fix-recycled-paystub-addresses.mts           # rehearse
 *   node --import tsx scripts/fix-recycled-paystub-addresses.mts --apply   # commit
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

process.loadEnvFile(".env.local");
const APPLY = process.argv.includes("--apply");

const { loadAddressHolders } = await import("@/lib/supabase/paystub-address-holders");
const { decidePaystubDeliveryAddress, nameKey, sameName, statementNameOf } = await import("@/lib/payroll/paystub-delivery-address");

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

type QueueRow = {
  id: string;
  recipient_email: string;
  recipient_name: string | null;
  cycle_source_file: string;
  personal_email: string | null;
  payload: Record<string, unknown> | null;
  week_start: string | null;
};
type RateRow = { id: string; work_email: string; personal_email: string | null };

const queue = (
  await db.query<QueueRow>(
    `select id, recipient_email, recipient_name, cycle_source_file, personal_email, payload,
            coalesce(payload->'pay_period'->'week'->>'start', pay_period->'week'->>'start') as week_start
       from paystub_dispatch_queue`,
  )
).rows;
const rates = (
  await db.query<RateRow>(
    `select id, "Work Email" as work_email, "Personal Email" as personal_email from employee_hourly_rates where "Work Email" is not null`,
  )
).rows;

const emails = [...new Set([...queue.map((r) => r.recipient_email), ...rates.map((r) => r.work_email)].map((e) => e.trim().toLowerCase()))];
const { holders, error } = await loadAddressHolders(emails);
if (!holders) throw new Error(`holder read failed: ${error}`);

// Addresses where someone OTHER than the current holder had a statement in the
// last 28 days: a leaver who may still have final pay to stage.
const recentCutoff = new Date(Date.now() - 28 * 86_400_000).toISOString().slice(0, 10);
const recentOtherHolder = new Set<string>();
for (const r of queue) {
  const work = r.recipient_email.trim().toLowerCase();
  const h = holders.get(work);
  if (!h || h.activeRows === 0 || !r.week_start || r.week_start < recentCutoff) continue;
  const n = nameKey(statementNameOf(r));
  if (!h.currentNames.some((c) => sameName(n, c))) recentOtherHolder.add(work);
}

type Move = { table: string; id: string; work: string; from: string; to: string; week?: string | null };
const queueMoves: Move[] = [];
const rateMoves: Move[] = [];
const withheld: Array<{ table: string; id: string; work: string; reason: string; week?: string | null }> = [];
const skippedRates = new Map<string, number>();

for (const r of queue) {
  const work = r.recipient_email.trim().toLowerCase();
  const proposed = typeof r.payload?.personal_email === "string" ? (r.payload.personal_email as string) : r.personal_email;
  const d = decidePaystubDeliveryAddress(proposed, holders.get(work), statementNameOf(r));
  if (d.kind === "replace") queueMoves.push({ table: "paystub_dispatch_queue", id: r.id, work, from: proposed!, to: d.to, week: r.week_start });
  else if (d.kind === "withhold") withheld.push({ table: "paystub_dispatch_queue", id: r.id, work, reason: d.reason, week: r.week_start });
}
for (const r of rates) {
  const work = r.work_email.trim().toLowerCase();
  const h = holders.get(work);
  // The next statement staged for this address is the current holder's.
  const currentName = h && h.currentNames.length === 1 ? h.currentNames[0].join(" ") : null;
  const d = decidePaystubDeliveryAddress(r.personal_email, h, currentName);
  if (d.kind === "replace") {
    if (recentOtherHolder.has(work)) {
      skippedRates.set(work, (skippedRates.get(work) ?? 0) + 1);
      continue;
    }
    rateMoves.push({ table: "employee_hourly_rates", id: r.id, work, from: r.personal_email!, to: d.to });
  } else if (d.kind === "withhold") withheld.push({ table: "employee_hourly_rates", id: r.id, work, reason: d.reason });
}

const byWork = (moves: Move[]) => {
  const m = new Map<string, number>();
  for (const x of moves) m.set(x.work, (m.get(x.work) ?? 0) + 1);
  return [...m].sort((a, b) => a[0].localeCompare(b[0]));
};
console.log(`${APPLY ? "APPLY" : "REHEARSAL"}: ${queue.length} queue rows and ${rates.length} rate rows read.\n`);
console.log(`paystub_dispatch_queue: ${queueMoves.length} rows to re-point`);
for (const [w, n] of byWork(queueMoves)) console.log(`  ${w.padEnd(28)} ${n}`);
if (process.argv.includes("--names")) {
  // Who each re-pointed statement is FOR, and who left with the address it
  // carried. Names only, never an address.
  const nameOf = new Map(queue.map((r) => [r.id, statementNameOf(r)]));
  for (const m of queueMoves) {
    const leaver = holders.get(m.work)?.previous.find((p) => p.email === m.from.trim().toLowerCase());
    console.log(`    ${m.work.padEnd(22)} ${m.week ?? "?"}  for "${nameOf.get(m.id)}"  ← left with it: ${leaver?.names.map((n) => n.join(" ")).join(" | ") ?? "?"}`);
  }
}
console.log(`\nemployee_hourly_rates: ${rateMoves.length} rows to re-point`);
for (const [w, n] of byWork(rateMoves)) console.log(`  ${w.padEnd(28)} ${n}`);
console.log(
  `\nrate rows SKIPPED (a different person had a statement in the last 28 days; the code guard decides by name): ` +
    [...skippedRates.values()].reduce((a, b) => a + b, 0),
);
for (const [w, n] of [...skippedRates].sort()) console.log(`  ${w.padEnd(28)} ${n}`);
console.log(`\nwithheld (no change, needs a human): ${withheld.length}`);
for (const w of withheld) console.log(`  ${w.table} ${w.work} ${w.week ?? ""} ${w.reason}`);

if (!APPLY) {
  console.log("\nNothing written. Re-run with --apply.");
  await db.end();
  process.exit(0);
}

// Backup FIRST: the full current rows, exactly as they are.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = join("references", "backups");
mkdirSync(dir, { recursive: true });
const backupPath = join(dir, `fix-recycled-paystub-addresses-${stamp}.json`);
const qIds = queueMoves.map((m) => m.id);
const rIds = rateMoves.map((m) => m.id);
const backup = {
  taken_at: new Date().toISOString(),
  paystub_dispatch_queue: (await db.query(`select * from paystub_dispatch_queue where id = any($1::uuid[])`, [qIds])).rows,
  employee_hourly_rates: (await db.query(`select * from employee_hourly_rates where id = any($1::uuid[])`, [rIds])).rows,
  moves: { queue: queueMoves, rates: rateMoves },
};
if (backup.paystub_dispatch_queue.length !== qIds.length || backup.employee_hourly_rates.length !== rIds.length) {
  throw new Error("backup row count does not match the plan; nothing written");
}
writeFileSync(backupPath, JSON.stringify(backup, null, 2));
console.log(`\nbackup: ${backupPath}`);

await db.query("begin");
try {
  let q = 0;
  for (const m of queueMoves) {
    // Compare-and-swap on the address being replaced, in either field.
    const res = await db.query(
      `update paystub_dispatch_queue
          set personal_email = $2,
              payload = case when payload is null then null
                             else jsonb_set(payload, '{personal_email}', to_jsonb($2::text)) end
        where id = $1
          and lower(trim(coalesce(payload->>'personal_email', personal_email))) = $3`,
      [m.id, m.to, m.from.trim().toLowerCase()],
    );
    q += res.rowCount ?? 0;
  }
  let r = 0;
  for (const m of rateMoves) {
    const res = await db.query(
      `update employee_hourly_rates set "Personal Email" = $2
        where id = $1 and lower(trim("Personal Email")) = $3`,
      [m.id, m.to, m.from.trim().toLowerCase()],
    );
    r += res.rowCount ?? 0;
  }
  if (q !== queueMoves.length || r !== rateMoves.length) {
    throw new Error(`CAS mismatch: queue ${q}/${queueMoves.length}, rates ${r}/${rateMoves.length}; rolled back`);
  }
  await db.query("commit");
  console.log(`\nAPPLIED: ${q} queue rows, ${r} rate rows.`);
} catch (err) {
  await db.query("rollback");
  throw err;
} finally {
  await db.end();
}
