/**
 * READ-ONLY verifier for the 2026-09-17 pay-reconciliation change — runs the
 * REAL `runCeoTool('get_employee_pay')` the chat routes call, against
 * production, so what Penny can actually see is checked rather than a replica.
 *
 * Carla, pulling four cycles for an employee: *"Why is the paid USD different
 * from the computed USD?"* — and then *"it should give me EVERYTHING … it
 * should be called Hourly Pay, not computed."* Three defects behind that:
 * a `paid_amount_php: null` that meant "branch never ran" (and was reported to
 * the CEO as "the system stores USD only"), a bonus guessed at while its label
 * sat unread on the fetched row, and a MESA deduction no tool could name.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/verify-penny-pay-reconciliation.mts [email] [weeks]
 *
 * Defaults: amiea@simple.biz over 4 weeks — Carla's actual question.
 * Only SELECTs are issued. Exit code 1 when any check fails.
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const email = (process.argv[2] ?? "amiea@simple.biz").toLowerCase();
const weeks = Number(process.argv[3] ?? 4);

const { runCeoTool } = await import("../src/lib/anthropic/ceo-tools");

// Two different things are checked here and they must not be conflated.
// `check` asserts a CODE contract — a broken one is a bug in this change.
// `observe` reports what the DATA says — a week that genuinely does not
// reconcile is the tool working correctly, and calling that a code failure
// would train everyone to ignore this script.
let failures = 0;
let findings = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const observe = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "  PASS" : "  DATA"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) findings += 1;
};
const peso = (n: number) => `₱${n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

console.log(`\nget_employee_pay(${email}, weeks=${weeks})\n`);

const res = (await runCeoTool("get_employee_pay", { work_email: email, weeks })) as Record<string, unknown>;

if (res.error) {
  console.error(`  tool error: ${String(res.error)}`);
  process.exit(1);
}

const rows = (res.weeks ?? []) as Array<Record<string, unknown>>;
const totals = (res.totals ?? {}) as Record<string, number | boolean>;

check(rows.length > 0, "the tool returned pay weeks", `${rows.length} week(s)`);

/* ── Defect 1: the null that lied ────────────────────────────────────────── */
const paidWeeks = rows.filter((w) => w.status === "paid");
const missingPhp = paidWeeks.filter((w) => w.paid_php == null);
check(
  paidWeeks.length > 0 && missingPhp.length === 0,
  "every PAID week carries the peso amount actually disbursed",
  missingPhp.length ? `${missingPhp.length} paid week(s) still have no paid_php` : `${paidWeeks.length} paid week(s)`,
);

const serialized = JSON.stringify(rows);
check(
  !/"(paid_php|hourly_pay_php|bonus_php|deduction_php|paid_usd)":null/.test(serialized),
  "no money field is serialized as an explicit null",
  "a null reads as \"we do not hold this\" — absent is the contract",
);

/* ── Defect 2: the guessed bonus ─────────────────────────────────────────── */
// The invariant is that a bonus folded into a payment SURFACES as a bonus, not
// that the database always labelled it: `system_bonus_label` is nullable in
// production, and inventing a name to fill that hole is the guessing this
// change exists to stop. So the amount is asserted and a missing label is
// reported as the data observation it is.
const withBonus = rows.filter((w) => w.bonus_php != null);
check(
  withBonus.every((w) => Number.isFinite(Number(w.bonus_php))),
  "every itemised bonus carries a real amount",
  withBonus.length
    ? withBonus.map((w) => `${w.period_start}: ${peso(Number(w.bonus_php))}${w.bonus_label ? ` (${w.bonus_label})` : ""}`).join("; ")
    : "no bonus weeks in range",
);
const unlabelled = withBonus.filter((w) => !w.bonus_label);
if (unlabelled.length > 0) {
  console.log(
    `  NOTE  ${unlabelled.length} bonus week(s) have an amount but no system_bonus_label in the data ` +
      `(${unlabelled.map((w) => w.period_start).join(", ")}) — reported as an unnamed bonus, never guessed at.`,
  );
}

