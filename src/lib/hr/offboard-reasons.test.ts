import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VALID_OFFBOARD_REASONS,
  isValidOffboardReason,
  isQueueableOffboardReason,
} from "./offboard-reasons";

describe("isQueueableOffboardReason", () => {
  it("accepts every real offboard reason", () => {
    for (const r of VALID_OFFBOARD_REASONS) {
      if (r === "temporary_pause") continue;
      assert.equal(isQueueableOffboardReason(r), true, r);
    }
  });

  it("rejects temporary_pause — a suspension never rides the manager offboard queue", () => {
    assert.equal(isValidOffboardReason("temporary_pause"), true);
    assert.equal(isQueueableOffboardReason("temporary_pause"), false);
  });

  it("rejects invalid/empty values", () => {
    assert.equal(isQueueableOffboardReason(""), false);
    assert.equal(isQueueableOffboardReason(null), false);
    assert.equal(isQueueableOffboardReason(undefined), false);
    assert.equal(isQueueableOffboardReason("suspended"), false);
  });
});
