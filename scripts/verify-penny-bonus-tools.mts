/**
 * READ-ONLY verifier for the two Penny changes of 2026-09-15 — runs the REAL
 * `runCeoTool()` / `runAdminTool()` the chat routes call, against production
 * data, so what Penny can actually see is checked rather than a replica:
 *
 *   1. `find_employee` sees OFF-BOARDED people, labelled (Carla: adrianm@ was
 *      off-boarded 2026-09-14 and Penny said he was "not in the system").
 *   2. `get_offboarding_info` names when / why / who.
 *   3. `get_bonus_breakdown` traces a week's bonus to its calculator rows and
 *      reconciles them against the wizard snapshot.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/verify-penny-bonus-tools.mts [leaver-email] [week-date]
 *
 * Defaults: adrianm@simple.biz and 2026-09-09 (inside the 2026-09-06 week).
 * Only SELECTs are issued. Exit code 1 when any check fails.
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const leaver = (process.argv[2] ?? "adrianm@simple.biz").toLowerCase();
const weekDate = process.argv[3] ?? "2026-09-09";
const control = "adrianmo@simple.biz"; // an ACTIVE person with the near-identical address

const { runAdminTool, ADMIN_TOOLS } = await import("../src/lib/anthropic/admin-tools");
const { runCeoTool } = await import("../src/lib/anthropic/ceo-tools");

type Rec = Record<string, unknown>;
const line = (s: string) => console.log(`\n${"─".repeat(78)}\n${s}\n${"─".repeat(78)}`);
const j = (v: unknown, n = 1600) => {
  const s = JSON.stringify(v, null, 1);
  return s.length > n ? `${s.slice(0, n)}\n  …(truncated)` : s;
};
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

console.log(`Admin tools exposed: ${ADMIN_TOOLS.length}`);
check("get_offboarding_info is exposed", ADMIN_TOOLS.some((t) => t.name === "get_offboarding_info"));
check("get_bonus_breakdown is exposed", ADMIN_TOOLS.some((t) => t.name === "get_bonus_breakdown"));

// ── 1. find_employee sees the leaver, labelled ──────────────────────────────
line(`find_employee(${leaver})`);
const byEmail = (await runCeoTool("find_employee", { query: leaver })) as Rec;
console.log(j(byEmail));
const matches = (byEmail.matches ?? []) as Rec[];
const hit = matches.find((m) => String(m.work_email ?? "").toLowerCase() === leaver);
check("no lookup errors", !byEmail.lookup_errors, JSON.stringify(byEmail.lookup_errors ?? ""));
check("the leaver is FOUND", !!hit, `${matches.length} matches`);
check("…and labelled offboarded", hit?.status === "offboarded", String(hit?.status));
check("…with a departure date", typeof hit?.off_boarded_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(String(hit?.off_boarded_at)), String(hit?.off_boarded_at));
check("…and who recorded it", typeof hit?.off_boarded_by === "string" && String(hit?.off_boarded_by).includes("@"), String(hit?.off_boarded_by));
check("note says OFF-BOARDED and points to get_offboarding_info", /OFF-BOARDED/.test(String(byEmail.note ?? "")) && /get_offboarding_info/.test(String(byEmail.note ?? "")));

line(`find_employee(${control}) — control: an active person stays active`);
const ctrl = (await runCeoTool("find_employee", { query: control })) as Rec;
const ctrlHit = ((ctrl.matches ?? []) as Rec[]).find((m) => String(m.work_email ?? "").toLowerCase() === control);
console.log(j({ match_count: ctrl.match_count, hit: ctrlHit }, 600));
check("control person is found", !!ctrlHit);
check("control person is ACTIVE, not demoted by a stamped duplicate", ctrlHit?.status === "active", String(ctrlHit?.status));

line('find_employee("manansala") — name search reaches leavers');
const byName = (await runCeoTool("find_employee", { query: leaver.split("@")[0]!.slice(0, 6) })) as Rec;
console.log(j({ match_count: byName.match_count, active: byName.active_matches, offboarded: byName.offboarded_matches, note: byName.note }, 700));
check("a partial-name search returns at least one match", Number(byName.match_count ?? 0) >= 1);

// ── 2. get_offboarding_info ─────────────────────────────────────────────────
line(`get_offboarding_info(${leaver})`);
const off = (await runAdminTool("get_offboarding_info", { email: leaver })) as Rec;
console.log(j({ status: off.status, summary: off.summary, master_rows: off.master_rows, requests: off.offboarding_requests, sheet: off.offboarded_sheet, lookup_errors: off.lookup_errors }, 2600));
const offRows = (off.master_rows ?? []) as Rec[];
const offEvents = (off.audit_events ?? []) as Rec[];
check("no error", !off.error, String(off.error ?? ""));
check("status is offboarded", off.status === "offboarded", String(off.status));
check("every master row is stamped", offRows.length > 0 && offRows.every((r) => !!r.off_boarded_at), `${offRows.length} rows`);
check("no row is on the active roster", offRows.every((r) => r.on_active_roster === false));
check("summary names the recorder", /@/.test(String(off.summary ?? "")), String(off.summary).slice(0, 120));
check("an hr.employee.offboarded audit event is present", offEvents.some((e) => e.action === "hr.employee.offboarded"), `${offEvents.length} events`);
for (const e of offEvents.slice(0, 6)) console.log(`   ${String(e.when).slice(0, 19)}  ${String(e.action).padEnd(32)} ${e.actor}`);

// ── 3. get_bonus_breakdown ──────────────────────────────────────────────────
line(`get_bonus_breakdown(${leaver}, week=${weekDate})`);
const bb = (await runAdminTool("get_bonus_breakdown", { work_email: leaver, week: weekDate })) as Rec;
const week = (bb.week ?? {}) as Rec;
const shown = (bb.shown ?? {}) as Rec;
const sources = (bb.sources ?? {}) as Rec;
const recon = (bb.reconciliation ?? {}) as Rec;
console.log(j({ week, identity: bb.identity, shown, reconciliation: recon, coverage_notes: bb.coverage_notes }, 3200));
console.log("sources.hsl_kpi:", j(sources.hsl_kpi, 1400));
console.log("sources.payment_catalog:", j(sources.payment_catalog, 900));
console.log("sources.wizard_controls:", j(sources.wizard_controls, 600));
check("no error", !bb.error, String(bb.error ?? ""));
check("week snapped to its Sunday", /^\d{4}-\d{2}-\d{2}$/.test(String(week.start)) && new Date(`${week.start}T00:00:00Z`).getUTCDay() === 0, String(week.start));
check("an upload names the week (source_file resolved)", typeof week.source_file === "string" && String(week.source_file).includes(String(week.start)), String(week.source_file));
const hslRows = (sources.hsl_kpi ?? []) as Rec[];
const catRows = (sources.payment_catalog ?? []) as Rec[];
check("at least one calculator row was found", hslRows.length + catRows.length > 0, `${hslRows.length} HSL · ${catRows.length} catalog`);
check("every HSL row states payability", hslRows.every((r) => typeof r.payable === "boolean" && typeof r.period_status === "string"));
check("HSL inputs are labelled with the rule", hslRows.every((r) => ((r.inputs ?? []) as Rec[]).every((i) => typeof i.label === "string")));
check("wizard snapshot is present for the week", !!shown.wizard_snapshot, shown.wizard_snapshot ? "" : "no snapshot — did the wizard run this week?");
check("reconciliation has a verdict", ["matches", "unexplained", "no_shown_figure"].includes(String(recon.verdict)), String(recon.verdict));
check("explained total is a number", typeof recon.explained_other_bonuses === "number");
const idRows = ((bb.identity as Rec | undefined)?.master_rows ?? []) as Rec[];
check("identity lists the master rows", idRows.length >= 1, `${idRows.length} rows`);
if (idRows.length > 1) check("…and the note calls out the duplicate identity", /master rows/.test(String((bb.identity as Rec).note)));

line(`get_bonus_breakdown(${control}) — control: default week, active person`);
const bb2 = (await runAdminTool("get_bonus_breakdown", { work_email: control })) as Rec;
console.log(j({ week: bb2.week, identity_note: (bb2.identity as Rec | undefined)?.note, reconciliation: bb2.reconciliation, hsl: ((bb2.sources as Rec | undefined)?.hsl_kpi ?? []) as Rec[] }, 1400));
check("control: no error", !bb2.error, String(bb2.error ?? ""));
check("control: default week resolved", (bb2.week as Rec | undefined)?.resolved_from === "default_previous_week", String((bb2.week as Rec | undefined)?.resolved_from));

line("bad input is refused, not guessed");
const bad = (await runAdminTool("get_bonus_breakdown", { work_email: leaver, week: "Sep 6" })) as Rec;
check("a non-ISO week is an error", typeof bad.error === "string" && /YYYY-MM-DD/.test(String(bad.error)), String(bad.error));

line(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
