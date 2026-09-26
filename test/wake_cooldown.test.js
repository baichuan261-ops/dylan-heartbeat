const test = require("node:test");
const assert = require("node:assert/strict");
const { remainingWakeCooldownMs } = require("../wake_cooldown");
const user = "2026-09-25T00:00:00Z";
const push = "2026-09-25T01:00:00Z";

test("quiet conversation is eligible again exactly four hours after a push", () => {
  assert.equal(remainingWakeCooldownMs(user, push, "2026-09-25T04:59:59Z"), 1000);
  assert.equal(remainingWakeCooldownMs(user, push, "2026-09-25T05:00:00Z"), 0);
  assert.equal(remainingWakeCooldownMs(user, push, "2026-09-26T05:00:00Z"), 0);
});

test("new user messages and first push retain existing inactivity policy", () => {
  assert.equal(remainingWakeCooldownMs("2026-09-25T02:00:00Z", push, "2026-09-25T03:00:00Z"), 0);
  assert.equal(remainingWakeCooldownMs(user, null, push), 0);
});

test("cooldown survives a restart because it uses persisted push time", () => {
  assert.equal(remainingWakeCooldownMs(user, push, "2026-09-25T03:00:00Z"), 120 * 60000);
  assert.equal(remainingWakeCooldownMs(user, push, "2026-09-25T03:00:00Z", 120), 0);
});

test("invalid cooldown configuration uses four hours", () => {
  for (const value of [NaN, 0, -1]) {
    assert.equal(remainingWakeCooldownMs(user, push, "2026-09-25T03:00:00Z", value), 120 * 60000);
  }
});
