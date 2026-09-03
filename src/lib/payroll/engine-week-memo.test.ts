import test from "node:test";
import assert from "node:assert/strict";
import { createEngineWeekMemo, engineWeekMemoKey, ENGINE_WEEK_MEMO_TTL_MS } from "./engine-week-memo";

test("engineWeekMemoKey refuses an unknown upload batch — no key means no memo", () => {
  assert.equal(engineWeekMemoKey("week.csv", null), null);
  assert.equal(engineWeekMemoKey("week.csv", ""), null);
  assert.equal(engineWeekMemoKey("", "u1"), null);
  assert.equal(engineWeekMemoKey("week.csv", "u1"), "week.csv::u1");
  // A re-upload is a different key, never the same entry.
  assert.notEqual(engineWeekMemoKey("week.csv", "u1"), engineWeekMemoKey("week.csv", "u2"));
});

test("concurrent callers share ONE in-flight run", async () => {
  let calls = 0;
  const memo = createEngineWeekMemo<number>();
  const compute = () =>
    new Promise<number>((resolve) => {
      calls += 1;
      setTimeout(() => resolve(42), 5);
    });
  const [a, b, c] = await Promise.all([memo.get("k", compute), memo.get("k", compute), memo.get("k", compute)]);
  assert.deepEqual([a, b, c], [42, 42, 42]);
  assert.equal(calls, 1);
  assert.equal(memo.size(), 1);
});

test("expires after the TTL and recomputes", async () => {
  let t = 1_000_000;
  let calls = 0;
  const memo = createEngineWeekMemo<number>({ now: () => t });
  const compute = async () => ++calls;
  assert.equal(await memo.get("k", compute), 1);
  t += ENGINE_WEEK_MEMO_TTL_MS - 1;
  assert.equal(await memo.get("k", compute), 1, "still live one ms before the TTL");
  t += 2;
  assert.equal(await memo.get("k", compute), 2, "recomputed once the TTL passed");
  assert.equal(memo.size(), 1);
});

test("a rejected run is evicted so the next caller retries", async () => {
  let calls = 0;
  const memo = createEngineWeekMemo<number>();
  const failing = async () => {
    calls += 1;
    throw new Error("db blip");
  };
  await assert.rejects(memo.get("k", failing), /db blip/);
  assert.equal(memo.size(), 0);
  assert.equal(await memo.get("k", async () => 7), 7);
  assert.equal(calls, 1);
});

test("different keys are independent", async () => {
  const memo = createEngineWeekMemo<string>();
  assert.equal(await memo.get("a::u1", async () => "A"), "A");
  assert.equal(await memo.get("a::u2", async () => "A2"), "A2");
  assert.equal(memo.size(), 2);
  memo.clear();
  assert.equal(memo.size(), 0);
});
