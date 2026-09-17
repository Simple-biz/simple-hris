import test from "node:test";
import assert from "node:assert/strict";
import {
  applyReconciliation,
  buildReconciledPayWeeks,
  mergeDispatchesByWeek,
  mesaDeductionForWeek,
  totalsFor,
  type DispatchInput,
  type MesaDepositInput,
  type PayRecordInput,
  type PayWeekOutput,
} from "./pay-reconciliation";

/**
 * Carla's four weeks, measured read-only against production on 2026-09-17 for
 * `amiea@simple.biz`. These are the real figures the CEO was given a wrong
 * answer about, so the reconciliation is pinned against them exactly.
 */

const REC = (o: Partial<PayRecordInput> & { period_start: string }): PayRecordInput => ({
  period_end: null,
  total_hours: 44.1,
  regular_hours: 40,
  ot_hours: 4.1,
  hourly_pay_php: null,
  hourly_pay_usd: null,
  status: "paid",
  paid_usd: null,
  paid_at: null,
  ...o,
});

const DISP = (o: Partial<DispatchInput> & { period_start: string }): DispatchInput => ({
  period_end: null,
  paid_usd: null,
  paid_php: null,
  bonus_php: null,
  bonus_label: null,
  at: "2026-09-15",
  payee_type: "employee",
  ...o,
});

/** The four weeks exactly as production holds them. */
const RECORDS: PayRecordInput[] = [
  REC({ period_start: "2026-09-06", period_end: "2026-09-12", total_hours: 44.1, ot_hours: 4.1, hourly_pay_php: 16383.25, hourly_pay_usd: 261.21, paid_usd: 288.56, paid_at: "2026-09-15" }),
  REC({ period_start: "2026-08-30", period_end: "2026-09-05", total_hours: 42.53, ot_hours: 2.53, hourly_pay_php: 15547.23, hourly_pay_usd: 249.23, paid_usd: 246.29, paid_at: "2026-09-09" }),
  REC({ period_start: "2026-08-23", period_end: "2026-08-29", total_hours: 42.13, ot_hours: 2.13, hourly_pay_php: 15334.23, hourly_pay_usd: 244.49, paid_usd: 324.37, paid_at: "2026-09-02" }),
  REC({ period_start: "2026-08-16", period_end: "2026-08-22", total_hours: 41.75, ot_hours: 1.75, hourly_pay_php: 15131.88, hourly_pay_usd: 245.17, paid_usd: 243.55, paid_at: "2026-08-26" }),
];

const DISPATCHES: DispatchInput[] = [
  DISP({ period_start: "2026-09-06", paid_usd: 288.56, paid_php: 18133.25, bonus_php: 1850, bonus_label: "Tech ₱1,850", at: "2026-09-15" }),
  DISP({ period_start: "2026-08-30", paid_usd: 246.29, paid_php: 15447.23, at: "2026-09-09" }),
  DISP({ period_start: "2026-08-23", paid_usd: 324.37, paid_php: 20234.23, bonus_php: 5000, bonus_label: "PAB ₱5,000", at: "2026-09-02" }),
  DISP({ period_start: "2026-08-16", paid_usd: 243.55, paid_php: 15031.88, at: "2026-08-26" }),
];

/** ₱100 worker contribution, ₱300 company match, deposited each Friday. */
const MESA: MesaDepositInput[] = [
  { deposit_date: "2026-09-11", worker_contribution_php: 100 },
  { deposit_date: "2026-09-04", worker_contribution_php: 100 },
  { deposit_date: "2026-08-28", worker_contribution_php: 100 },
  { deposit_date: "2026-08-21", worker_contribution_php: 100 },
  { deposit_date: null, worker_contribution_php: null }, // the ledger's roster row
];

const build = () =>
  buildReconciledPayWeeks({ records: RECORDS, dispatches: DISPATCHES, mesaDeposits: MESA, weeks: 4 });

/* ── The reported bug ────────────────────────────────────────────────────── */

test("the paid PHP figure is present on an ALREADY-paid week (the null that lied)", () => {
  // Guarding this on `status !== 'paid'` is what made Penny tell the CEO that
  // "the system stores the actual paid amount in USD only".
  const { entries } = build();
  assert.equal(entries.length, 4);
  for (const e of entries) {
    assert.equal(e.status, "paid");
    assert.ok(e.paid_php != null, `${e.period_start} lost its paid PHP amount`);
  }
  assert.equal(entries[0].paid_php, 18133.25);
});

