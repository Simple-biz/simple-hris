import test from "node:test";
import assert from "node:assert/strict";
import {
  buildManagerSuspendPayload,
  buildManagerReactivatePayload,
} from "./manager-temp-pause-webhooks";

const PERSON = {
  work_email: "jordan.cr@simple.biz",
  personal_email: "jordan.cruz@gmail.com",
  name: "Jordan Cruz",
  departments: ["Lead Gen - US", "SSD"],
  start_date: "2026-01-12",
};

test("manager suspend envelope mirrors the HR temporary_pause offboard envelope", () => {
  const env = buildManagerSuspendPayload(PERSON, "alex.rivera@simple.biz", "2026-08-05T09:15:00.000Z");

  // These five fields are the existing n8n offboarding-deactivate contract —
  // the flow branches to suspend-only on deletion_mode/reason. Changing any of
  // them silently changes what happens to the person's account.
  assert.equal(env.event, "employee.offboarded");
  assert.equal(env.phase, "deactivate");
  assert.equal(env.deletion_mode, "none");
  assert.equal(env.hubstaff_pay_rate, 0);
  assert.equal(env.employees[0].reason, "temporary_pause");

  // Temp pause must NEVER schedule a deletion.
  assert.equal(env.employees[0].scheduled_deletion_at, null);

  // Distinguishes a manager-button suspend from an HR queue temp pause.
  assert.equal(env.source, "manager_suspend");

  // Each employee item is self-contained after n8n's Split Out.
  const emp = env.employees[0];
  assert.equal(env.count, 1);
  assert.equal(emp.work_email, "jordan.cr@simple.biz");
  assert.equal(emp.personal_email, "jordan.cruz@gmail.com");
  assert.equal(emp.name, "Jordan Cruz");
  assert.deepEqual(emp.departments, ["Lead Gen - US", "SSD"]);
  assert.equal(emp.start_date, "2026-01-12");
  assert.equal(emp.off_boarded_by, "alex.rivera@simple.biz");
  assert.equal(emp.off_boarded_at, "2026-08-05T09:15:00.000Z");
});

test("manager reactivate envelope carries the reactivate action end to end", () => {
  const env = buildManagerReactivatePayload(PERSON, "alex.rivera@simple.biz", "2026-08-05T10:00:00.000Z");

  assert.equal(env.event, "employee.reactivated");
  assert.equal(env.action, "reactivate");
  assert.equal(env.source, "manager_reactivate");
  assert.equal(env.count, 1);

  const emp = env.employees[0];
  assert.equal(emp.action, "reactivate");
  assert.equal(emp.work_email, "jordan.cr@simple.biz");
  assert.deepEqual(emp.departments, ["Lead Gen - US", "SSD"]);
  assert.equal(emp.triggered_by, "alex.rivera@simple.biz");
  assert.equal(emp.triggered_at, "2026-08-05T10:00:00.000Z");
});

test("builders preserve nulls for people with partial identities", () => {
  const partial = { work_email: null, personal_email: "p@gmail.com", name: null, departments: [], start_date: null };
  const sus = buildManagerSuspendPayload(partial, "m@simple.biz", "2026-08-05T00:00:00.000Z");
  assert.equal(sus.employees[0].work_email, null);
  assert.equal(sus.employees[0].name, null);
  assert.equal(sus.employees[0].start_date, null);
  assert.deepEqual(sus.employees[0].departments, []);
  const rea = buildManagerReactivatePayload(partial, "m@simple.biz", "2026-08-05T00:00:00.000Z");
  assert.equal(rea.employees[0].work_email, null);
  assert.deepEqual(rea.employees[0].departments, []);
});
