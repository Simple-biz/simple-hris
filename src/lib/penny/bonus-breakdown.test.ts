import test from "node:test";
import assert from "node:assert/strict";
import {
  assembleBonusBreakdown,
  resolveBonusWeek,
  type BonusBreakdownInput,
  type HslEntryIn,
} from "./bonus-breakdown";

/**
 * Fixtures follow the real case that motivated the tool: adrianm@simple.biz,
 * week 2026-09-06 — one ₱250 attestation KPI row, a ₱0 Lead Gen catalog row, a
 * wizard snapshot showing ₱250 of other bonuses, and TWO master rows.
 */

const labelRule: BonusBreakdownInput["labelRule"] = (dept, key) =>
  dept === "attestation" && key === "ssa_gov"
    ? { label: "SSA.Gov", how: "₱250 per unit" }
    : dept === "attestation" && key === "attested_cases"
      ? { label: "Attested cases", how: "tiered" }
      : null;

const attestation = (over: Partial<HslEntryIn> = {}): HslEntryIn => ({
  department: "attestation",
  employee_email: "adrianm@simple.biz",
  calculated_bonus: 250,
  kpi_data: { ssa_gov: 1, attested_cases: 10 },
  is_manager: false,
  period_type: "weekly",
  created_at: "2026-09-14T17:03:20Z",
  updated_at: "2026-09-14T17:06:16Z",
  ...over,
});

const base = (over: Partial<BonusBreakdownInput> = {}): BonusBreakdownInput => ({
  email: "adrianm@simple.biz",
  aliases: ["adrianm@simple.biz", "adrian.manansala1795@gmail.com"],
  week: { start: "2026-09-06", end: "2026-09-12" },
  week_resolved_from: "given_date",
  source_file: "simple-biz_daily_report_2026-09-06_to_2026-09-12.csv",
  master_rows: [
    { department: "Lead Gen", work_email: "adrianm@simple.biz", employee_id: "2606-0400", off_boarded_at: "2026-09-14", on_active_roster: false },
    { department: "hsl:attestation", work_email: "adrianm@simple.biz", employee_id: "2606-0486", off_boarded_at: "2026-09-14", on_active_roster: false },
  ],
  hsl_entries: [attestation()],
  hsl_status: [{ department: "attestation", status: "ready", locked_by: null, locked_at: null, updated_at: "2026-09-14T17:06:27Z" }],
  catalog_applied: [
    {
      department: "lead_gen",
      employee_email: "adrianm@simple.biz",
      bonus_name: "Lead Gen",
      kind: "formula",
      vars: { Appts_Set: 0 },
      amount: 0,
      applied_by: "carla@simple.biz",
      created_at: "2026-09-14T23:43:06Z",
      updated_at: "2026-09-15T15:16:08Z",
      cadence: "weekly",
    },
  ],
  snapshot: {
    updated_at: "2026-09-15T15:19:45Z",
    perfectAttendanceBonus: 0,
    techBonus: 1850,
    otherBonuses: 250,
    adjustment: 0,
    adjustmentNote: null,
    initial: 9615.03,
    final: 11715.03,
  },
  paystub: null,
  dispatches: [],
  wizard_controls: {
    accounting_adjustment: null,
    accounting_adjustment_note: null,
    toggles: { tech_bonus: true },
    wizard_department: "hogan_smith_law",
    wizard_department_manual: null,
    tech_manual_grant: false,
    tech_manual_revoke: false,
    blob_updated_at: "2026-09-15T15:19:38Z",
  },
  payroll_notes: [],
  lookup_errors: [],
  labelRule,
  ...over,
});

/* ── CLASS 1: the real case reconciles ───────────────────────────────────── */

test("CLASS 1: one payable HSL row + a ₱0 catalog row explain a ₱250 snapshot exactly", () => {
  const out = assembleBonusBreakdown(base());
  assert.equal(out.reconciliation.explained_other_bonuses, 250);
  assert.equal(out.reconciliation.shown_other_bonuses, 250);
  assert.equal(out.reconciliation.delta, 0);
  assert.equal(out.reconciliation.verdict, "matches");
  assert.equal(out.shown.wizard_snapshot?.tech_bonus, 1850);
  // Tech is NOT part of other_bonuses and must not be counted as unexplained.
  assert.equal(out.coverage_notes.some((n) => /add up to/.test(n)), false);
});

