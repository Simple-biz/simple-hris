/**
 * READ-ONLY follow-up to probe-mesa-flag-vs-account.mts.
 *
 * Two questions left open:
 *   A. Has the HRIS EVER deducted the PHP100 from jimg@ / dales@? (every staged
 *      paystub payload they have, plus every final_pay snapshot entry)
 *   B. Are the 5 off-roster unflagged accounts (emsa, renzj, shennyh, pio,
 *      fernq) ALSO email-drift cases — i.e. people still on the roster under a
 *      different address, and therefore still-active savers nobody is
 *      deducting — or genuinely departed people whose balance is owed?
 *
 * Usage: node --import tsx scripts/probe-mesa-unflagged-detail.mts
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const { createSupabaseServiceRoleClient } = await import("../src/lib/supabase/server");
const { selectAllPaged } = await import("../src/lib/supabase/select-all-paged");

const supabase = createSupabaseServiceRoleClient();
if (!supabase) { console.error("No service-role client"); process.exit(1); }

const line = (s: string) => console.log("\n" + "-".repeat(78) + "\n" + s + "\n" + "-".repeat(78));
const J = (v: unknown) => JSON.stringify(v);
const norm = (e: unknown) => String(e ?? "").trim().toLowerCase();

// ── A. Has the HRIS ever deducted from the two active ones? ────────────────
line("A. Every staged paystub these two have ever had — did any carry a MESA deduction?");
for (const email of ["jimg@simple.biz", "dales@simple.biz"]) {
  const { rows, error } = await selectAllPaged<any>((from, to) =>
    supabase.from("paystub_dispatch_queue")
      .select("cycle_source_file, recipient_email, amount_php, payload, locked_at, sent_at, excluded")
      .ilike("recipient_email", email)
      .order("locked_at", { ascending: true })
      .range(from, to),
  );
  if (error) { console.log("  " + email + ": READ FAILED — " + error); continue; }
  console.log("\n  " + email + ": " + rows.length + " staged stub(s)");
  let everDeducted = 0;
  for (const r of rows) {
    const p: any = r.payload ?? {};
    const ded = p.mesa_deduction;
    if (typeof ded === "number" && ded > 0) everDeducted += 1;
    console.log(
      "    " + String(r.cycle_source_file).replace("simple-biz_daily_report_", "").replace(".csv", "") +
        "  amount=" + J(r.amount_php) + "  mesa_deduction=" + J(ded) +
        "  sent=" + (r.sent_at ? "yes" : "no"),
    );
  }
  console.log("    => cycles with a MESA deduction on the stub: " + everDeducted + " of " + rows.length);
}

// ── B. Are the 5 off-roster ones email drift too? ──────────────────────────
line("B. The 5 off-roster unflagged accounts — drifted email, or genuinely departed?");
const LEDGER_EMAILS = ["emsa@simple.biz", "renzj@simple.biz", "shennyh@simple.biz", "pio@simple.biz", "fernq@simple.biz"];

// Their names as the ledger records them.
const { rows: led } = await selectAllPaged<any>((from, to) =>
  supabase.from("mesa_ledger").select("email, name, department")
    .or(LEDGER_EMAILS.map((e) => "email.ilike." + e).join(","))
    .order("id").range(from, to),
);
const nameByEmail = new Map<string, string>();
const deptByEmail = new Map<string, string>();
for (const r of led) {
  const e = norm(r.email);
  if (r.name && !nameByEmail.has(e)) nameByEmail.set(e, String(r.name));
  if (r.department && !deptByEmail.has(e)) deptByEmail.set(e, String(r.department));
}

// Whole master list + the offboarded ledger, to place each person.
const { rows: gml } = await selectAllPaged<Record<string, unknown>>((from, to) =>
  supabase.from("global_master_list").select('"Work Email", "Name", "Department", off_boarded_at')
    .order("Work Email").range(from, to),
);
const { rows: offb, error: offErr } = await selectAllPaged<Record<string, unknown>>((from, to) =>
  supabase.from("offboarded_sheet").select("*").order("id").range(from, to),
);

console.log("  global_master_list rows: " + gml.length + "  ·  offboarded_sheet rows: " + (offErr ? "READ FAILED" : offb.length));

/** Surname/first-name tokens from a ledger name, for a fuzzy roster match. */
const tokens = (n: string) =>
  n.toLowerCase().replace(/["']/g, " ").split(/[^a-z]+/).filter((t) => t.length >= 3);

for (const e of LEDGER_EMAILS) {
  const nm = nameByEmail.get(e) ?? "(no name in ledger)";
  console.log("\n  " + e + "   ledger name: " + J(nm) + "   dept: " + J(deptByEmail.get(e) ?? null));

  // 1. exact email anywhere in the master list
  const exact = gml.filter((g) => norm(g["Work Email"]) === e);
  if (exact.length) {
    for (const g of exact) {
      console.log("    MASTER LIST (exact email): " + J(g["Name"]) + "  dept=" + J(g["Department"]) + "  off_boarded_at=" + J(g.off_boarded_at));
    }
  } else {
    console.log("    MASTER LIST (exact email): none");
  }

  // 2. name match against the master list -> would reveal a drifted address
  const toks = tokens(nm);
  const byName = gml.filter((g) => {
    const gn = String(g["Name"] ?? "").toLowerCase();
    return toks.length > 0 && toks.filter((t) => gn.includes(t)).length >= Math.min(2, toks.length);
  });
  if (byName.length) {
    for (const g of byName.slice(0, 5)) {
      console.log(
        "    NAME MATCH -> " + J(g["Work Email"]) + "  " + J(g["Name"]) +
          "  dept=" + J(g["Department"]) + "  off_boarded_at=" + J(g.off_boarded_at),
      );
    }
    if (byName.length > 5) console.log("    ... " + (byName.length - 5) + " more name matches");
  } else {
    console.log("    NAME MATCH: none in the master list");
  }

  // 3. offboarded ledger, by email or name
  if (!offErr) {
    const off = offb.filter((o) => {
      const blob = JSON.stringify(o).toLowerCase();
      return blob.includes(e) || toks.filter((t) => blob.includes(t)).length >= Math.min(2, toks.length);
    });
    for (const o of off.slice(0, 3)) {
      const keys = Object.keys(o).filter((k) => /email|name|date|reason|status/i.test(k)).slice(0, 8);
      console.log("    OFFBOARDED: " + keys.map((k) => k + "=" + J(o[k])).join("  "));
    }
    if (!off.length) console.log("    OFFBOARDED: no matching row");
  }
}

// ── C. Balances held by the off-roster unflagged, and whether released ─────
line("C. Money sitting in the 5 off-roster open accounts (is a payout already raised?)");
const { rows: obligations, error: obErr } = await selectAllPaged<any>((from, to) =>
  supabase.from("mesa_payroll_obligations").select("*").order("id").range(from, to),
);
if (obErr) {
  console.log("  mesa_payroll_obligations: READ FAILED — " + obErr);
} else {
  console.log("  mesa_payroll_obligations rows: " + obligations.length);
  for (const e of LEDGER_EMAILS) {
    const mine = obligations.filter((o) => JSON.stringify(o).toLowerCase().includes(e));
    console.log("    " + e + ": " + mine.length + " obligation row(s)" + (mine.length ? "  " + JSON.stringify(mine) : ""));
  }
}
