import test from "node:test";
import assert from "node:assert/strict";
import { selectNewlyPaidEntries } from "./newly-paid-feed";
import type { PaidFeedEntry } from "@/hooks/usePaymentsLive";

function entry(over: Partial<PaidFeedEntry> & { email: string }): PaidFeedEntry {
  return {
    name: null,
    amountUsd: null,
    amountPhp: null,
    amountCop: null,
    paidAt: "2026-08-06T00:00:00.000Z",
    ...over,
  };
}

test("returns entries whose email is not in the seen set, in feed order", () => {
  const recent = [entry({ email: "a@simple.biz" }), entry({ email: "b@simple.biz" })];
  const seen = new Set(["a@simple.biz"]);
  const result = selectNewlyPaidEntries(recent, seen);
  assert.deepEqual(result.map((e) => e.email), ["b@simple.biz"]);
});

test("returns an empty array when every email has already been seen", () => {
  const recent = [entry({ email: "a@simple.biz" })];
  assert.deepEqual(selectNewlyPaidEntries(recent, new Set(["a@simple.biz"])), []);
});

test("returns all entries when the seen set is empty", () => {
  const recent = [entry({ email: "a@simple.biz" }), entry({ email: "b@simple.biz" })];
  const result = selectNewlyPaidEntries(recent, new Set());
  assert.deepEqual(result.map((e) => e.email), ["a@simple.biz", "b@simple.biz"]);
});

test("an empty feed returns an empty array regardless of seen", () => {
  assert.deepEqual(selectNewlyPaidEntries([], new Set(["a@simple.biz"])), []);
});
