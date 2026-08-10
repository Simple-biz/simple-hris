import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyZeroStampOffboard } from "./offboard-escalation";

const paused = { off_boarded_reason: "temporary_pause", off_boarded_at: "2026-08-01T00:00:00Z" };
const deleted = { off_boarded_reason: "ncns", off_boarded_at: "2026-07-01T00:00:00Z" };
const active = { off_boarded_reason: null, off_boarded_at: null };

describe("classifyZeroStampOffboard", () => {
  it("no rows at all → not_found", () => {
    assert.deepEqual(classifyZeroStampOffboard("ncns", []), { kind: "not_found" });
  });

  it("only active rows (guard raced) → not_found, never escalates", () => {
    assert.deepEqual(classifyZeroStampOffboard("ncns", [active]), { kind: "not_found" });
  });

  it("suspended via temporary_pause + real offboard reason → escalate to delete", () => {
    assert.deepEqual(classifyZeroStampOffboard("ncns", [paused]), { kind: "escalate_paused" });
    assert.deepEqual(classifyZeroStampOffboard("resigned", [paused]), { kind: "escalate_paused" });
  });

  it("mixed dual-department rows: any surviving suspension still escalates", () => {
    assert.deepEqual(classifyZeroStampOffboard("performance", [deleted, paused]), {
      kind: "escalate_paused",
    });
  });

  it("already off-boarded with a real reason → hard no-op (never re-fires delete)", () => {
    assert.deepEqual(classifyZeroStampOffboard("resigned", [deleted]), {
      kind: "already_offboarded",
      reason: "ncns",
      off_boarded_at: "2026-07-01T00:00:00Z",
    });
  });

  it("temporary_pause on an already-offboarded person → rejected, even if currently paused", () => {
    assert.deepEqual(classifyZeroStampOffboard("temporary_pause", [deleted]), {
      kind: "pause_on_offboarded",
    });
    assert.deepEqual(classifyZeroStampOffboard("temporary_pause", [paused]), {
      kind: "pause_on_offboarded",
    });
  });
});
