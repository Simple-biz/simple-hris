import test from "node:test";
import assert from "node:assert/strict";
import { departmentMatchesManagedAssignments } from "@/lib/managed-department-scope";
import {
  accessOverPerson,
  accessSummary,
  dashboardAccess,
  holdersOfRole,
  managersOfDepartment,
  type AccessData,
} from "./access-graph";

const at = "2026-09-01T00:00:00Z";

const DATA: AccessData = {
  roster: [
    { name: "Ana Cruz", work_email: "ana@simple.biz", personal_email: "ana@gmail.com", department: "Lead Generation" },
    {
      name: "Ben Reyes",
      work_email: "ben@simple.biz",
      alternate_work_email: "ben.alt@simple.biz",
      department: "Accounting",
    },
    { name: "Cy Tan", work_email: "cy@simple.biz", department: "Lead Gen" },
    { name: "Dee Lim", work_email: "dee@simple.biz", department: "Support" },
  ],
  roles: [
    { work_email: "ben.alt@simple.biz", role: "manager", assigned_by: "kaner@simple.biz", assigned_at: at },
    { work_email: "ben@simple.biz", role: "accounting", assigned_by: "kaner@simple.biz", assigned_at: at },
    { work_email: "kaner@simple.biz", role: "admin", assigned_by: null, assigned_at: at },
    { work_email: "boss@simple.biz", role: "ceo", assigned_by: null, assigned_at: at },
    { work_email: "dee@simple.biz", role: "hr_coordinator", assigned_by: null, assigned_at: at },
  ],
  managers: [
    // "Lead Gen" grant must cover a "Lead Generation" roster row — the routes' matcher does.
    { manager_email: "ben@simple.biz", department: "Lead Gen", assigned_by: "kaner@simple.biz", assigned_at: at },
    { manager_email: "cy@simple.biz", department: "Lead Gen", assigned_by: null, assigned_at: at },
    { manager_email: "dee@simple.biz", department: "Support", assigned_by: null, assigned_at: at },
  ],
  tabs: [
    { work_email: "ben@simple.biz", view_key: "accounting", feature: "people", access: "view", granted_by: null, granted_at: at },
    { work_email: "ben.alt@simple.biz", view_key: "accounting", feature: "people", access: "edit", granted_by: null, granted_at: at },
    { work_email: "dee@simple.biz", view_key: "accounting", feature: "mesa", access: "edit", granted_by: null, granted_at: at },
    { work_email: "cy@simple.biz", view_key: "accounting", feature: "people", access: "hidden", granted_by: null, granted_at: at },
  ],
};

test("negative control: the routes' matcher really does treat Lead Gen and Lead Generation as one department", () => {
  assert.equal(departmentMatchesManagedAssignments("Lead Generation", ["Lead Gen"]), true);
  assert.equal(departmentMatchesManagedAssignments("Support", ["Lead Gen"]), false);
});

test("managers of a person are found by the SAME matcher the manager routes enforce", () => {
  const r = accessOverPerson("ana@simple.biz", DATA);
  assert.deepEqual(r.departments, ["Lead Generation"]);
  assert.deepEqual(r.department_managers.map((m) => m.email), ["ben@simple.biz", "cy@simple.biz"]);
  assert.equal(r.department_managers.every((m) => m.covers_department === "Lead Generation"), true);
});

test("a person is found by any of their addresses", () => {
  const r = accessOverPerson("ana@gmail.com", DATA);
  assert.equal(r.person.email, "ana@simple.biz");
  assert.equal(r.department_managers.length, 2);
});

test("a role on an ALTERNATE address joins the grant on the primary one", () => {
  const r = accessOverPerson("ana@simple.biz", DATA);
  const ben = r.department_managers.find((m) => m.email === "ben@simple.biz")!;
  const cy = r.department_managers.find((m) => m.email === "cy@simple.biz")!;
  assert.equal(ben.holds_manager_role, true, "manager role is keyed on ben.alt@");
  assert.equal(cy.holds_manager_role, false, "a grant without the role never opens /manager");
});

