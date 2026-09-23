const test = require("node:test");
const assert = require("node:assert/strict");
const { buildLegacyWakeHistoryEntry, formatWakeHistory } = require("../wake_history");

const formatTime = value => `时间:${value}`;

test("formats an incomplete wake attempt without claiming a push", () => {
  const result = formatWakeHistory([
    {
      attempted_at: "2026-09-23T12:00:00.000Z",
      mode: "quiet_exception",
      status: "model_started"
    }
  ], { formatTime });

  assert.match(result, /静默时段例外/);
  assert.match(result, /不能确认模型是否产生了回复或推送/);
});

test("formats a completed no-action and sent-push record", () => {
  const result = formatWakeHistory([
    {
      attempted_at: "2026-09-23T10:00:00.000Z",
      mode: "normal",
      status: "completed",
      decision: "no_action",
      reason: "用户正在休息"
    },
    {
      attempted_at: "2026-09-23T12:00:00.000Z",
      mode: "normal",
      status: "completed",
      decision: "push",
      push_status: "sent",
      provider: "Bark",
      push_title: "醒醒",
      push_body: "记得喝水"
    }
  ], { formatTime });

  assert.match(result, /模型决定不推送/);
  assert.match(result, /用户正在休息/);
  assert.match(result, /Bark 已发送/);
  assert.match(result, /记得喝水/);
});

test("migrates legacy timeline wake events without inventing missing details", () => {
  const parseTime = () => new Date("2026-09-23T12:00:00.000Z");
  const noAction = buildLegacyWakeHistoryEntry(
    "（2026-09-23 20:00 自动唤醒：本次未发送推送｜原因：模型空回复）",
    { parseTime }
  );
  const push = buildLegacyWakeHistoryEntry(
    "（2026-09-23 20:30 刚刚给用户发了Bark推送：醒醒｜记得喝水）",
    { parseTime }
  );

  assert.equal(noAction.legacy, true);
  assert.equal(noAction.decision, "no_action");
  assert.equal(noAction.reason, "模型空回复");
  assert.equal(push.push_status, "sent");
  assert.equal(push.provider, "Bark");
});
