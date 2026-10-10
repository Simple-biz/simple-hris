/**
 * READ-ONLY verifier for the 2026-10-09 change "Admin Penny does not know about
 * the Offboarded data". Runs the REAL `runCeoTool()` / `runAdminTool()` the chat
 * routes call, against production, so what Penny can see is measured rather
 * than assumed:
 *
 *   1. COVERAGE — every departure on the `offboarded_sheet` ledger is reachable
 *      by find_employee (as a leaver, or as the active person it belongs to).
 *      Before the change 2,810 of 4,462 rows were not.
 *   2. A ledger-only leaver (no master-list row) is found by email AND by name,
 *      labelled `recorded_in: ['offboarded_ledger']`, and get_offboarding_info
 *      says `offboarded_ledger_only` instead of "not on master list".
 *   3. A re-issued address (krisd@) reads ACTIVE, and the previous holder's
 *      ledger departure is flagged as someone else's.
 *   4. list_offboarded's counts equal a direct count of the same window, add
 *      back up to the total, and a bad filter is refused.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/verify-penny-offboarded-ledger.mts
 *
 * Only SELECTs are issued. Prints counts and PASS/FAIL lines, never personal
 * emails. Exit 1 when any check fails.
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const { runAdminTool, ADMIN_TOOLS, CEO_ADMIN_TOOLS } = await import("../src/lib/anthropic/admin-tools");
const { runCeoTool, readOffboardedLedgerForPenny } = await import("../src/lib/anthropic/ceo-tools");
const { categorizeReason } = await import("../src/lib/external-api/offboarded");
const { ledgerAddresses, collapseOffboardedRows, mergeLedgerLeavers, matchesRosterQuery } = await import("../src/lib/penny/roster-match");
const { getEmployeesForAuthorizedServerRoute } = await import("../src/lib/supabase/employees");
const { createSupabaseServiceRoleClient } = await import("../src/lib/supabase/server");
const { selectAllPaged } = await import("../src/lib/supabase/select-all-paged");

type Rec = Record<string, unknown>;
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

check("list_offboarded is an Admin tool", ADMIN_TOOLS.some((t) => t.name === "list_offboarded"));
check("list_offboarded reaches the CEO route", CEO_ADMIN_TOOLS.some((t) => t.name === "list_offboarded"));

// ── the raw tables, read the same way the tools read them ───────────────────
const sb = createSupabaseServiceRoleClient()!;
const ledger = await readOffboardedLedgerForPenny();
const stamped = await selectAllPaged<Rec>((f, t) =>
  sb.from("global_master_list").select('id, "Work Email", "Personal Email"').not("off_boarded_at", "is", null).order("id").range(f, t),
);
const master = await selectAllPaged<Rec>((f, t) =>
  sb.from("global_master_list").select('id, "Work Email", "Personal Email"').order("id").range(f, t),
);
check("ledger, stamped and master reads succeed", !ledger.error && !stamped.error && !master.error, [ledger.error, stamped.error, master.error].filter(Boolean).join("; "));
console.log(`  ledger rows ${ledger.rows.length} · stamped master rows ${stamped.rows.length} · master rows ${master.rows.length}`);

const masterEmails = new Set<string>();
for (const r of master.rows) for (const k of ["Work Email", "Personal Email"]) if (lower(r[k])) masterEmails.add(lower(r[k]));

// ── 2. a ledger-only leaver, newest first ────────────────────────────────────
const ledgerOnly = ledger.rows
  .filter((r) => categorizeReason(r.off_boarded_reason).kind !== "excluded")
  .filter((r) => {
    const { work, personal } = ledgerAddresses(r);
    return !!work && !!r.name && !r.name.includes("@") && !masterEmails.has(work) && !(personal && masterEmails.has(personal));
  })
  .sort((a, b) => b.id - a.id);
console.log(`  ledger departures whose addresses are on NO master row: ${ledgerOnly.length}`);
const sample = ledgerOnly[0];
check("there is a ledger-only leaver to test with", !!sample);
if (sample) {
  const { work } = ledgerAddresses(sample);
  const byEmail = (await runCeoTool("find_employee", { query: work! })) as Rec;
  const m = ((byEmail.matches as Rec[]) ?? [])[0];
  check("find_employee(email) finds the ledger-only leaver", byEmail.match_count === 1 && m?.status === "offboarded", `match_count ${byEmail.match_count}`);
  check("…labelled recorded_in = offboarded_ledger only", JSON.stringify(m?.recorded_in) === '["offboarded_ledger"]', JSON.stringify(m?.recorded_in));
  check("…and the note says there is no master-list row", /ONLY on the Offboarded ledger/.test(String(byEmail.note ?? "")));

  const surname = sample.name!.split(/[,\s]+/).filter((t) => t.length >= 3)[0] ?? sample.name!;
  const byName = (await runCeoTool("find_employee", { query: surname })) as Rec;
  check(
    "find_employee(name) includes the ledger-only leaver",
    ((byName.matches as Rec[]) ?? []).some((x) => lower(x.work_email) === work) || byName.truncated === true,
    `${byName.match_count} matches${byName.truncated ? " (truncated at 8 — not conclusive)" : ""}`,
  );

  const info = (await runAdminTool("get_offboarding_info", { email: work! })) as Rec;
  check("get_offboarding_info says offboarded_ledger_only", info.status === "offboarded_ledger_only", String(info.status));
  check("…and its ledger row carries the recorded name", ((info.offboarded_sheet as Rec[]) ?? []).some((r) => !!r.name));
}

// ── 1. coverage: EVERY ledger departure is reachable ─────────────────────────
// Reachable = a find_employee query on the row's own address returns SOME match
// (a leaver, or the active person the row belongs to). Exhaustive over all
// rows: the candidate set is built ONCE, exactly as findEmployee builds it,
// then every row is matched with the same `matchesRosterQuery` — one tool call
// per row would take an hour (each call reads every table).
const departures = ledger.rows.filter((r) => categorizeReason(r.off_boarded_reason).kind !== "excluded");
{
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const stampedFull = await selectAllPaged<Rec>((f, t) =>
    sb
      .from("global_master_list")
      .select('id, Name, Department, "Work Email", "Personal Email", employee_id, off_boarded_at, off_boarded_reason, off_boarded_by')
      .not("off_boarded_at", "is", null)
      .order("id")
      .range(f, t),
  );
  const roster = await getEmployeesForAuthorizedServerRoute();
  check("coverage reads succeed", !stampedFull.error && !roster.error, [stampedFull.error, roster.error].filter(Boolean).join("; "));
  const stampedRows = stampedFull.rows.map((r) => ({
    name: s(r["Name"]), work_email: s(r["Work Email"]), personal_email: s(r["Personal Email"]), department: s(r["Department"]),
    employee_id: s(r["employee_id"]), off_boarded_at: s(r["off_boarded_at"]), off_boarded_reason: s(r["off_boarded_reason"]), off_boarded_by: s(r["off_boarded_by"]),
  }));
  const activeWork = new Set(roster.employees.map((e) => lower(e.work_email)).filter(Boolean));
  const activeCands = roster.employees.map((e) => ({
    name: e.name ?? null, work_email: e.work_email ?? null, personal_email: e.personal_email ?? null, department: null,
    employee_id: null, status: "active" as const, off_boarded_at: null, off_boarded_reason: null, off_boarded_by: null, departments: [],
  }));
  const before = [...activeCands, ...collapseOffboardedRows(stampedRows, activeWork)];
  const after = [
    ...activeCands,
    ...mergeLedgerLeavers(
      ledger.rows,
      collapseOffboardedRows(stampedRows, activeWork),
      roster.employees.map((e) => ({ name: e.name ?? null, work_email: e.work_email ?? null, personal_email: e.personal_email ?? null })),
    ),
  ];
  // Index by both addresses: matchesRosterQuery on an email query is exact.
  const reach = (cands: typeof after) => {
    const idx = new Set<string>();
    for (const c of cands) for (const e of [c.work_email, c.personal_email]) if (lower(e)) idx.add(lower(e));
    return idx;
  };
  const beforeIdx = reach(before);
  const afterIdx = reach(after);
  let addressed = 0, reachBefore = 0, reachAfter = 0;
  const missed: number[] = [];
  for (const r of departures) {
    const { work, personal } = ledgerAddresses(r);
    const q = work ?? personal;
    if (!q) continue;
    addressed += 1;
    if (beforeIdx.has(q)) reachBefore += 1;
    if (afterIdx.has(q)) reachAfter += 1;
    else missed.push(r.id);
  }
  // Sanity: the index agrees with the real matcher on a sample.
  const probe = after.find((c) => c.status === "offboarded" && c.work_email);
  check("index agrees with matchesRosterQuery", !!probe && matchesRosterQuery(probe, probe.work_email!));
  console.log(`  ledger departures with an address: ${addressed} · reachable BEFORE ${reachBefore} · AFTER ${reachAfter}`);
  check("coverage: EVERY ledger departure with an address is reachable by find_employee", reachAfter === addressed, `${missed.length} unreachable; first ids ${missed.slice(0, 5).join(", ")}`);
}

// ── 3. a re-issued address ───────────────────────────────────────────────────
const kris = (await runAdminTool("get_offboarding_info", { email: "krisd@simple.biz" })) as Rec;
const krisRows = (kris.offboarded_sheet as Rec[]) ?? [];
check("krisd@ (re-issued) reads ACTIVE or MIXED, never as a leaver", kris.status === "active" || kris.status === "mixed", String(kris.status));
check(
  "…its previous holder's ledger departure is flagged as someone else's",
  krisRows.some((r) => r.same_person_as_active_holder === false) && /PREVIOUS holder/.test(String(kris.summary)),
  `${krisRows.length} ledger rows`,
);
const krisFind = (await runCeoTool("find_employee", { query: "krisd@simple.biz" })) as Rec;
const krisMatches = (krisFind.matches as Rec[]) ?? [];
check("find_employee(krisd@) ranks the ACTIVE holder first", krisMatches[0]?.status === "active");
check(
  "…and lists the previous holder separately, naming the current one",
  krisMatches.some((x) => x.status === "offboarded" && Array.isArray(x.work_email_now_held_by) && (x.work_email_now_held_by as unknown[]).length > 0),
);

// ── 4. list_offboarded ───────────────────────────────────────────────────────
const since = "2026-09-01";
const until = "2026-09-30";
const list = (await runAdminTool("list_offboarded", { since, until, limit: 10 })) as Rec;
check("list_offboarded runs", !list.error, String(list.error ?? ""));
const direct = departures.filter((r) => {
  const d = /^(\d{4}-\d{2}-\d{2})/.exec(r.off_boarded_at ?? "")?.[1];
  return !!d && d >= since && d <= until;
}).length;
check(`September total equals a direct count of the ledger`, list.total === direct, `tool ${list.total} vs direct ${direct}`);
const sum = (o: unknown) => Object.values((o ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);
check("by_reason adds up to the total", sum(list.by_reason) === list.total);
check("by_origin adds up to the total", sum(list.by_origin) === list.total);
check("rows are capped at the limit and truncation is reported", ((list.rows as Rec[]) ?? []).length <= 10 && list.truncated === (Number(list.total) > 10));
console.log(`  September: ${list.total} departures · by_reason ${JSON.stringify(list.by_reason)} · excluded ${JSON.stringify(list.not_departures_excluded)}`);
const bad = (await runAdminTool("list_offboarded", { reason: "fired" })) as Rec;
check("a bad filter is refused, not ignored", typeof bad.error === "string" && /reason must be one of/.test(bad.error as string));

// ── control: an active person is still active ────────────────────────────────
const control = (await runCeoTool("find_employee", { query: "kaner@simple.biz" })) as Rec;
check("control: kaner@ is found ACTIVE, first", ((control.matches as Rec[]) ?? [])[0]?.status === "active");

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
