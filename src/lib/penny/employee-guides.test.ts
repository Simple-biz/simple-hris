import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildEmployeeGuides,
  noticePolicyBodyFrom,
  type EmployeeGuide,
} from "./employee-guides";
import {
  COMPANY_WIDE_POLICIES,
  policiesForDeptKey,
  departmentsWithPublishedPolicies,
} from "@/lib/policies/team-policies";

/**
 * Two jobs here.
 *
 * 1. The notice period must never be invented. `team-policies.ts` omits it on
 *    purpose for teams with no published page (docs/features/employee-team-directory.md:176)
 *    and these guides are the newest place that could quietly supply a default.
 * 2. Every navigation label must still exist in the component it names. A guide
 *    is only worth shipping while it is accurate, and labels change without
 *    anyone thinking about Penny.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const guideFor = (gs: EmployeeGuide[], key: EmployeeGuide["key"]) => {
  const g = gs.find((x) => x.key === key);
  assert.ok(g, `missing guide: ${key}`);
  return g;
};
const allText = (g: EmployeeGuide) =>
  [g.title, g.where, ...g.steps, ...g.notes].join("\n");

const WITH_PAGE = {
  noticePolicyBody:
    "Reach out to us two weeks in advance for planned time off. You will receive a bonus if you do not miss a workday (requires working at least 7 hours on all five days of the work week).",
  hasTeamPage: true,
  teamLabel: "AI/Automation",
};
const NO_PAGE = { noticePolicyBody: null, hasTeamPage: false, teamLabel: "Company-wide" };

/* ── The notice period ───────────────────────────────────────────────────── */

test("a published notice period is quoted VERBATIM", () => {
  const leave = guideFor(buildEmployeeGuides(WITH_PAGE), "leave");
  const notes = leave.notes.join("\n");
  assert.ok(
    notes.includes(WITH_PAGE.noticePolicyBody),
    "the team's own sentence must appear unaltered — not summarised into a number",
  );
  assert.ok(notes.includes("AI/Automation"), "and be attributed to the team it came from");
});

test("NO notice period is invented when the team publishes none", () => {
  // The rule this whole test file exists for.
  const leave = guideFor(buildEmployeeGuides(NO_PAGE), "leave");
  const text = allText(leave);
  for (const invented of [
    "one week",
    "two weeks",
    "1 week",
    "2 weeks",
    "14 days",
    "7 days",
    "a week in advance",
    "two days",
  ]) {
    assert.equal(
      text.toLowerCase().includes(invented.toLowerCase()),
      false,
      `guide invented a notice period ("${invented}") for a team that publishes none`,
    );
  }
  // It must say so, and point at the manager.
  assert.match(text, /does not state|deliberately does not state/i);
  assert.match(text, /manager/i);
});

test("a team WITH a page but no attendance policy also gets no default", () => {
  const leave = guideFor(
    buildEmployeeGuides({ ...NO_PAGE, hasTeamPage: true, teamLabel: "Some Team" }),
    "leave",
  );
  assert.match(allText(leave), /does not state an advance-notice period/i);
});

test("noticePolicyBodyFrom reads the attendance policy and nothing else", () => {
  assert.equal(
    noticePolicyBodyFrom([{ id: "overtime", body: "The weekly cap is 45 hours." }]),
    null,
    "the overtime policy is not the notice period",
  );
  assert.equal(
    noticePolicyBodyFrom([{ id: "attendance", body: "Reach out one week ahead." }]),
    "Reach out one week ahead.",
  );
  assert.equal(noticePolicyBodyFrom([]), null);
});

/* ── Wired to the real policy source ────────────────────────────────────── */

test("every team that publishes a notice period gets it; the fallback gets none", () => {
  // Measured against the live policy table, so a future edit to team-policies.ts
  // shows up here rather than silently changing what Penny tells people.
  const published = departmentsWithPublishedPolicies();
  assert.ok(published.length >= 10, "expected at least the 10 published team pages");

  for (const key of published) {
    const set = policiesForDeptKey(key);
    const body = noticePolicyBodyFrom(set.policies);
    assert.ok(body, `${key} publishes a page but no attendance/notice policy`);
    const leave = guideFor(
      buildEmployeeGuides({
        noticePolicyBody: body,
        hasTeamPage: set.deptKey !== null,
        teamLabel: set.teamLabel,
      }),
      "leave",
    );
    assert.ok(leave.notes.join("\n").includes(body), `${key}'s sentence must be quoted`);
  }

  // And the company-wide fallback still carries no attendance policy at all.
  assert.equal(
    noticePolicyBodyFrom(COMPANY_WIDE_POLICIES.policies),
    null,
    "the company-wide fallback must keep omitting the notice period",
  );
});

/* ── The form enforces nothing — say so ─────────────────────────────────── */

test("the leave guide states the form does NOT enforce the notice period", () => {
  // EmployeeLeaves validates only min={today} and end >= start. Implying the
  // system blocks a short-notice request would be a plain lie.
  for (const ctx of [WITH_PAGE, NO_PAGE]) {
    const text = allText(guideFor(buildEmployeeGuides(ctx), "leave"));
    assert.match(text, /does not enforce a notice period/i);
  }
});

