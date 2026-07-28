/**
 * Proves the payment_dispatches INSERT body is safe against the CURRENT live
 * schema — i.e. that an employee/MESA/urgent payment still works before
 * add_contractor_dispatch_link.sql has been applied.
 *
 *   node scripts/verify-dispatch-insert-shape.mjs
 *
 * PostgREST validates a payload against its schema cache BEFORE touching the
 * database, so naming a column that does not exist (payee_type,
 * contractor_invoice_id) fails the whole insert with PGRST204 — which would take
 * out EVERY payment, not just contractor ones. This asserts that does not happen.
 *
 * WRITES NOTHING: each probe deliberately omits NOT NULL columns
 * (recipient_email / processor / transaction_id / bank_used / sent_date), so the
 * row can never be created. We only inspect WHICH error comes back:
 *   - a NOT NULL violation (23502)  → the payload shape was ACCEPTED  ✓
 *   - PGRST204 / 42703 naming a column → the payload shape was REJECTED ✗
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

/** Mirrors the employee body built by insertPaymentDispatch(), minus NOT NULLs. */
const EMPLOYEE_BODY = {
  cycle_id: null,
  cycle_period_start: null,
  cycle_period_end: null,
  cycle_source_file: null,
  recipient_name: null,
  bank_preferred_raw: null,
  recipient_preferred_bank: null,
  recipient_account_number: null,
  recipient_account_holder: null,
  recipient_swift_code: null,
  amount_usd: null,
  amount_php: null,
  amount_cop: null,
  arrival_date: null,
  note: null,
  created_by: null,
};

const CONTRACTOR_BODY = {
  ...EMPLOYEE_BODY,
  payee_type: "contractor",
  contractor_invoice_id: null,
};

async function probe(label, body) {
  const { data, error } = await supabase.from("payment_dispatches").insert(body).select("id");
  if (data && data.length) {
    console.error(`  !! ${label}: a row was CREATED (${data[0].id}) — delete it manually`);
    return { label, created: true };
  }
  const code = error?.code ?? "none";
  const msg = error?.message ?? "";
  const shapeRejected = code === "PGRST204" || code === "42703" || /schema cache|does not exist/i.test(msg);
  console.log(`  ${label}: code=${code} ${shapeRejected ? "SHAPE REJECTED" : "shape accepted"}`);
  console.log(`     ${msg.slice(0, 150)}`);
  return { label, code, shapeRejected };
}

/** Retry transport flakes — `TypeError: fetch failed` is a real one against this project. */
async function probeColumn(column) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await supabase.from("payment_dispatches").select(column).limit(1);
    if (!error) return true;
    if (/does not exist/i.test(error.message)) return false;
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return false;
}
const hasPayeeType = await probeColumn("payee_type");
console.log(`live schema has payment_dispatches.payee_type: ${hasPayeeType ? "YES (migrated)" : "NO (pre-migration)"}\n`);

console.log("EMPLOYEE payment body (no payee_type / contractor_invoice_id keys):");
const emp = await probe("employee", EMPLOYEE_BODY);

console.log("\nCONTRACTOR payment body (both keys present):");
const con = await probe("contractor", CONTRACTOR_BODY);

// The payee_type CHECK constraint. Safe: recipient_email is omitted, so the row can
// never be written whichever constraint fires first — we only read the error code.
if (hasPayeeType) {
  console.log("\nCHECK constraint probe (payee_type = 'bogus'):");
  const { data, error } = await supabase
    .from("payment_dispatches")
    .insert({ ...EMPLOYEE_BODY, payee_type: "bogus" })
    .select("id");
  if (data && data.length) {
    console.error(`  !! a row was CREATED (${data[0].id}) — delete it manually`);
  } else {
    const code = error?.code ?? "none";
    const label =
      code === "23514"
        ? "CHECK ENFORCED (invalid payee_type rejected)"
        : code === "23502"
          ? "inconclusive — NOT NULL fired first (nothing written; constraint order is not guaranteed)"
          : `unexpected code ${code}`;
    console.log(`  code=${code} -> ${label}`);
    console.log(`     ${(error?.message ?? "").slice(0, 140)}`);
  }
}

console.log("\n=== RESULT ===");
let bad = 0;
if (emp.created || con.created) {
  console.log("✗ a probe wrote a row — investigate immediately");
  bad++;
}
if (emp.shapeRejected) {
  console.log("✗ EMPLOYEE payments are BROKEN against the live schema — every Mark Paid, MESA disbursement and urgent payout would 500.");
  bad++;
} else {
  console.log("✓ employee payments accept the current schema (fails only on the omitted NOT NULL columns, as designed)");
}
if (!hasPayeeType) {
  if (con.shapeRejected) {
    console.log("✓ contractor payments correctly require the migration (expected pre-migration; the UI has no contractor rows yet either)");
  } else {
    console.log("? contractor body was accepted without the migration — unexpected, check the schema");
  }
} else if (con.shapeRejected) {
  console.log("✗ contractor payments rejected AFTER migration — the columns are not what the code expects");
  bad++;
} else {
  console.log("✓ contractor payments accept the migrated schema");
}
process.exitCode = bad ? 1 : 0;
