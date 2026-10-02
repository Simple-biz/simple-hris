/**
 * READ-ONLY verifier for Admin Penny's ID card (2026-10-02) — runs the REAL
 * `runAdminTool()` the chat route calls, against production data.
 *
 * Kane asked Penny for his ID card and got the Penny mascot: list_employee_attachments
 * returned every FILE on record, and one of his was a time-adjustment screenshot of
 * the mascot. The badge is not a file. This checks the new path end to end:
 *
 *   1. `get_employee_id_card` returns exactly ONE openable entry, source `id_card`,
 *      whose ref parses — and nothing else for the console to show.
 *   2. The badge's values are the ones the Employee Profile reads (`/api/employees`
 *      roster match + master-record address supplement).
 *   3. `list_employee_attachments` refuses `source: "id_card"` by name, and its
 *      schema no longer offers it.
 *   4. An off-boarded person resolves to NO badge.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/verify-penny-id-card.mts [active-email] [leaver-email]
 *
 * Defaults: kaner@simple.biz and adrianm@simple.biz (off-boarded 2026-09-14).
 * Only SELECTs are issued. Exit code 1 when any check fails.
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const active = (process.argv[2] ?? "kaner@simple.biz").toLowerCase();
const leaver = (process.argv[3] ?? "adrianm@simple.biz").toLowerCase();

const { runAdminTool, ADMIN_TOOLS, CEO_ADMIN_TOOLS } = await import("../src/lib/anthropic/admin-tools");
const { parseAttachmentRef } = await import("../src/lib/penny/attachment-refs");
const { findRosterRowByEmail, getEmployees } = await import("../src/lib/supabase/employees");
const { resolveIdCardForEmail } = await import("../src/lib/employee/id-card-server");

type Rec = Record<string, unknown>;
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

console.log(`\n1. get_employee_id_card(${active})`);
const res = (await runAdminTool("get_employee_id_card", { work_email: active })) as Rec;
const atts = (res.attachments ?? []) as Rec[];
check("no error", !res.error, String(res.error ?? ""));
check("exactly one openable entry", atts.length === 1, `${atts.length}`);
const ref = parseAttachmentRef(atts[0]?.ref);
check("its ref parses as id_card for this person", ref?.source === "id_card" && ref.id === active, String(atts[0]?.ref));
console.log("     card:", JSON.stringify(res.id_card));
console.log("     gaps:", JSON.stringify(res.gaps));

console.log(`\n2. the badge matches what the Profile reads`);
const roster = await getEmployees();
const me = findRosterRowByEmail(roster.employees, active);
const card = res.id_card as Rec | null;
check("roster row found", !!me);
check("name", card?.name === (me?.name?.trim() || card?.name), `${card?.name} vs ${me?.name}`);
check("employee_id is the roster's (not a single-row placeholder)", card?.employee_id === (me?.employee_id ?? null), `${card?.employee_id} vs ${me?.employee_id}`);
const direct = await resolveIdCardForEmail(active);
check("the open endpoint's resolver agrees with the tool", direct.ok && direct.card.employeeId === card?.employee_id && direct.card.name === card?.name);

console.log(`\n3. list_employee_attachments no longer offers the drawing`);
const refused = (await runAdminTool("list_employee_attachments", { work_email: active, source: "id_card" })) as Rec;
check("source id_card is refused by name", typeof refused.error === "string" && /get_employee_id_card/.test(String(refused.error)), String(refused.error));
const listDef = ADMIN_TOOLS.find((t) => t.name === "list_employee_attachments");
const enumVals = ((listDef?.input_schema as Rec)?.properties as Rec)?.source as Rec;
check("schema enum excludes id_card", Array.isArray(enumVals?.enum) && !(enumVals.enum as string[]).includes("id_card"));
check("withheld from the CEO route", !CEO_ADMIN_TOOLS.some((t) => t.name === "get_employee_id_card"));

console.log(`\n4. an off-boarded person has no badge (${leaver})`);
const gone = (await runAdminTool("get_employee_id_card", { work_email: leaver })) as Rec;
check("no badge and no openable entry", gone.id_card === null && !gone.attachments, JSON.stringify(gone).slice(0, 200));

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