test("the leave guide never promises approval or a leave balance", () => {
  const text = allText(guideFor(buildEmployeeGuides(WITH_PAGE), "leave"));
  assert.match(text, /does not track a leave balance/i);
  assert.equal(/will be approved/i.test(text), false);
});

/* ── Labels must match the components ───────────────────────────────────── */

test("the leave guide's labels exist in EmployeeLeaves.tsx", () => {
  const src = read("src/components/employee/EmployeeLeaves.tsx");
  for (const label of ["New request", "My requests"]) {
    assert.ok(src.includes(`label="${label}"`), `sub-tab "${label}" no longer exists`);
  }
  // Every leave type the guide offers must be a real option.
  const guide = guideFor(buildEmployeeGuides(WITH_PAGE), "leave");
  for (const type of ["Vacation", "Sick", "Personal", "Bereavement", "Other"]) {
    assert.ok(src.includes(`value: '${type}'`), `leave type ${type} is gone from the form`);
    assert.ok(guide.steps.join(" ").includes(type), `guide omits leave type ${type}`);
  }
});

test("the document guides' labels exist in the profile + documents source", () => {
  const profile = read("src/components/employee/EmployeeProfile.tsx");
  for (const tab of ["Pay Stubs", "Request Documents"]) {
    assert.ok(profile.includes(`label: '${tab}'`), `Profile tab "${tab}" no longer exists`);
  }

  const types = read("src/lib/documents/types.ts");
  const coe = guideFor(buildEmployeeGuides(WITH_PAGE), "coe");
  const pay = guideFor(buildEmployeeGuides(WITH_PAGE), "payslips");
  // The exact strings the picker shows.
  assert.ok(types.includes("'Certificate of Engagement (COE)'"));
  assert.ok(allText(coe).includes("Certificate of Engagement (COE)"));
  assert.ok(types.includes("'Pay Summary / Pay Slips'"));
  assert.ok(allText(pay).includes("Pay Summary / Pay Slips"));

  const tab = read("src/components/employee/RequestDocumentsTab.tsx");
  for (const label of ["Request certificate", "Submit request", "Signed document"]) {
    assert.ok(tab.includes(label), `button/label "${label}" no longer exists`);
    assert.ok(
      allText(coe).includes(label) || allText(pay).includes(label),
      `no guide mentions "${label}"`,
    );
  }
  // The period options the pay-stub request offers.
  for (const period of ["Last 3 months", "Last 6 months", "Last 12 months"]) {
    assert.ok(tab.includes(period), `period option "${period}" is gone`);
  }
});

/* ── The COE guide's two counter-intuitive facts ─────────────────────────── */

test("the COE guide says there is nothing to attach", () => {
  // The single most common wrong expectation: employees look for a file input.
  const text = allText(guideFor(buildEmployeeGuides(WITH_PAGE), "coe"));
  assert.match(text, /No file to attach|attaches nothing|nothing to attach/i);
});

test("the COE guide warns it can be refused, and never promises one", () => {
  const text = allText(guideFor(buildEmployeeGuides(WITH_PAGE), "coe"));
  assert.match(text, /REFUSED|refused|declines/);
  assert.match(text, /start date|department|pay rate/i);
});

test("the pay-stub guide separates the self-download from the signed copy", () => {
  // Getting these two confused is why people wait days for a file they could
  // have downloaded in one click.
  const g = guideFor(buildEmployeeGuides(WITH_PAGE), "payslips");
  assert.match(allText(g), /needs nobody's approval|instant/i);
  assert.match(allText(g), /bank|loan|visa|tax/i);
  assert.ok(g.where.includes("Pay Stubs") && g.where.includes("Request Documents"));
});

test("the pay-stub guide flags reconstructed weeks as estimates", () => {
  const text = allText(guideFor(buildEmployeeGuides(WITH_PAGE), "payslips"));
  assert.match(text, /estimate/i);
});

/* ── Shape ──────────────────────────────────────────────────────────────── */

test("all three guides are present and non-empty", () => {
  const guides = buildEmployeeGuides(WITH_PAGE);
  assert.deepEqual(
    guides.map((g) => g.key),
    ["coe", "payslips", "leave"],
  );
  for (const g of guides) {
    assert.ok(g.title.length > 8, `${g.key} needs a title`);
    assert.ok(g.where.includes("→"), `${g.key}'s "where" must be a navigation path`);
    assert.ok(g.steps.length >= 4, `${g.key} needs real steps`);
    assert.ok(g.notes.length >= 1, `${g.key} needs at least one note`);
  }
});

test("no guide claims Penny can do the thing for them", () => {
  // Penny is read-only. A guide that says "I'll file it" is a promise it cannot
  // keep, and the prompt's refusal rules would then contradict its own tool.
  for (const g of buildEmployeeGuides(WITH_PAGE)) {
    const text = allText(g).toLowerCase();
    for (const phrase of ["i can file", "i will file", "i'll submit", "i can submit", "i can request that for you"]) {
      assert.equal(text.includes(phrase), false, `${g.key} promises an action Penny cannot take`);
    }
  }
});
