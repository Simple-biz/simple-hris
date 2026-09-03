import test from "node:test";
import assert from "node:assert/strict";
import type { CurrentPayEntry, CurrentPayResult } from "./current-pay";
import {
  buildRecoveredEntry,
  buildRecoveredSnapshot,
  parseAdditionsBlob,
  pickAdditionsOverlay,
  readRecoveredSnapshot,
  recoveredSnapshotKey,
  RECOVERED_SNAPSHOT_PREFIX,
} from "./paystub-recovered";

const entry = (over: Partial<CurrentPayEntry> = {}): CurrentPayEntry =>
  ({
  departmentKey: null,
  totalHours: 40,
  regularHours: 40,
  otHours: 0,
  regularPayPHP: 7000,
  otPayPHP: 0,
  initialPayPHP: 7000,
  initialPayUSD: 120,
  pabBonusPHP: 0,
  techBonusPHP: 0,
  bonusTotalPHP: 0,
  mesaDeductionPHP: 0,
  totalPayPHP: 7000,
  totalPayUSD: 120,
  totalPayCOP: null,
  hasRate: true,
  payCurrency: "PHP",
  countryCurrency: null,
  ...over,
  }) as CurrentPayEntry;

test("the key lives under its own prefix — never under payroll.wizard.final_pay", () => {
  assert.equal(recoveredSnapshotKey("w.csv"), "paystub.recovered.w.csv");
  assert.ok(!RECOVERED_SNAPSHOT_PREFIX.startsWith("payroll.wizard."));
});

test("buildRecoveredEntry mirrors the route's engine-only arithmetic", () => {
  const e = buildRecoveredEntry(
    "jane@simple.biz",
    entry({ regularPayPHP: 7000, otPayPHP: 525.5, initialPayPHP: 7525.5, pabBonusPHP: 5000, techBonusPHP: 1850, mesaDeductionPHP: 100 }),
    { adjustment: -250, adjustmentNote: "late", orphanage: 300 },
  );
  assert.ok(e);
  assert.equal(e.workEmail, "jane@simple.biz");
  assert.equal(e.regularPay, 7000);
  assert.equal(e.otPay, 525.5);
  assert.equal(e.initial, 7525.5);
  assert.equal(e.perfectAttendanceBonus, 5000);
  assert.equal(e.techBonus, 1850);
  assert.equal(e.otherBonuses, 0);
  assert.equal(e.mesaDeduction, 100);
  assert.equal(e.mesaDisbursement, 0);
  assert.equal(e.adjustment, -250);
  assert.equal(e.orphanagePay, 300);
  // initial + pab + tech + adj + orphanage − mesa
  assert.equal(e.final, 7525.5 + 5000 + 1850 - 250 + 300 - 100);
  // Itemized — the route's fast path accepts it.
  assert.equal(typeof e.perfectAttendanceBonus, "number");
  assert.equal(typeof e.techBonus, "number");
  assert.equal(typeof e.otherBonuses, "number");
});

test("adjustment and orphanage are GATED on hasRate, as the wizard drops them", () => {
  const e = buildRecoveredEntry("x@simple.biz", entry({ hasRate: false, regularPayPHP: null, otPayPHP: null, initialPayPHP: null }), {
    adjustment: 500,
    adjustmentNote: null,
    orphanage: 200,
  });
  assert.ok(e);
  assert.equal(e.adjustment, 0);
  assert.equal(e.orphanagePay, 0);
  assert.equal(e.initial, 0);
  assert.equal(e.final, 0);
});

test("no hours = not in this week = null entry", () => {
  assert.equal(buildRecoveredEntry("x@simple.biz", entry({ totalHours: 0 }), { adjustment: 0, adjustmentNote: null, orphanage: 0 }), null);
});

