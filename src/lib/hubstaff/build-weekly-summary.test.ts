import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { HubstaffDailyActivity, HubstaffUser } from "@/lib/hubstaff/api-client";
import {
  apiSyncFileName,
  buildWeeklySummaryCsv,
  enumerateIsoDates,
} from "@/lib/hubstaff/build-weekly-summary";

const USERS: HubstaffUser[] = [
  { id: 1, name: "Jane Doe", email: "jane@simple.biz" },
  { id: 2, name: "Bob, The \"Builder\"", email: "bob@simple.biz" },
];

function act(userId: number, date: string, tracked: number, overall?: number): HubstaffDailyActivity {
  return { id: userId * 1000 + Math.round(tracked), date, user_id: userId, tracked, overall };
}

test("enumerateIsoDates is inclusive and validates order", () => {
  assert.deepEqual(enumerateIsoDates("2026-07-05", "2026-07-11"), [
    "2026-07-05", "2026-07-06", "2026-07-07", "2026-07-08",
    "2026-07-09", "2026-07-10", "2026-07-11",
  ]);
  assert.throws(() => enumerateIsoDates("2026-07-11", "2026-07-05"));
  assert.throws(() => enumerateIsoDates("2026-07-05", "2026-08-05"));
});

test("apiSyncFileName matches the YYYY-MM-DD_to_YYYY-MM-DD period parser", () => {
  const name = apiSyncFileName("2026-07-05", "2026-07-11");
  assert.equal(name, "simple-biz_api_sync_2026-07-05_to_2026-07-11.csv");
  assert.match(name, /\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}/);
});

test("builds a Hubstaff-shaped weekly summary CSV", () => {
  const activities = [
    act(1, "2026-07-06", 3600 * 8, 3600 * 4),
    act(1, "2026-07-06", 1800, 900), // second aggregate same day (e.g. another project)
    act(1, "2026-07-07", 3600 * 2, 3600),
    act(2, "2026-07-10", 30600),
  ];
  const { csvText, rowCount } = buildWeeklySummaryCsv(USERS, activities, "2026-07-05", "2026-07-11");
  const lines = csvText.split("\r\n");

  assert.equal(rowCount, 2);
  assert.equal(
    lines[0],
    "Member,Email,2026-07-05,2026-07-06,2026-07-07,2026-07-08,2026-07-09,2026-07-10,2026-07-11,Total worked,Activity",
  );
  // Comma/quote in the member name is escaped; no overall data → empty Activity.
  assert.equal(lines[1], '"Bob, The ""Builder""",bob@simple.biz,0:00:00,0:00:00,0:00:00,0:00:00,0:00:00,8:30:00,0:00:00,8:30:00,');
  // Same-day aggregates sum; Total worked = 8h + 30m + 2h = 10:30:00; activity = 18900/37800 = 50%.
  assert.equal(lines[2], "Jane Doe,jane@simple.biz,0:00:00,8:30:00,2:00:00,0:00:00,0:00:00,0:00:00,0:00:00,10:30:00,50%");
});

test("user missing from sideload still gets a row (hours never dropped)", () => {
  const { csvText, rowCount } = buildWeeklySummaryCsv(
    [],
    [act(99, "2026-07-06", 3600)],
    "2026-07-05",
    "2026-07-11",
  );
  assert.equal(rowCount, 1);
  const row = csvText.split("\r\n")[1];
  assert.ok(row.startsWith("User 99,,"));
  assert.ok(row.includes("1:00:00"));
});

test("activities outside the requested range are ignored", () => {
  const { rowCount } = buildWeeklySummaryCsv(
    USERS,
    [act(1, "2026-07-04", 3600)],
    "2026-07-05",
    "2026-07-11",
  );
  assert.equal(rowCount, 0);
});