test("company-wide access lists elevated and rate-visible roles, admin first, and flags off-roster holders", () => {
  const r = accessOverPerson("ana@simple.biz", DATA);
  const emails = r.company_wide_access.map((c) => c.email);
  assert.equal(emails[0], "kaner@simple.biz");
  assert.deepEqual([...emails].sort(), ["ben@simple.biz", "boss@simple.biz", "dee@simple.biz", "kaner@simple.biz"]);
  const boss = r.company_wide_access.find((c) => c.email === "boss@simple.biz")!;
  assert.equal(boss.can_see_pay_rates, true);
  assert.equal(boss.can_act_on_any_employee, false, "ceo is NOT elevated");
  const dee = r.company_wide_access.find((c) => c.email === "dee@simple.biz")!;
  assert.equal(dee.can_see_pay_rates, false, "hr_coordinator never sees rates");
  assert.equal(r.company_wide_access.find((c) => c.email === "kaner@simple.biz")!.on_active_roster, false);
});

test("a person with no department gets no managers — never every manager", () => {
  const r = accessOverPerson("stranger@simple.biz", { ...DATA });
  assert.deepEqual(r.departments, []);
  assert.deepEqual(r.department_managers, []);
  assert.equal(r.person.on_active_roster, false);
});

test("managersOfDepartment matches like the routes and offers the known grants on a miss", () => {
  assert.deepEqual(managersOfDepartment("lead generation", DATA).managers.map((m) => m.email), [
    "ben@simple.biz",
    "cy@simple.biz",
  ]);
  const miss = managersOfDepartment("Nowhere", DATA);
  assert.deepEqual(miss.managers, []);
  assert.deepEqual(miss.known_department_grants, ["Lead Gen", "Support"]);
});

test("holdersOfRole folds aliases and lists known roles on a miss", () => {
  const r = holdersOfRole("MANAGER", DATA);
  assert.equal(r.holder_count, 1);
  assert.equal(r.holders[0]!.email, "ben@simple.biz");
  assert.ok(holdersOfRole("wizard", DATA).known_roles!.includes("ceo"));
});

test("dashboardAccess: most-permissive grant wins, hidden is not access, grant without an opening role is dormant", () => {
  const r = dashboardAccess("accounting", DATA, {
    catalog: [
      { key: "people", label: "People" },
      { key: "mesa", label: "MESA" },
    ],
    openingRoles: ["accounting", "admin"],
  });
  const people = r.tabs.find((t) => t.tab === "People")!;
  assert.deepEqual(people.edit.map((h) => h.email), ["ben@simple.biz"]);
  assert.deepEqual(people.view, [], "ben's view grant is superseded by his edit grant");
  assert.equal(people.edit[0]!.dormant, false);
  const mesa = r.tabs.find((t) => t.tab === "MESA")!;
  assert.equal(mesa.edit[0]!.email, "dee@simple.biz");
  assert.equal(mesa.edit[0]!.dormant, true, "dee holds no role that opens /accounting");
  assert.deepEqual(r.can_open.map((h) => h.email), ["ben@simple.biz"]);
  assert.deepEqual(r.admins_bypass.map((h) => h.email), ["kaner@simple.biz"]);
});

test("accessSummary counts people, not addresses, and names grants held off the active roster", () => {
  const s = accessSummary(DATA);
  assert.equal(s.roles.find((r) => r.role === "manager")!.holder_count, 1);
  assert.deepEqual(
    s.department_managers.find((d) => d.department === "Lead Gen")!.managers,
    ["ben@simple.biz", "cy@simple.biz"],
  );
  assert.deepEqual(s.grants_held_by_addresses_not_on_active_roster, ["boss@simple.biz", "kaner@simple.biz"]);
});