test("additions blob: aliases match, note only surfaces with a non-zero adjustment", () => {
  const blob = parseAdditionsBlob(
    JSON.stringify({
      bonusOverrides: { "Jane.Personal@Gmail.com": "150" },
      bonusOverrideNotes: { "jane.personal@gmail.com": " reimbursed " },
      orphanageAmounts: { "jane@simple.biz": 300 },
    }),
  );
  assert.ok(blob);
  const o = pickAdditionsOverlay(blob, ["jane@simple.biz", "jane.personal@gmail.com"]);
  assert.deepEqual(o, { adjustment: 150, adjustmentNote: "reimbursed", orphanage: 300 });
  const zero = pickAdditionsOverlay(parseAdditionsBlob(JSON.stringify({ bonusOverrideNotes: { "a@b": "n" } })), ["a@b"]);
  assert.equal(zero.adjustmentNote, null);
  assert.equal(parseAdditionsBlob("not json"), null);
  assert.equal(parseAdditionsBlob(null), null);
});

test("buildRecoveredSnapshot stores everyone with hours, stamped with the batch, and resolves aliases", () => {
  const result: CurrentPayResult = {
    period: { start: "2026-04-12", end: "2026-04-18" } as CurrentPayResult["period"],
    fxRate: 58.5,
    fxRates: { usdToPhp: 58.5, usdToCop: 4000 } as CurrentPayResult["fxRates"],
    byEmail: {
      "Jane@simple.biz": entry(),
      "idle@simple.biz": entry({ totalHours: 0 }),
    },
    stashedMesaTotalPHP: 0,
    approvedBudgetRequestsTotalPHP: 0,
    masterEmails: [],
  };
  const snap = buildRecoveredSnapshot({
    result,
    sourceFile: "w.csv",
    uploadId: "u-1",
    computedAt: new Date("2026-09-03T00:00:00Z"),
    additionsRaw: JSON.stringify({ bonusOverrides: { "jane.p@gmail.com": 100 } }),
    aliasesOf: (e) => (e === "jane@simple.biz" ? ["jane.p@gmail.com"] : []),
  });
  assert.equal(snap.version, 1);
  assert.equal(snap.upload_id, "u-1");
  assert.equal(snap.fx_rate, 58.5);
  assert.deepEqual(snap.period, { start: "2026-04-12", end: "2026-04-18" });
  assert.deepEqual(Object.keys(snap.finals), ["jane@simple.biz"]);
  assert.equal(snap.finals["jane@simple.biz"].adjustment, 100, "alias-keyed adjustment applied");
  assert.equal(snap.computed_at, "2026-09-03T00:00:00.000Z");
});

test("readRecoveredSnapshot: absent / stale / match, failing closed on an unverifiable batch", () => {
  const raw = JSON.stringify({
    version: 1,
    source_file: "w.csv",
    upload_id: "u-1",
    computed_at: "2026-09-03T00:00:00.000Z",
    fx_rate: 58.5,
    period: { start: "2026-04-12", end: "2026-04-18" },
    finals: { "jane@simple.biz": { final: 7000, regularHours: 40, otHours: 0, totalHours: 40 } },
  });
  assert.deepEqual(readRecoveredSnapshot(null, ["jane@simple.biz"], "u-1"), { status: "absent" });
  assert.deepEqual(readRecoveredSnapshot("{bad", ["jane@simple.biz"], "u-1"), { status: "absent" });
  assert.equal(readRecoveredSnapshot(raw, ["jane@simple.biz"], "u-2").status, "stale", "re-upload = new batch");
  assert.equal(readRecoveredSnapshot(raw, ["jane@simple.biz"], null).status, "stale", "unknown current batch never matches");
  const noBatch = JSON.stringify({ ...JSON.parse(raw), upload_id: null });
  assert.equal(readRecoveredSnapshot(noBatch, ["jane@simple.biz"], "u-1").status, "stale", "unstamped snapshot never matches");

  const hit = readRecoveredSnapshot(raw, ["JANE@simple.biz".toLowerCase()], "u-1");
  assert.equal(hit.status, "match");
  if (hit.status !== "match") return;
  assert.equal(hit.entry?.final, 7000);
  assert.equal(hit.fxRate, 58.5);
  assert.deepEqual(hit.period, { start: "2026-04-12", end: "2026-04-18" });

  // Matching batch, caller absent: the week is CLOSED for them (entry null),
  // and that is a match — not a reason to run the engine.
  const miss = readRecoveredSnapshot(raw, ["someone.else@simple.biz"], "u-1");
  assert.equal(miss.status, "match");
  if (miss.status === "match") assert.equal(miss.entry, null);
});