test("CLASS 1: KPI inputs are labelled through the rule lookup; unknown keys stay raw", () => {
  const out = assembleBonusBreakdown(base({ hsl_entries: [attestation({ kpi_data: { ssa_gov: 1, mystery: 4 } })] }));
  const inputs = out.sources.hsl_kpi[0]!.inputs;
  assert.deepEqual(inputs.find((i) => i.key === "ssa_gov"), { key: "ssa_gov", label: "SSA.Gov", value: 1, how: "₱250 per unit" });
  assert.deepEqual(inputs.find((i) => i.key === "mystery"), { key: "mystery", label: "mystery", value: 4, how: null });
});

/* ── CLASS 2: the ₱500 case — two calculators, one person ────────────────── */

test("CLASS 2: an HSL ₱250 plus a Lead Gen ₱250 explain a ₱500 snapshot, and the identity note names both departments", () => {
  const out = assembleBonusBreakdown(
    base({
      catalog_applied: [{ ...base().catalog_applied[0]!, vars: { Appts_Set: 1 }, amount: 250 }],
      snapshot: { ...base().snapshot!, otherBonuses: 500 },
    }),
  );
  assert.equal(out.reconciliation.explained_other_bonuses, 500);
  assert.equal(out.reconciliation.verdict, "matches");
  assert.match(out.identity.note, /2 master rows/);
  assert.match(out.identity.note, /Lead Gen · hsl:attestation/);
  assert.match(out.identity.note, /scored in 2 places/);
});

/* ── CLASS 3: a draft period is scored but never paid ────────────────────── */

test("CLASS 3: a DRAFT HSL period is excluded from the explained total and called out", () => {
  const out = assembleBonusBreakdown(
    base({
      hsl_status: [{ department: "attestation", status: "draft", locked_by: null, locked_at: null, updated_at: null }],
      snapshot: { ...base().snapshot!, otherBonuses: 0 },
    }),
  );
  assert.equal(out.sources.hsl_kpi[0]!.payable, false);
  assert.equal(out.reconciliation.explained_other_bonuses, 0);
  assert.equal(out.reconciliation.not_payable_total, 250);
  assert.equal(out.reconciliation.verdict, "matches");
  assert.ok(out.coverage_notes.some((n) => /DRAFT/.test(n) && /NOT submitted/.test(n)));
});

test("CLASS 3: an HSL row with NO status row at all is not payable either", () => {
  const out = assembleBonusBreakdown(base({ hsl_status: [] }));
  assert.equal(out.sources.hsl_kpi[0]!.period_status, "no_status_row");
  assert.equal(out.sources.hsl_kpi[0]!.payable, false);
});

/* ── CLASS 4: the shown figure cannot be explained ───────────────────────── */

test("CLASS 4: a ₱500 snapshot over ₱250 of sources is UNEXPLAINED and the note says KPI saves are unaudited", () => {
  const out = assembleBonusBreakdown(base({ snapshot: { ...base().snapshot!, otherBonuses: 500 } }));
  assert.equal(out.reconciliation.verdict, "unexplained");
  assert.equal(out.reconciliation.delta, 250);
  const note = out.coverage_notes.find((n) => /add up to ₱250\.00/.test(n)) ?? "";
  assert.match(note, /NOT audited/);
  assert.match(note, /snapshot_saved_at/);
});

test("CLASS 4: no snapshot and no paystub → no shown figure, never a false 'matches'", () => {
  const out = assembleBonusBreakdown(base({ snapshot: null }));
  assert.equal(out.reconciliation.verdict, "no_shown_figure");
  assert.equal(out.reconciliation.shown_other_bonuses, null);
  assert.equal(out.reconciliation.delta, null);
  assert.ok(out.coverage_notes.some((n) => /has not saved a final-pay snapshot/.test(n)));
});

