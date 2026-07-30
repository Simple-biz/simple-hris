// Insert a missing BASELINE `employee_rate_history` row — the "what the rate was
// BEFORE the change" record the proration engine needs to split a mid-week rate
// change. Without it, days before the change resolve through the FALLBACK (the
// current rates cache, which already holds the NEW rate), so the whole week
// silently prices at the new rate: no proration, no "Prorated" chip, and the
// pre-change days are paid at the wrong rate.
//
// First-ever Payment Catalog rates cause this: the pay-structures route inserts
// only the NEW dated row, so a person with no prior history has no baseline.
//
// Dry-run by default; pass --apply to write. Prints a SELECT-style backup of the
// person's existing history first (restore = delete the inserted id).
//
// Usage:
//   node scripts/fix-missing-rate-history-baseline.mjs <email> <regularRate> <otRate> <effective_from> [--apply]
// Example (Uriel Matias — ₱175/₱262.50 before the Jul 20 2026 catalog change):
//   node scripts/fix-missing-rate-history-baseline.mjs urielm@simple.biz 175 262.5 2026-01-01 --apply
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local" });

const [emailArg, regArg, otArg, effArg] = process.argv.slice(2);
const APPLY = process.argv.includes("--apply");
const email = (emailArg || "").trim().toLowerCase();
const reg = Number(regArg);
const ot = Number(otArg);
const eff = (effArg || "").trim();

if (!email || !Number.isFinite(reg) || !Number.isFinite(ot) || !/^\d{4}-\d{2}-\d{2}$/.test(eff)) {
  console.log("Usage: node scripts/fix-missing-rate-history-baseline.mjs <email> <regularRate> <otRate> <effective_from YYYY-MM-DD> [--apply]");
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) { console.error("missing supabase env"); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// Backup: everything currently on this email.
const { data: existing, error: exErr } = await sb
  .from("employee_rate_history")
  .select("*")
  .eq("employee_email", email)
  .order("effective_from", { ascending: false });
if (exErr) { console.error("read failed:", exErr.message); process.exit(1); }
console.log(`── BACKUP: existing employee_rate_history for ${email} (${existing?.length ?? 0} rows):`);
console.log(JSON.stringify(existing, null, 2));

// Guard: refuse if a row already covers dates ≤ eff (a baseline exists).
const covered = (existing ?? []).some((r) => String(r.effective_from).slice(0, 10) <= eff);
if (covered) {
  console.log(`\nA history row with effective_from ≤ ${eff} already exists — baseline not missing. Nothing to do.`);
  process.exit(0);
}

const row = {
  employee_email: email,
  regular_rate: reg,
  ot_rate: ot,
  effective_from: eff,
  note: "Baseline backfill — rate in effect before the first dated change (mid-week proration needs the pre-change rate on record)",
  created_by: "fix-missing-rate-history-baseline.mjs",
};
console.log(`\n── ${APPLY ? "INSERTING" : "DRY-RUN (pass --apply to write)"}:`);
console.log(row);

if (APPLY) {
  const { data: ins, error: insErr } = await sb.from("employee_rate_history").insert(row).select("id");
  if (insErr) { console.error("insert failed:", insErr.message); process.exit(1); }
  console.log(`Inserted id ${ins?.[0]?.id}. Undo = delete that id.`);
  console.log("Reload the wizard tab (and re-lock the week if already staged) so the prorated figures re-stage.");
}