test("an unknown money figure is OMITTED, never emitted as null", () => {
  const { entries } = buildReconciledPayWeeks({
    records: [REC({ period_start: "2026-09-06", hourly_pay_php: 16383.25, status: "pending" })],
    dispatches: [],
    mesaDeposits: [],
    weeks: 1,
  });
  const json = JSON.parse(JSON.stringify(entries[0])) as Record<string, unknown>;
  assert.equal("paid_php" in json, false, "a null paid_php is exactly the bug");
  assert.equal("bonus_php" in json, false);
  assert.match(String(json.paid_php_note), /not paid yet/i);
});

test("the bonus is named, not guessed", () => {
  // "almost certainly reflects a bonus" was a guess against a row that said so.
  const { entries } = build();
  const pab = entries.find((e) => e.period_start === "2026-08-23")!;
  assert.equal(pab.bonus_php, 5000);
  assert.equal(pab.bonus_label, "PAB ₱5,000");
  const tech = entries.find((e) => e.period_start === "2026-09-06")!;
  assert.equal(tech.bonus_label, "Tech ₱1,850");
});

test("the MESA deduction is named on every week", () => {
  const { entries } = build();
  for (const e of entries) {
    assert.equal(e.deduction_php, 100, `${e.period_start} lost its MESA deduction`);
    assert.match(String(e.deduction_label), /MESA/);
  }
});

/* ── The arithmetic Carla asked for ──────────────────────────────────────── */

test("hourly + bonus − deduction = paid, to the peso, on all four weeks", () => {
  const { entries } = build();
  for (const e of entries) {
    assert.equal(e.reconciles, true, `${e.period_start} does not reconcile`);
    assert.equal(e.unexplained_php, undefined);
  }
});

test("the four-week totals are the ones the CEO was asking for", () => {
  const t = totalsFor(build().entries);
  assert.equal(t.sum_hourly_pay_php, 62396.59);
  assert.equal(t.sum_bonus_php, 6850);
  assert.equal(t.sum_deduction_php, 400);
  assert.equal(t.sum_paid_php, 68846.59);
  assert.equal(t.sum_paid_usd, 1102.77);
  assert.equal(t.all_checked_weeks_reconcile, true);
  assert.equal(t.weeks_reconciled, 4);
  assert.equal("weeks_unchecked" in t, false);
  assert.equal("totals_note" in t, false);
  // The identity itself, not just the four numbers.
  assert.equal(
    Math.round(((t.sum_hourly_pay_php as number) + (t.sum_bonus_php as number) - (t.sum_deduction_php as number)) * 100) / 100,
    t.sum_paid_php,
  );
});

/* ── simple_match_php is the company's money ─────────────────────────────── */

test("only the worker contribution is a deduction — the ₱300 match is never netted", () => {
  // The ledger row is {worker 100, match 300, deposited 400}. Netting anything
  // but the 100 understates take-home; the type does not even carry the match.
  const d = mesaDeductionForWeek([{ deposit_date: "2026-09-11", worker_contribution_php: 100 }], "2026-09-06", "2026-09-12");
  assert.equal(d, 100);
});

test("no MESA row for the week means null (not a member), not zero", () => {
  assert.equal(mesaDeductionForWeek([], "2026-09-06", "2026-09-12"), null);
  const { entries } = buildReconciledPayWeeks({
    records: [RECORDS[0]],
    dispatches: [DISPATCHES[0]],
    mesaDeposits: [],
    weeks: 1,
  });
  const json = JSON.parse(JSON.stringify(entries[0])) as Record<string, unknown>;
  assert.equal("deduction_php" in json, false);
});

test("a deposit outside the week does not touch it", () => {
  assert.equal(mesaDeductionForWeek(MESA, "2026-09-06", "2026-09-12"), 100);
  assert.equal(mesaDeductionForWeek(MESA, "2026-09-13", "2026-09-19"), null);
});

test("a week with no end stamp still closes at Sunday + 6", () => {
  assert.equal(mesaDeductionForWeek(MESA, "2026-09-06", null), 100);
  assert.equal(mesaDeductionForWeek([{ deposit_date: "2026-09-13", worker_contribution_php: 100 }], "2026-09-06", null), null);
});

