import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPLOYEE_TOOLS,
  FORBIDDEN_TOOL_INPUT_KEYS,
  assertNoIdentityInputs,
  isEmployeeTool,
} from "./employee-tool-defs";

/**
 * These tests are the enforcement half of Employee Penny's access model. The
 * route authorizes ONE email; if a tool can be handed a different one, every
 * other guarantee in docs/features/employee-penny-ai.md is decorative.
 */

test("SECURITY: no employee tool accepts an identity argument", () => {
  const offenders = assertNoIdentityInputs();
  assert.deepEqual(
    offenders,
    [],
    `An employee tool takes an identity input (${offenders.join(", ")}). ` +
      "The subject is pinned by the route via authorizeEmailAccess and closed over in " +
      "EmployeeToolContext — an input like work_email would let a prompt-injected " +
      "message choose whose data is returned. Read the data from ctx instead.",
  );
});

test("SECURITY: the only input any employee tool declares is a bounded `weeks`", () => {
  // Stated as an allowlist rather than a denylist: a new input named something
  // the FORBIDDEN list never imagined (e.g. `subject`, `for_user`) should also
  // fail this test.
  const ALLOWED_INPUTS = new Set(["weeks"]);
  for (const tool of EMPLOYEE_TOOLS) {
    const schema = tool.input_schema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    for (const key of Object.keys(schema.properties ?? {})) {
      assert.ok(
        ALLOWED_INPUTS.has(key),
        `${tool.name} declares input "${key}" — employee tools may only take non-identity ` +
          `scalars (currently just "weeks"). Add it to ALLOWED_INPUTS here only after ` +
          `confirming it cannot select a person.`,
      );
    }
    // Nothing is required: a tool that needs an argument is a tool the model can
    // get wrong, and every one of these answers a question about "me".
    assert.deepEqual(
      schema.required ?? [],
      [],
      `${tool.name} marks an input required; employee tools must work with {} alone.`,
    );
  }
});

test("SECURITY: the guard catches an identity input if one is added", () => {
  // Proves the guard isn't vacuously passing.
  const sabotaged = [
    {
      name: "get_my_pay",
      description: "x",
      input_schema: {
        type: "object" as const,
        properties: { work_email: { type: "string" } },
      },
    },
  ];
  assert.deepEqual(assertNoIdentityInputs(sabotaged), ["get_my_pay.work_email"]);
});

test("the forbidden-key list covers the identity shapes used elsewhere in the codebase", () => {
  // ceo-tools/admin-tools take these; they are exactly what must never appear here.
  for (const key of ["work_email", "email", "employee_email", "query", "name"]) {
    assert.ok(
      (FORBIDDEN_TOOL_INPUT_KEYS as readonly string[]).includes(key),
      `${key} should be a forbidden employee-tool input`,
    );
  }
});

test("every tool is self-scoped by name and description", () => {
  assert.ok(EMPLOYEE_TOOLS.length > 0);
  for (const tool of EMPLOYEE_TOOLS) {
    const selfScoped =
      tool.name.startsWith("get_my_") || tool.name.startsWith("get_company_");
    assert.ok(
      selfScoped,
      `${tool.name} is neither get_my_* (this employee) nor get_company_* (public to all ` +
        "employees). A third category would mean a tool reading someone else.",
    );
    assert.ok(
      typeof tool.description === "string" && tool.description.length > 40,
      `${tool.name} needs a real description — it is the only thing telling Haiku when to call it`,
    );
    assert.ok(isEmployeeTool(tool.name));
  }
});

test("no CEO/Admin tool name leaks into the employee set", () => {
  // A shared name would make the route's dispatch ambiguous and could route an
  // employee's turn into an unscoped implementation.
  const ELEVATED_ONLY = [
    "find_employee",
    "get_employee_pay",
    "get_employee_profile",
    "get_employee_access",
    "get_payroll_report",
    "get_overtime_leaders",
    "get_department_bonuses",
    "get_financial_summary",
    "search_audit_log",
    "run_diagnostics",
    "get_bank_change_history",
    "get_change_timeline",
    "get_rate_history",
  ];
  for (const name of ELEVATED_ONLY) {
    assert.equal(
      isEmployeeTool(name),
      false,
      `${name} is an elevated tool and must not be exposed to employees`,
    );
  }
});

test("the bonus tool never claims to judge attendance eligibility", () => {
  // The PAB verdict depends on daily hours, disputes, adjustments and holiday
  // forgiveness — recomputing it here would contradict the employee's own PAB
  // calendar. The tool must keep pointing at the calendar instead.
  const tool = EMPLOYEE_TOOLS.find((t) => t.name === "get_my_bonus_status");
  assert.ok(tool);
  assert.match(tool.description ?? "", /PAB calendar/i);
});

test("the policy tool's description carries the do-not-invent rule", () => {
  // team-policies.ts omits the workday window and time-off notice for teams
  // with no published page ON PURPOSE (docs/features/employee-team-directory.md).
  // If that instruction ever falls out of the description, Haiku will happily
  // supply a plausible default.
  const tool = EMPLOYEE_TOOLS.find((t) => t.name === "get_company_policies");
  assert.ok(tool);
  assert.match(tool.description ?? "", /has_team_page/);
  assert.match(tool.description ?? "", /Never state a shift time|notice period/i);
});

test("HARDENING GUARD: the tech-bonus week comes from the override-aware gate", () => {
  // The NEGATIVE half of this rule — no file may call the raw heuristic — is
  // owned by the repo-wide scan in tech-bonus-week.test.ts, which already walks
  // all of src/ and therefore covers employee-tools.ts. Deliberately NOT
  // duplicated here: writing that pattern as a regex literal in this file makes
  // this file an offender in that scan (it did, first run), and widening that
  // guard's allowlist to accommodate a redundant copy would weaken the only
  // check that matters.
  //
  // What is NOT redundant is the positive: Penny must actually ASK the gate. A
  // bonus tool that answered "which week is the tech bonus" without reading
  // `tech_bonus_week_overrides` would quietly tell people the heuristic's week
  // while payroll paid the wizard's configured one.
  const src = readFileSync(
    join(process.cwd(), "src/lib/anthropic/employee-tools.ts"),
    "utf8",
  );
  assert.ok(
    src.includes("resolveIsTechBonusWeek"),
    "employee-tools.ts must resolve the tech week through resolveIsTechBonusWeek(monday, overrides)",
  );
  assert.ok(
    src.includes("parseTechBonusWeekOverrides"),
    "the overrides map must be parsed and passed — the gate falls back to the heuristic without it",
  );
});

test("HARDENING GUARD: employee-tools reads its subject only from ctx", () => {
  // A tool body reaching into `input` for anything but `weeks` would defeat the
  // schema guard above — the schema is what Claude sees, not what the code obeys.
  const src = readFileSync(
    join(process.cwd(), "src/lib/anthropic/employee-tools.ts"),
    "utf8",
  );
  const inputReads = [...src.matchAll(/\binput\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(inputReads)].sort(),
    ["weeks"],
    "employee-tools.ts reads a property other than `weeks` off the model-supplied input",
  );
});