test("CLASS 4: with no snapshot the paystub's Performance line stands in as the shown figure", () => {
  const out = assembleBonusBreakdown(
    base({
      snapshot: null,
      paystub: { paid: true, sent_at: "2026-09-09", techBonus: 1850, attendanceBonus: 0, performanceBonus: 250, adjustment: 0, adjustmentNote: null, totalPayPhp: 11715.03 },
    }),
  );
  assert.equal(out.reconciliation.shown_other_bonuses, 250);
  assert.equal(out.reconciliation.verdict, "matches");
});

/* ── CLASS 5: coverage is stated, never implied ──────────────────────────── */

test("CLASS 5: a week with no upload says so; lookup errors are carried into the notes verbatim", () => {
  const out = assembleBonusBreakdown(base({ source_file: null, snapshot: null, lookup_errors: ["payroll notes lookup failed: boom"] }));
  assert.ok(out.coverage_notes.includes("payroll notes lookup failed: boom"));
  assert.ok(out.coverage_notes.some((n) => /No Hubstaff upload names the week/.test(n)));
});

test("CLASS 5: a person with no calculator row anywhere is told where a non-zero figure could still come from", () => {
  const out = assembleBonusBreakdown(base({ hsl_entries: [], catalog_applied: [], snapshot: { ...base().snapshot!, otherBonuses: 0 } }));
  assert.ok(out.coverage_notes.some((n) => /No KPI calculator row/.test(n)));
  assert.equal(out.reconciliation.verdict, "matches");
});

test("CLASS 5: a single master row is described with its roster state", () => {
  const out = assembleBonusBreakdown(
    base({ master_rows: [{ department: "hsl:filing_specialist", work_email: "adrianmo@simple.biz", employee_id: "2607-0277", off_boarded_at: null, on_active_roster: true }] }),
  );
  assert.match(out.identity.note, /One master row \(hsl:filing_specialist\), on the active roster/);
});

/* ── CLASS 6: week resolution — Sundays only, arrears by default ─────────── */

/** Narrow the resolver's union for the happy-path assertions. */
function weekOf(r: ReturnType<typeof resolveBonusWeek>) {
  if ("error" in r) assert.fail(`expected a week, got error: ${r.error}`);
  return r.week;
}

test("CLASS 6: any weekday snaps to its own week's Sunday; a Sunday stays put", () => {
  assert.deepEqual(resolveBonusWeek("2026-09-09", "2026-09-15"), {
    week: { start: "2026-09-06", end: "2026-09-12" },
    resolved_from: "given_date",
  });
  assert.deepEqual(resolveBonusWeek("2026-09-06", "2026-09-15"), {
    week: { start: "2026-09-06", end: "2026-09-12" },
    resolved_from: "given_date",
  });
  // A Saturday belongs to the week that STARTED the previous Sunday.
  assert.deepEqual(weekOf(resolveBonusWeek("2026-09-12", "2026-09-15")), { start: "2026-09-06", end: "2026-09-12" });
});

test("CLASS 6: no week → the just-completed pay week (a week in arrears), read against Manila today", () => {
  // Tuesday 2026-09-15: this week's Sunday is 09-13, so the week being paid is 09-06.
  assert.deepEqual(resolveBonusWeek(null, "2026-09-15"), {
    week: { start: "2026-09-06", end: "2026-09-12" },
    resolved_from: "default_previous_week",
  });
  // On a Sunday the just-completed week is the one that ended yesterday.
  assert.deepEqual(weekOf(resolveBonusWeek("", "2026-09-13")), { start: "2026-09-06", end: "2026-09-12" });
});

test("CLASS 6: junk and impossible dates are refused, never silently snapped", () => {
  assert.deepEqual(resolveBonusWeek("Sep 6", "2026-09-15"), { error: 'week must be a YYYY-MM-DD date (got "Sep 6")' });
  assert.deepEqual(resolveBonusWeek("2026-02-30", "2026-09-15"), { error: 'week is not a real calendar date ("2026-02-30")' });
});
