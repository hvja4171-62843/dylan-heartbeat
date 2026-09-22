const test = require("node:test");
const assert = require("node:assert/strict");
const { isSuccessfulPushEventContent } = require("../special_events");
const {
  countPushesSince,
  getWakeDeadline,
  isHourInWindow,
  isQuietWindowExceptionDue,
  reconcileWakeState
} = require("../wake_policy");

test("supports an active window that crosses midnight", () => {
  assert.equal(isHourInWindow(8, 8, 2), true);
  assert.equal(isHourInWindow(23, 8, 2), true);
  assert.equal(isHourInWindow(1, 8, 2), true);
  assert.equal(isHourInWindow(2, 8, 2), false);
  assert.equal(isHourInWindow(7, 8, 2), false);
});

test("allows one quiet-window exception when the 90-minute deadline is quiet", () => {
  const getHour = date => date.getUTCHours();
  const lastUserTime = new Date("2026-09-22T02:00:00Z");
  const deadline = getWakeDeadline(lastUserTime, 90);

  assert.equal(deadline.toISOString(), "2026-09-22T03:30:00.000Z");
  assert.equal(isQuietWindowExceptionDue({
    lastUserTime,
    now: new Date("2026-09-22T03:29:59Z"),
    wakeAfterMinutes: 90,
    getHour,
    start: 8,
    end: 2
  }), false);
  assert.equal(isQuietWindowExceptionDue({
    lastUserTime,
    now: new Date("2026-09-22T03:30:00Z"),
    wakeAfterMinutes: 90,
    getHour,
    start: 8,
    end: 2
  }), true);
});

test("does not treat an active-window deadline as a quiet exception", () => {
  const getHour = date => date.getUTCHours();
  const lastUserTime = new Date("2026-09-22T07:00:00Z");

  assert.equal(isQuietWindowExceptionDue({
    lastUserTime,
    now: new Date("2026-09-22T08:30:00Z"),
    wakeAfterMinutes: 90,
    getHour,
    start: 8,
    end: 2
  }), false);
});

test("counts successful pushes only after the latest user message", () => {
  const messages = [
    { role: "assistant", content: "（2026-09-22 08:00 刚刚给用户发了Bark推送：旧｜消息）" },
    { role: "user", content: "2026-09-22 09:00 早安" },
    { role: "assistant", content: "（2026-09-22 10:30 自动唤醒：本次未发送推送）" },
    { role: "assistant", content: "（2026-09-22 10:40 刚刚给用户发了Bark推送：一｜消息）" },
    { role: "assistant", content: "（2026-09-22 10:50 刚刚给用户发了Bark推送：二｜消息）" }
  ];
  const parseTimestamp = content => {
    const match = String(content).match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
    return match ? new Date(`${match[1].replace(" ", "T")}:00Z`) : null;
  };

  assert.equal(countPushesSince(messages, new Date("2026-09-22T09:00:00Z"), {
    getContentText: String,
    isSuccessfulPushEventContent,
    parseTimestamp
  }), 2);
});

test("persists the higher push count and resets it for a new user message", () => {
  assert.deepEqual(reconcileWakeState({
    last_user_marker: "message-a",
    unanswered_pushes: 2
  }, "message-a", 1), {
    last_user_marker: "message-a",
    unanswered_pushes: 2
  });

  assert.deepEqual(reconcileWakeState({
    last_user_marker: "message-a",
    unanswered_pushes: 2
  }, "message-b", 0), {
    last_user_marker: "message-b",
    unanswered_pushes: 0
  });
});
