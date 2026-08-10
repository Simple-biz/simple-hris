import test from "node:test";
import assert from "node:assert/strict";
import {
  isTechBonusWeek,
  listTechBonusWeekOptions,
  parseTechBonusWeekOverrides,
  resolveIsTechBonusWeek,
  techSalaryMonthKey,
  TECH_BONUS_WEEK_OVERRIDES_KEY,
} from "./dispatch-bonuses";

test("the overrides settings key is pinned (pab-period-settings mirrors it privately)", () => {
  // pab-period-settings.ts re-declares this string to avoid a module cycle;
  // if the canonical constant ever changes, that mirror must change with it.
  assert.equal(TECH_BONUS_WEEK_OVERRIDES_KEY, "tech_bonus_week_overrides");
});

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

test("techSalaryMonthKey attributes a week by its salary date's month", () => {
  // Monday Jun 22 → salary Tue Jun 30 → June.
  assert.equal(techSalaryMonthKey(d(2026, 6, 22)), "2026-06");
  // Monday Jun 29 → salary Tue Jul 7 → July, even though the Monday is in June.
  assert.equal(techSalaryMonthKey(d(2026, 6, 29)), "2026-07");
});

test("no override → resolver matches the legacy 3rd-week heuristic exactly", () => {
  const empty = parseTechBonusWeekOverrides(null);
  // Sweep a year of Mondays: with no overrides the resolver must be
  // byte-identical to the heuristic (the "unchanged until configured" promise).
  let monday = d(2026, 1, 5);
  for (let i = 0; i < 52; i++) {
    assert.equal(
      resolveIsTechBonusWeek(monday, empty),
      isTechBonusWeek(monday),
      `diverged on ${monday.toDateString()}`,
    );
    monday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7);
  }
});

test("an override moves the payout week and suppresses the heuristic week", () => {
  // July 2026 heuristic week: 3rd Mon–Sun week of July has salary Tue Jul 14,
  // paying period Mon Jul 6. Override July to the following week (Mon Jul 13).
  const heuristicMonday = d(2026, 7, 6);
  assert.equal(isTechBonusWeek(heuristicMonday), true);
  const overrides = parseTechBonusWeekOverrides(
    JSON.stringify({ "2026-07": "2026-07-13" }),
  );
  assert.equal(overrides.get("2026-07"), "2026-07-13");
  // Configured week fires…
  assert.equal(resolveIsTechBonusWeek(d(2026, 7, 13), overrides), true);
  // …the old heuristic week no longer does (no double-fire)…
  assert.equal(resolveIsTechBonusWeek(heuristicMonday, overrides), false);
  // …and other months are untouched.
  assert.equal(
    resolveIsTechBonusWeek(d(2026, 6, 8), overrides),
    isTechBonusWeek(d(2026, 6, 8)),
  );
});

test("exactly one week fires per overridden month", () => {
  const overrides = parseTechBonusWeekOverrides(
    JSON.stringify({ "2026-07": "2026-06-29" }), // earliest July option (salary Jul 7)
  );
  let fires = 0;
  let monday = d(2026, 6, 1);
  for (let i = 0; i < 10; i++) {
    if (
      techSalaryMonthKey(monday) === "2026-07" &&
      resolveIsTechBonusWeek(monday, overrides)
    ) {
      fires++;
    }
    monday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7);
  }
  assert.equal(fires, 1);
});

test("parse drops malformed entries so the safe default is the heuristic", () => {
  const parsed = parseTechBonusWeekOverrides(
    JSON.stringify({
      "2026-07": "2026-07-14", // Tuesday, not a Monday → dropped
      "2026-08": "2026-06-29", // week belongs to July, misfiled under August → dropped
      "not-a-month": "2026-07-13", // bad key → dropped
      "2026-09": "garbage", // bad date → dropped
      "2026-10": "2026-10-12", // valid: Monday, salary Tue Oct 20 → October ✓
    }),
  );
  assert.equal(parsed.size, 1);
  assert.equal(parsed.get("2026-10"), "2026-10-12");
  // Whole-blob garbage → empty map, never a throw.
  assert.equal(parseTechBonusWeekOverrides("{not json").size, 0);
  assert.equal(parseTechBonusWeekOverrides("[1,2]").size, 0);
  assert.equal(parseTechBonusWeekOverrides(undefined).size, 0);
});

test("week options cover the month, include the auto week exactly once, and all round-trip the parser", () => {
  for (const [y, m] of [
    [2026, 3], // 1st = Sunday (partial week 1)
    [2026, 6], // 1st = Monday
    [2026, 7], // 1st = Wednesday
    [2026, 2], // February
  ] as const) {
    const opts = listTechBonusWeekOptions(y, m - 1);
    assert.ok(opts.length >= 4 && opts.length <= 5, `${y}-${m}: ${opts.length} options`);
    assert.equal(opts.filter((o) => o.isAuto).length, 1, `${y}-${m}: auto count`);
    for (const o of opts) {
      assert.equal(o.monday.getDay(), 1);
      // Kane 2026-08-10: the tech bonus week follows SUNDAY → SATURDAY. The
      // displayable span wraps the owning Monday: [Mon − 1, Mon + 5].
      // (Calendar comparisons, not ms deltas — a Mar/Nov week crossing a DST
      // shift isn't exactly 6×24h in local time.)
      assert.equal(o.weekStart.getDay(), 0, `${y}-${m}: weekStart not a Sunday`);
      assert.equal(o.weekEnd.getDay(), 6, `${y}-${m}: weekEnd not a Saturday`);
      const expectStart = new Date(o.monday.getFullYear(), o.monday.getMonth(), o.monday.getDate() - 1);
      const expectEnd = new Date(o.monday.getFullYear(), o.monday.getMonth(), o.monday.getDate() + 5);
      assert.equal(o.weekStart.toDateString(), expectStart.toDateString(), `${y}-${m}: weekStart`);
      assert.equal(o.weekEnd.toDateString(), expectEnd.toDateString(), `${y}-${m}: weekEnd`);
      assert.equal(o.salaryDate.getMonth(), m - 1, `${y}-${m}: salary month`);
      // Every offered option must survive the parser when saved under this month.
      const key = `${y}-${String(m).padStart(2, "0")}`;
      const roundTrip = parseTechBonusWeekOverrides(
        JSON.stringify({ [key]: o.mondayIso }),
      );
      assert.equal(roundTrip.get(key), o.mondayIso, `${y}-${m}: ${o.mondayIso} rejected`);
    }
  }
});

test("the auto option matches the documented examples from the wizard comment", () => {
  // July 2026 (1st = Wed) → 3rd week Jul 13–19 → salary Tue Jul 14 pays Jul 6–12.
  const july = listTechBonusWeekOptions(2026, 6).find((o) => o.isAuto);
  assert.ok(july);
  assert.equal(july.mondayIso, "2026-07-06");
  // June 2026 (1st = Mon) → 3rd week Jun 15–21 → salary Tue Jun 16 pays Jun 8–14.
  const june = listTechBonusWeekOptions(2026, 5).find((o) => o.isAuto);
  assert.ok(june);
  assert.equal(june.mondayIso, "2026-06-08");
});