/* ── Failing loud ────────────────────────────────────────────────────────── */

test("an unexplained remainder is reported, never absorbed", () => {
  const e: PayWeekOutput = {
    period_start: "2026-09-06", period_end: "2026-09-12", total_hours: 44.1, regular_hours: 40, ot_hours: 4.1,
    hourly_pay_php: 16383.25, bonus_php: 1850, deduction_php: 100, paid_php: 18633.25,
    status: "paid", paid_at: "2026-09-15", source: "weekly_records",
  };
  applyReconciliation(e);
  assert.equal(e.reconciles, false);
  assert.equal(e.unexplained_php, 500);
  assert.match(String(e.reconciliation_note), /do NOT guess/);
});

test("two records of the same payment that disagree are BOTH reported", () => {
  const { entries } = buildReconciledPayWeeks({
    records: [REC({ period_start: "2026-09-06", period_end: "2026-09-12", hourly_pay_php: 16383.25, paid_usd: 288.56, status: "paid" })],
    dispatches: [DISP({ period_start: "2026-09-06", paid_usd: 999.99, paid_php: 18133.25 })],
    mesaDeposits: [],
    weeks: 1,
  });
  assert.match(String(entries[0].paid_usd_disagreement), /288\.56/);
  assert.match(String(entries[0].paid_usd_disagreement), /999\.99/);
  assert.match(String(entries[0].paid_usd_disagreement), /do not pick one/i);
});

test("a cent-level difference is not a disagreement", () => {
  const { entries } = buildReconciledPayWeeks({
    records: [REC({ period_start: "2026-09-06", hourly_pay_php: 16383.25, paid_usd: 288.56, status: "paid" })],
    dispatches: [DISP({ period_start: "2026-09-06", paid_usd: 288.56, paid_php: 18133.25 })],
    mesaDeposits: [],
    weeks: 1,
  });
  assert.equal(entries[0].paid_usd_disagreement, undefined);
});

test("an unseeded week says so rather than reporting a broken reconciliation", () => {
  const { entries } = buildReconciledPayWeeks({
    records: [],
    dispatches: [DISP({ period_start: "2026-09-06", paid_usd: 288.56, paid_php: 18133.25 })],
    mesaDeposits: [],
    weeks: 1,
  });
  assert.equal(entries[0].source, "live_dispatch_log");
  assert.equal(entries[0].reconciles, undefined);
  assert.match(String(entries[0].reconciliation_note), /not seeded/);
});

/* ── The freshness overlay must survive the change ───────────────────────── */

test("a dispatch for a week the records have not marked paid still wins (2026-07-29 fix)", () => {
  const { entries } = buildReconciledPayWeeks({
    records: [REC({ period_start: "2026-09-06", hourly_pay_php: 16383.25, status: "pending", paid_usd: null, paid_at: null })],
    dispatches: [DISP({ period_start: "2026-09-06", paid_usd: 288.56, paid_php: 18133.25, at: "2026-09-15" })],
    mesaDeposits: [],
    weeks: 1,
  });
  assert.equal(entries[0].status, "paid");
  assert.equal(entries[0].paid_usd, 288.56);
  assert.equal(entries[0].paid_at, "2026-09-15");
  assert.equal(entries[0].source, "weekly_records + live_dispatch_log");
});

test("contractor settlements and period-less urgent rows never enter a pay week", () => {
  const merged = mergeDispatchesByWeek([
    DISP({ period_start: "2026-09-06", paid_php: 18133.25, payee_type: "contractor" }),
    DISP({ period_start: null as unknown as string, paid_php: 5000 }),
    DISP({ period_start: "2026-09-06", paid_php: 18133.25 }),
  ]);
  assert.equal(merged.size, 1);
  assert.equal(merged.get("2026-09-06")!.paid_php, 18133.25);
});

test("two sends against one week add up and keep the later stamp", () => {
  const merged = mergeDispatchesByWeek([
    DISP({ period_start: "2026-09-06", paid_php: 10000, paid_usd: 160, bonus_php: 1850, bonus_label: "Tech ₱1,850", at: "2026-09-15" }),
    DISP({ period_start: "2026-09-06", paid_php: 8133.25, paid_usd: 128.56, at: "2026-09-16" }),
  ]);
  const w = merged.get("2026-09-06")!;
  assert.equal(w.paid_php, 18133.25);
  assert.equal(w.paid_usd, 288.56);
  assert.equal(w.bonus_php, 1850);
  assert.equal(w.at, "2026-09-16");
});

