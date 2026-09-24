/**
 * breyl@simple.biz (Breynald John Lim) received no paystub for the six weeks
 * 08-09 → 09-13 (Open item 199). His rates-sheet Personal Email is his NAME,
 * "breynald john lim"; the wizard let that non-empty cell win, and n8n skipped
 * every send as "Invalid or missing personal_email". Kane confirmed the right
 * address on 2026-09-24: applesider2013@gmail.com (already on his active Lead
 * Gen master-list row).
 *
 *   node scripts/fix-breyl-personal-email.mjs            # DRY RUN (default)
 *   node scripts/fix-breyl-personal-email.mjs --apply    # backup, write, verify
 *
 * Writes, only with --apply:
 *   1. employee_hourly_rates: every breyl@ row whose "Personal Email" is not the
 *      target (9 rows as measured: 1 name + 8 breynaldjohn20@). The wizard takes
 *      the LAST row per work email (indexHourlyRatesByEmail), so leaving any row on
 *      another value would let row order choose his address.
 *   2. paystub_dispatch_queue: every breyl@ row whose personal_email is NOT
 *      mailable. Both the column AND payload.personal_email change, because a
 *      re-send reads the queued payload (getFreshPaystubEntry → staged.payload),
 *      not the live roster. Rows already holding a real address are left alone.
 *      Nothing else in the payload is touched; no money field moves.
 *
 * It sends nothing. Delivery is still the clerk's Mark Paid in Payment Dispatch.
 *
 * Read-only unless --apply (CLAUDE.md: .env.local holds PRODUCTION credentials).
 * The SELECT backup goes to docs/audits/backups/ (gitignored: it holds personal
 * emails) BEFORE any UPDATE.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const WORK_EMAIL = "breyl@simple.biz";
const TARGET = "applesider2013@gmail.com";
const MAILABLE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const APPLY = process.argv.includes("--apply");

const mailable = (v) => {
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  return t && MAILABLE_RE.test(t) ? t : null;
};

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

async function load() {
  // Both sets are a handful of rows for one person, far under the 1000 cap;
  // the count is asserted below so a surprise size fails loud, not silently.
  const rates = await sb
    .from("employee_hourly_rates")
    .select("*", { count: "exact" })
    .ilike("Work Email", WORK_EMAIL);
  if (rates.error) throw new Error(`rates read: ${rates.error.message}`);
  const queue = await sb
    .from("paystub_dispatch_queue")
    .select("id, cycle_source_file, recipient_email, personal_email, sent_at, send_count, last_error, payload", {
      count: "exact",
    })
    .ilike("recipient_email", WORK_EMAIL);
  if (queue.error) throw new Error(`queue read: ${queue.error.message}`);
  if ((rates.count ?? 0) > 900 || (queue.count ?? 0) > 900) throw new Error("unexpected row count; page it");
  return { rates: rates.data, queue: queue.data };
}

function plan({ rates, queue }) {
  const rateFix = rates.filter((r) => mailable(r["Personal Email"]) !== TARGET);
  const queueFix = queue.filter((q) => !mailable(q.personal_email) || !mailable(q.payload?.personal_email));
  return { rateFix, queueFix };
}

const before = await load();
const { rateFix, queueFix } = plan(before);

console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${WORK_EMAIL} → ${TARGET}\n`);
console.log(`employee_hourly_rates: ${before.rates.length} rows, ${rateFix.length} to change`);
for (const r of rateFix) console.log(`  ${r.id}  "${r["Personal Email"]}" → ${TARGET}`);
console.log(`\npaystub_dispatch_queue: ${before.queue.length} rows, ${queueFix.length} to change`);
for (const q of queueFix) {
  console.log(
    `  ${q.cycle_source_file}  col="${q.personal_email}" payload="${q.payload?.personal_email}"` +
      `  sent_at=${q.sent_at ?? "null"}  last_error=${q.last_error ?? "null"}`,
  );
}

if (!APPLY) {
  console.log("\nNothing written. Re-run with --apply to back up and write.");
  process.exit(0);
}

mkdirSync("docs/audits/backups", { recursive: true });
const backupPath = `docs/audits/backups/breyl-personal-email-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(backupPath, JSON.stringify({ takenAt: new Date().toISOString(), ...before }, null, 2));
console.log(`\nBackup written: ${backupPath}`);

for (const r of rateFix) {
  const { error } = await sb.from("employee_hourly_rates").update({ "Personal Email": TARGET }).eq("id", r.id);
  if (error) throw new Error(`rates update ${r.id}: ${error.message}`);
}
for (const q of queueFix) {
  const payload = { ...(q.payload ?? {}), personal_email: TARGET };
  const { error } = await sb
    .from("paystub_dispatch_queue")
    .update({ personal_email: TARGET, payload })
    .eq("id", q.id);
  if (error) throw new Error(`queue update ${q.id}: ${error.message}`);
}

// Verify from a fresh read, never from what we meant to write.
const after = await load();
const left = plan(after);
if (left.rateFix.length || left.queueFix.length) {
  console.error(`VERIFY FAILED: ${left.rateFix.length} rate rows, ${left.queueFix.length} queue rows still wrong`);
  process.exit(1);
}
console.log(`VERIFIED: ${rateFix.length} rate rows and ${queueFix.length} queue rows now read ${TARGET}.`);