/* ── Defect 3: the missing MESA term, and the arithmetic ─────────────────── */
for (const w of rows) {
  if (w.paid_php == null || w.hourly_pay_php == null) {
    console.log(`  skip  ${w.period_start} — ${w.paid_php == null ? "not paid / no peso figure" : "hours record not seeded"}`);
    continue;
  }
  const hourly = Number(w.hourly_pay_php);
  const bonus = Number(w.bonus_php ?? 0);
  const ded = Number(w.deduction_php ?? 0);
  const paid = Number(w.paid_php);
  const expected = Math.round((hourly + bonus - ded) * 100) / 100;
  const ok = w.reconciles === true && Math.abs(expected - paid) <= 0.011;
  observe(
    ok,
    `${w.period_start} reconciles`,
    `${peso(hourly)} + ${peso(bonus)} − ${peso(ded)} = ${peso(expected)} vs paid ${peso(paid)}` +
      (w.unexplained_php != null ? ` — unexplained ${peso(Number(w.unexplained_php))}` : ""),
  );
}

/* ── The totals the CEO was actually asking for ──────────────────────────── */
// Totals are only a CLOSED sum when every week could be checked. A week paid
// before its hours record was seeded contributes to sum_paid_php with no
// hourly figure to match it, so the identity legitimately falls short — and
// the result must SAY so rather than let a reader find the gap themselves.
if (typeof totals.sum_hourly_pay_php === "number" && typeof totals.sum_paid_php === "number") {
  const expected =
    Math.round(((totals.sum_hourly_pay_php as number) + Number(totals.sum_bonus_php ?? 0) - Number(totals.sum_deduction_php ?? 0)) * 100) / 100;
  const closes = Math.abs(expected - (totals.sum_paid_php as number)) <= 0.011;
  const detail = `${peso(totals.sum_hourly_pay_php as number)} + ${peso(Number(totals.sum_bonus_php ?? 0))} − ${peso(Number(totals.sum_deduction_php ?? 0))} = ${peso(expected)} vs ${peso(totals.sum_paid_php as number)}`;
  const unchecked = Number(totals.weeks_unchecked ?? 0);
  if (unchecked > 0) {
    check(
      !closes && typeof totals.totals_note === "string" && /NOT a closed sum/.test(String(totals.totals_note)),
      "totals that cannot close SAY they cannot close",
      `${unchecked} week(s) unchecked — ${detail}`,
    );
  } else {
    check(closes, "the totals add up", detail);
  }
}

/* ── The label Carla objected to must be gone ────────────────────────────── */
const notes = String(res.field_notes ?? "");
check(/Hourly Pay/i.test(notes), "field_notes tell the model to say \"Hourly Pay\"");
check(
  !/\bcomputed\b/i.test(serialized),
  "the word \"computed\" no longer appears on any pay week",
);

/* ── Disagreements must be surfaced, not silently resolved ───────────────── */
const disagreements = rows.filter((w) => w.paid_usd_disagreement != null);
if (disagreements.length > 0) {
  console.log(`\n  NOTE  ${disagreements.length} week(s) where the weekly record and the dispatch log disagree on USD:`);
  for (const w of disagreements) console.log(`        ${w.period_start}: ${w.paid_usd_disagreement}`);
}

console.log(`\n  totals: ${JSON.stringify(totals)}`);

if (failures > 0) {
  console.log(`\n${failures} CODE CHECK(S) FAILED — the reconciliation contract is broken.\n`);
  process.exit(1);
}
if (findings > 0) {
  console.log(
    `\nALL CODE CHECKS PASSED — but ${findings} week(s) do not reconcile against real data.\n` +
      'That is the tool working: the remainder is reported as unexplained and NOT attributed.\n' +
      'Accounting adjustments and Payroll Notes entries are invisible to this tool — use\n' +
      'get_bonus_breakdown before offering anyone an explanation.\n',
  );
  process.exit(2);
}
console.log('\nALL CHECKS PASSED\n');
process.exit(0);
