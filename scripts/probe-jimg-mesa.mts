/**
 * READ-ONLY probe: why does jimg@simple.biz have no MESA deduction?
 *
 * Kane, 2026-09-15: "jimg@simple.biz can you please check it out because he
 * doesnt have his MESA deduction even though he was opted in."
 *
 * `jim@simple.biz` is a KNOWN LEDGER ALIAS of `jimg@simple.biz`
 * (src/data/mesa-email-aliases.json), and memory/mesa-csv-rebuild-applied lists
 * `jim` among 7 CSV members with NO rate row — so both addresses are checked
 * everywhere below.
 *
 * Measures, never mutates. Reproduces each gate the PHP100 passes through:
 *   1. rate rows (view + raw) — mesa_member / mesa_member_since / account number
 *   2. mesa_accounts stints
 *   3. mesa_ledger events + lastEventOptedOut (the opt-out suppression)
 *   4. mesa_requests
 *   5. audit_log enroll/unenroll history
 *   6. recent pay weeks: hours, the final_pay snapshot's mesa_deduction, the
 *      staged paystub payload, and what each wizard gate would decide
 *
 * Usage: node --import tsx scripts/probe-jimg-mesa.mts
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const { createSupabaseServiceRoleClient } = await import("../src/lib/supabase/server");
const { selectAllPaged } = await import("../src/lib/supabase/select-all-paged");
const { summarizeMember, summarizeMemberAccount } = await import("../src/lib/mesa/ledger");
const { mesaEmailAliasesFor } = await import("../src/lib/mesa/email-aliases");
const { mesaContributesForWeek, mesaDepositDateFor } = await import("../src/lib/mesa/deposit-date");

const supabase = createSupabaseServiceRoleClient();
if (!supabase) {
  console.error("No service-role client — check .env.local");
  process.exit(1);
}

const TARGET = "jimg@simple.biz";
const EMAILS = mesaEmailAliasesFor(TARGET);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const line = (s: string) => console.log("\n" + "-".repeat(78) + "\n" + s + "\n" + "-".repeat(78));
const dow = (iso: string | null | undefined) =>
  iso ? DAYS[new Date(iso + "T00:00:00Z").getUTCDay()] : "--";
const J = (v: unknown) => JSON.stringify(v);
const orIlike = (col: string) => EMAILS.map((e) => col + ".ilike." + e).join(",");

console.log("Target: " + TARGET);
console.log("Ledger aliases resolved by the app: " + EMAILS.join(", "));

// -- 1. Rate rows -----------------------------------------------------------
line("1. RATE ROWS — the wizard reads employee_hourly_rates_current; mesa_member lives here");
const RATE_COLS =
  '"Work Email", "Personal Email", "Department", "MESA Contribution (100PHP)", mesa_member, mesa_member_since, mesa_fpu_completed_on, mesa_account_number, upload_id, id';
for (const table of ["employee_hourly_rates_current", "employee_hourly_rates"]) {
  const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase
      .from(table)
      .select(RATE_COLS)
      .or(orIlike('"Work Email"'))
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) {
    console.log("  " + table + ": READ FAILED — " + error);
    continue;
  }
  console.log("\n  " + table + ": " + rows.length + " row(s) matching Work Email");
  for (const r of rows) {
    console.log(
      "    work=" + J(r["Work Email"]) + " personal=" + J(r["Personal Email"]) + " dept=" + J(r["Department"]) + " upload=" + J(r.upload_id),
    );
    console.log(
      "      mesa_member=" + J(r.mesa_member) +
        "  since=" + J(r.mesa_member_since) + " (" + dow(r.mesa_member_since as string) + ")" +
        "  account=" + J(r.mesa_account_number) +
        "  fpu=" + J(r.mesa_fpu_completed_on) +
        "  sheetMESAcol=" + J(r["MESA Contribution (100PHP)"]),
    );
  }
  const { rows: byPersonal } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase
      .from(table)
      .select(RATE_COLS)
      .or(orIlike('"Personal Email"'))
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (byPersonal.length) {
    console.log("  " + table + ": " + byPersonal.length + " row(s) matching PERSONAL email");
    for (const r of byPersonal) {
      console.log(
        "    work=" + J(r["Work Email"]) + " personal=" + J(r["Personal Email"]) +
          " mesa_member=" + J(r.mesa_member) + " since=" + J(r.mesa_member_since),
      );
    }
  }
}

// Is he on the active roster at all?
line("1b. Roster presence (active_employees / global_master_list)");
for (const view of ["active_employees", "global_master_list"]) {
  const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase.from(view).select("*").or(orIlike('"Work Email"')).range(from, to),
  );
  if (error) {
    console.log("  " + view + ": READ FAILED — " + error);
    continue;
  }
  console.log("  " + view + ": " + rows.length + " row(s)");
  for (const r of rows) {
    const keys = ["Work Email", "Name", "Department", "off_boarded_at", "offboarded_at", "Status", "Start Date"];
    const shown = keys.filter((k) => k in r).map((k) => k + "=" + J(r[k]));
    console.log("    " + shown.join("  "));
  }
}

// -- 2. Accounts ------------------------------------------------------------
line("2. mesa_accounts — the stint registry (opened_on scopes every visible balance)");
const { rows: accounts, error: aErr } = await selectAllPaged<Record<string, unknown>>((from, to) =>
  supabase
    .from("mesa_accounts")
    .select("account_number, email, name, opened_on, closed_on, created_at")
    .or(orIlike("email"))
    .order("opened_on", { ascending: true })
    .range(from, to),
);
if (aErr) console.log("  READ FAILED — " + aErr);
console.log("  " + accounts.length + " account(s)");
for (const a of accounts) {
  console.log(
    "    " + a.account_number + "  " + a.email +
      "  opened " + a.opened_on + " (" + dow(a.opened_on as string) + ")" +
      "  closed " + J(a.closed_on) + "  created " + a.created_at,
  );
}

// -- 3. Ledger --------------------------------------------------------------
line("3. mesa_ledger — contributions, and whether the LAST event is an opt-out");
const { rows: events, error: lErr } = await selectAllPaged<any>((from, to) =>
  supabase
    .from("mesa_ledger")
    .select(
      "id, email, name, status, worker_contribution_php, simple_match_php, total_daily_deposit_php, deposit_date, disbursement_amount_php, disbursement_date, disbursement_type, notes, additional_notes",
    )
    .or(orIlike("email"))
    .order("id", { ascending: true })
    .range(from, to),
);
if (lErr) console.log("  READ FAILED — " + lErr);
console.log("  " + events.length + " ledger event(s)");
const deposits = events.filter((e) => e.deposit_date);
if (deposits.length) {
  const last = deposits[deposits.length - 1];
  console.log(
    "  deposits: " + deposits.length + "  first " + deposits[0].deposit_date +
      " · last " + last.deposit_date + " (" + dow(last.deposit_date) + ")",
  );
} else {
  console.log("  deposits: 0");
}
for (const e of events.slice(-12)) {
  console.log(
    "    #" + e.id + " " + e.email +
      "  dep=" + J(e.deposit_date) + " PHP" + ((e.worker_contribution_php ?? 0) + (e.simple_match_php ?? 0)) +
      "  disb=" + J(e.disbursement_date) + "/" + J(e.disbursement_amount_php) + "/" + J(e.disbursement_type) +
      "  status=" + J(e.status),
  );
}
if (events.length) {
  const full = summarizeMember(events as any);
  console.log(
    "\n  summarizeMember (full history): balance PHP" + full.balance +
      "  deposits " + full.depositCount + "  status=" + J(full.status) +
      "  lastEventOptedOut=" + full.lastEventOptedOut,
  );
  const open = accounts.find((a) => !a.closed_on);
  if (open) {
    const scoped = summarizeMemberAccount(events as any, {
      account_number: open.account_number as string,
      opened_on: open.opened_on as string,
    });
    console.log(
      "  summarizeMemberAccount (open " + open.account_number + ", from " + open.opened_on + "): balance PHP" +
        scoped.balance + "  deposits " + scoped.depositCount + "  lastEventOptedOut=" + scoped.lastEventOptedOut,
    );
    console.log("  -> the wizard SUPPRESSES the PHP100 when lastEventOptedOut is true (isMesaOptedOut)");
  } else {
    console.log("  no OPEN account -> /api/mesa-ledger returns the FULL-history rollup");
  }
}

// -- 4. Requests ------------------------------------------------------------
line("4. mesa_requests — the opt-in/opt-out paper trail");
const { rows: reqs, error: rErr } = await selectAllPaged<any>((from, to) =>
  supabase
    .from("mesa_requests")
    .select(
      "id, work_email, full_name, request_type, status, effective_date, amount_needed, created_at, reviewed_by, reviewed_at, dispatched_at",
    )
    .or(orIlike("work_email"))
    .order("created_at", { ascending: true })
    .range(from, to),
);
if (rErr) console.log("  READ FAILED — " + rErr);
console.log("  " + reqs.length + " request(s)");
for (const r of reqs) {
  console.log(
    "    " + String(r.created_at).slice(0, 10) + "  " + r.request_type + "  " + r.status +
      "  eff=" + J(r.effective_date) + "  by=" + J(r.reviewed_by) + "  dispatched=" + J(r.dispatched_at),
  );
}

// -- 5. Audit log -----------------------------------------------------------
line("5. audit_log — every enrollment flip recorded for him");
const { rows: audits, error: auErr } = await selectAllPaged<any>((from, to) =>
  supabase
    .from("audit_log")
    .select("created_at, action, user_name, user_role, resource_id, details")
    .in("action", ["employee.mesa.enroll", "employee.mesa.unenroll"])
    .order("created_at", { ascending: false })
    .range(from, to),
);
if (auErr) console.log("  READ FAILED — " + auErr);
const mine = audits.filter((a) => {
  const hay = (String(a.resource_id ?? "") + " " + JSON.stringify(a.details ?? {})).toLowerCase();
  return EMAILS.some((e) => hay.includes(e));
});
console.log("  " + audits.length + " MESA enrol/unenrol events overall · " + mine.length + " mentioning him");
for (const a of mine) {
  console.log("    " + a.created_at + "  " + a.action + "  by " + a.user_name + " (" + a.user_role + ")");
  console.log("      " + JSON.stringify(a.details));
}

// -- 6. Recent pay weeks ----------------------------------------------------
line("6. RECENT PAY WEEKS — hours, the snapshot's mesa_deduction, and what each gate decides");
const { rows: uploads, error: uErr } = await selectAllPaged<any>((from, to) =>
  supabase
    .from("hubstaff_uploads")
    .select("id, source_file, uploaded_at, is_current")
    .order("uploaded_at", { ascending: false })
    .range(from, to),
);
if (uErr) console.log("  hubstaff_uploads READ FAILED — " + uErr);
const recent = uploads.slice(0, 6);
console.log("  newest " + recent.length + " uploads:");
for (const u of recent) console.log("    " + u.source_file + "  uploaded " + u.uploaded_at + "  current=" + J(u.is_current));

const rangeOf = (file: string) => {
  const m = /_(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})/.exec(file || "");
  return m ? { start: m[1], end: m[2] } : null;
};

// The since/flag actually on file, for replaying the gates.
const { rows: currentRate } = await selectAllPaged<Record<string, unknown>>((from, to) =>
  supabase
    .from("employee_hourly_rates_current")
    .select(RATE_COLS)
    .or(orIlike('"Work Email"'))
    .range(from, to),
);
const rateRow = currentRate[0];
const since = (rateRow?.mesa_member_since as string | null) ?? null;
const flag = rateRow?.mesa_member ?? null;

for (const u of recent) {
  const r = rangeOf(u.source_file);
  console.log("\n  === " + u.source_file + " ===");
  if (!r) {
    console.log("    (filename carries no parseable date range)");
    continue;
  }
  const friday = mesaDepositDateFor(r.end);
  console.log("    week " + r.start + " -> " + r.end + " (" + dow(r.end) + ")   Friday deposit date: " + friday);

  // Hours that week
  const { rows: hrs } = await selectAllPaged<any>((from, to) =>
    supabase
      .from("hubstaff_hours")
      .select('"Email", "Member", "Total worked", source_file')
      .eq("source_file", u.source_file)
      .or(orIlike('"Email"'))
      .range(from, to),
  );
  console.log(
    "    hubstaff_hours rows for him: " + hrs.length +
      (hrs.length ? "  (" + J(hrs[0]["Email"]) + " worked " + J(hrs[0]["Total worked"]) + ")" : "  -> NOT IN THIS WEEK'S CSV"),
  );

  // Gates
  const contributes = mesaContributesForWeek(since, r.end);
  const oldRule = !since || since <= r.end;
  console.log(
    "    gate: mesa_member=" + J(flag) +
      "  since=" + J(since) +
      "  contributes(new Friday rule)=" + contributes +
      "  contributes(old week-end rule)=" + oldRule,
  );

  // What the wizard published
  const { data: snap } = await supabase
    .from("app_settings")
    .select("value, updated_at")
    .eq("key", "payroll.wizard.final_pay." + u.source_file)
    .maybeSingle();
  if (!snap) {
    console.log("    final_pay snapshot: NONE");
  } else {
    const val: any = snap.value;
    const entries = val?.entries ?? val?.employees ?? val;
    let found: any = null;
    if (entries && typeof entries === "object") {
      for (const [k, v] of Object.entries(entries as Record<string, any>)) {
        if (EMAILS.some((e) => k.toLowerCase().includes(e))) { found = { k, v }; break; }
      }
    }
    if (found) {
      const v = found.v;
      console.log(
        "    final_pay[" + found.k + "]: mesaDeduction=" + J(v?.mesaDeduction) +
          "  final=" + J(v?.final) + "  initial=" + J(v?.initial) + "  (snapshot updated " + snap.updated_at + ")",
      );
    } else {
      console.log("    final_pay snapshot exists (updated " + snap.updated_at + ") but holds NO entry for him");
    }
  }

  // What was staged / sent
  const { rows: q } = await selectAllPaged<any>((from, to) =>
    supabase
      .from("paystub_dispatch_queue")
      .select("recipient_email, amount_php, payload, locked_at, sent_at, excluded")
      .eq("cycle_source_file", u.source_file)
      .or(orIlike("recipient_email"))
      .range(from, to),
  );
  for (const row of q) {
    const p: any = row.payload ?? {};
    console.log(
      "    staged stub: amount=" + J(row.amount_php) +
        "  mesa_deduction=" + J(p.mesa_deduction) +
        "  excluded=" + J(row.excluded) +
        "  locked " + row.locked_at + "  sent " + J(row.sent_at),
    );
  }
  if (!q.length) console.log("    staged stub: none under his work email");
}
