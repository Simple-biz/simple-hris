import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPLOYEE_PENNY_DAILY_LIMIT,
  manilaDayIso,
  manilaDayStartIso,
  nextManilaMidnightIso,
  parseQuotaHeader,
  quotaFromUsed,
  quotaFromWire,
  quotaMessage,
  quotaToWire,
} from "./employee-quota";

test("the allowance is ten prompts per day", () => {
  assert.equal(EMPLOYEE_PENNY_DAILY_LIMIT, 10);
});

/* ── The Manila day boundary ─────────────────────────────────────────────── */

test("manilaDayIso reads the Manila calendar day, not the UTC one", () => {
  // 2026-08-19T17:00Z is already the 20th in Manila (UTC+8).
  assert.equal(manilaDayIso(new Date("2026-08-19T17:00:00Z")), "2026-08-20");
  // 2026-08-19T15:59Z is still the 19th.
  assert.equal(manilaDayIso(new Date("2026-08-19T15:59:00Z")), "2026-08-19");
});

test("manilaDayStartIso is the +08:00 midnight, i.e. 16:00Z the day before", () => {
  assert.equal(
    manilaDayStartIso(new Date("2026-08-19T09:00:00Z")),
    "2026-08-18T16:00:00.000Z",
  );
  // A moment just after Manila midnight belongs to the NEW day's window.
  assert.equal(
    manilaDayStartIso(new Date("2026-08-19T16:00:01Z")),
    "2026-08-19T16:00:00.000Z",
  );
});

test("a prompt at 23:59 Manila and one at 00:01 Manila fall in DIFFERENT windows", () => {
  // This is the whole point of the daily cycle: the ledger query's lower bound
  // must move at Manila midnight, not at UTC midnight.
  const late = new Date("2026-08-19T15:59:00Z"); // 23:59 Aug 19 Manila
  const early = new Date("2026-08-19T16:01:00Z"); // 00:01 Aug 20 Manila
  assert.notEqual(manilaDayStartIso(late), manilaDayStartIso(early));
  assert.equal(manilaDayStartIso(early), nextManilaMidnightIso(late));
});

test("nextManilaMidnightIso rolls over month and year ends", () => {
  assert.equal(
    nextManilaMidnightIso(new Date("2026-08-31T05:00:00Z")), // Aug 31 Manila
    "2026-08-31T16:00:00.000Z", // = Sep 1 00:00 +08:00
  );
  assert.equal(
    nextManilaMidnightIso(new Date("2026-12-31T05:00:00Z")),
    "2026-12-31T16:00:00.000Z", // = Jan 1 2027 00:00 +08:00
  );
  // And February in a non-leap year.
  assert.equal(
    nextManilaMidnightIso(new Date("2027-02-28T05:00:00Z")),
    "2027-02-28T16:00:00.000Z", // = Mar 1 00:00 +08:00
  );
});

test("the reset instant is always in the future relative to `now`", () => {
  for (const iso of [
    "2026-08-19T16:00:01Z", // one second into a Manila day
    "2026-08-19T15:59:59Z", // one second before it ends
    "2026-01-01T00:00:00Z",
  ]) {
    const now = new Date(iso);
    assert.ok(
      new Date(nextManilaMidnightIso(now)).getTime() > now.getTime(),
      `reset should be after ${iso}`,
    );
  }
});

/* ── The meter ───────────────────────────────────────────────────────────── */

test("remaining counts down and locks at zero", () => {
  const q0 = quotaFromUsed(0);
  assert.equal(q0.remaining, 10);
  assert.equal(q0.exhausted, false);
  assert.equal(q0.warnLevel, "none");

  const q9 = quotaFromUsed(9);
  assert.equal(q9.remaining, 1);
  assert.equal(q9.exhausted, false);

  const q10 = quotaFromUsed(10);
  assert.equal(q10.remaining, 0);
  assert.equal(q10.exhausted, true);
  assert.equal(q10.warnLevel, "exhausted");
});

test("the warning escalates BEFORE the composer greys out (Kane: sufficient warning)", () => {
  // 4+ left: quiet. 3,2: warn. 1: last call. 0: locked.
  assert.equal(quotaFromUsed(6).warnLevel, "none"); // 4 left
  assert.equal(quotaFromUsed(7).warnLevel, "low"); // 3 left
  assert.equal(quotaFromUsed(8).warnLevel, "low"); // 2 left
  assert.equal(quotaFromUsed(9).warnLevel, "last"); // 1 left
  assert.equal(quotaFromUsed(10).warnLevel, "exhausted");

  // And each warned level actually produces copy — a silent warning is not one.
  for (const used of [7, 8, 9, 10]) {
    assert.ok(quotaMessage(quotaFromUsed(used)), `used=${used} should carry a message`);
  }
  assert.equal(quotaMessage(quotaFromUsed(6)), null);
});

test("over-spend reads as zero left, never a negative, and stays locked", () => {
  // Two tabs racing past the pre-check can charge an 11th row. Display must not
  // go negative; the decision must still be "locked".
  const q = quotaFromUsed(13);
  assert.equal(q.remaining, 0);
  assert.equal(q.used, 10, "used is clamped for display");
  assert.equal(q.exhausted, true);
});

test("a non-finite used count fails CLOSED (treated as fully spent)", () => {
  // countUsedToday returns the limit on a DB error; this is the second belt —
  // a NaN must never render as "10 left".
  const q = quotaFromUsed(Number.NaN);
  assert.equal(q.exhausted, true);
  assert.equal(q.remaining, 0);
});

test("an elevated viewer is exempt: never exhausted, never warned", () => {
  const q = quotaFromUsed(50, { exempt: true });
  assert.equal(q.exempt, true);
  assert.equal(q.exhausted, false);
  assert.equal(q.warnLevel, "none");
  assert.equal(quotaMessage(q), null);
});

test("the exhausted message names the reset time and an escalation path", () => {
  const msg = quotaMessage(quotaFromUsed(10)) ?? "";
  assert.match(msg, /all 10/);
  assert.match(msg, /manager or HR/);
});

/* ── Wire round-trip ─────────────────────────────────────────────────────── */

test("wire round-trip preserves the decision and recomputes the warning", () => {
  for (const used of [0, 7, 9, 10]) {
    const q = quotaFromUsed(used);
    const back = quotaFromWire(quotaToWire(q));
    assert.equal(back.remaining, q.remaining);
    assert.equal(back.exhausted, q.exhausted);
    assert.equal(back.warnLevel, q.warnLevel, `warnLevel for used=${used}`);
    assert.equal(back.resetsAtIso, q.resetsAtIso);
  }
});

test("parseQuotaHeader tolerates garbage and never invents headroom", () => {
  assert.equal(parseQuotaHeader(null), null);
  assert.equal(parseQuotaHeader("not json"), null);
  assert.equal(parseQuotaHeader("{}"), null);
  assert.equal(parseQuotaHeader('{"limit":10,"used":3}'), null, "missing fields → null");

  const ok = parseQuotaHeader(
    JSON.stringify(quotaToWire(quotaFromUsed(9))),
  );
  assert.ok(ok);
  assert.equal(ok.remaining, 1);
  assert.equal(ok.warnLevel, "last");
});

test("a header omitting `exhausted` derives it from remaining", () => {
  const q = parseQuotaHeader('{"limit":10,"used":10,"remaining":0,"resetsAt":"2026-08-19T16:00:00.000Z"}');
  assert.ok(q);
  assert.equal(q.exhausted, true);
});