test("unknown + unknown stays unknown — a missing amount never becomes ₱0", () => {
  const merged = mergeDispatchesByWeek([
    DISP({ period_start: "2026-09-06", paid_php: null }),
    DISP({ period_start: "2026-09-06", paid_php: null }),
  ]);
  assert.equal(merged.get("2026-09-06")!.paid_php, null);
});

/* ── Ordering and windowing ──────────────────────────────────────────────── */

test("weeks come back newest first and are capped at the number asked for", () => {
  const { entries } = buildReconciledPayWeeks({ records: RECORDS, dispatches: DISPATCHES, mesaDeposits: MESA, weeks: 2 });
  assert.deepEqual(entries.map((e) => e.period_start), ["2026-09-06", "2026-08-30"]);
});

test("totals never zero-fill a term nobody has", () => {
  const t = totalsFor([
    { period_start: "2026-09-06", period_end: null, total_hours: 0, regular_hours: 0, ot_hours: 0, status: "pending", paid_at: null, source: "weekly_records", hourly_pay_php: 100 },
  ]);
  assert.equal(t.sum_hourly_pay_php, 100);
  assert.equal("sum_paid_php" in t, false);
  assert.equal("all_checked_weeks_reconcile" in t, false);
});

test("totals say so when they are NOT a closed sum", () => {
  // A week paid before its hours record was seeded contributes to sum_paid_php
  // with no hourly figure to match it. Publishing "all weeks reconcile" beside
  // totals that visibly do not add up is the same mistake this module fixes.
  const { entries } = buildReconciledPayWeeks({
    records: [RECORDS[0]],
    dispatches: [DISPATCHES[0], DISP({ period_start: "2026-08-02", paid_usd: 200, paid_php: 12000 })],
    mesaDeposits: MESA,
    weeks: 2,
  });
  const t = totalsFor(entries);
  assert.equal(t.all_checked_weeks_reconcile, true, "the week that COULD be checked still reconciles");
  assert.equal(t.weeks_unchecked, 1);
  assert.match(String(t.totals_note), /NOT a closed sum/);
  // And the sums genuinely do not close — which is why the note has to exist.
  const closed =
    Math.round(((t.sum_hourly_pay_php as number) + (t.sum_bonus_php as number) - (t.sum_deduction_php as number)) * 100) / 100;
  assert.notEqual(closed, t.sum_paid_php);
});

test("a bonus amount with no label in the data is still reported as a bonus", () => {
  // `system_bonus_label` is nullable in production. The amount must survive; a
  // label is never invented to fill the hole (that is the guessing this fixes).
  const { entries } = buildReconciledPayWeeks({
    records: [REC({ period_start: "2026-08-16", period_end: "2026-08-22", hourly_pay_php: 12630.01, status: "paid" })],
    dispatches: [DISP({ period_start: "2026-08-16", paid_php: 16465.01, bonus_php: 3935, bonus_label: null })],
    mesaDeposits: [{ deposit_date: "2026-08-21", worker_contribution_php: 100 }],
    weeks: 1,
  });
  assert.equal(entries[0].bonus_php, 3935);
  assert.equal(entries[0].bonus_label, undefined);
  assert.equal(entries[0].reconciles, true);
});

test("no note or label ever calls hourly pay \"computed\"", () => {
  // Carla's actual objection. The word must not survive anywhere in the payload.
  const unpaid = buildReconciledPayWeeks({
    records: [REC({ period_start: "2026-09-06", hourly_pay_php: 16383.25, status: "pending", paid_usd: null })],
    dispatches: [],
    mesaDeposits: [],
    weeks: 1,
  });
  const mixed = buildReconciledPayWeeks({
    records: [RECORDS[0]],
    dispatches: [DISPATCHES[0], DISP({ period_start: "2026-08-02", paid_php: 12000 })],
    mesaDeposits: MESA,
    weeks: 2,
  });
  const payload = JSON.stringify([unpaid.entries, mixed.entries, totalsFor(mixed.entries)]);
  assert.equal(/computed/i.test(payload), false, payload);
});
