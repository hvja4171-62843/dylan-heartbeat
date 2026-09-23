const DEFAULT_HISTORY_LIMIT = 12;
const { isSpecialEventContent, isSuccessfulPushEventContent } = require("./special_events");

function clip(value, maxLength = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatWakeHistory(entries = [], options = {}) {
  const list = Array.isArray(entries) ? entries.slice(-(
    Number.isInteger(options.limit) && options.limit > 0
      ? options.limit
      : DEFAULT_HISTORY_LIMIT
  )) : [];

  if (list.length === 0) return "暂无已记录的自动唤醒。";

  const formatTime = typeof options.formatTime === "function"
    ? options.formatTime
    : value => String(value || "未知时间");

  return list.map(entry => {
    const time = formatTime(entry.attempted_at);
    const mode = entry.mode === "quiet_exception"
      ? "静默时段例外"
      : entry.mode === "legacy" ? "旧版记录" : "正常唤醒";

    if (entry.status === "model_started") {
      return `- ${time}（${mode}）：已发起模型唤醒，但没有保存到完成结果；不能确认模型是否产生了回复或推送。`;
    }

    if (entry.status === "model_error") {
      return `- ${time}（${mode}）：已调用模型，但请求失败；原因：${clip(entry.error || "未知错误", 180)}。没有确认发送推送。`;
    }

    if (entry.status === "push_error") {
      return `- ${time}（${mode}）：模型决定推送，但推送失败；原因：${clip(entry.push_reason || "未知错误", 180)}。`;
    }

    if (entry.legacy && entry.decision === "no_action") {
      return `- ${time}（${mode}）：旧版事件确认本次没有发送推送；原因：${clip(entry.reason || "未记录", 180)}。`;
    }

    if (entry.decision === "no_action") {
      const diary = entry.diary_written ? "，并写入了日记" : "";
      return `- ${time}（${mode}）：模型决定不推送${diary}；原因：${clip(entry.reason || "未提供", 180)}。`;
    }

    if (entry.decision === "push" && entry.push_status === "sent") {
      const title = clip(entry.push_title, 100);
      const body = clip(entry.push_body, 180);
      const content = title ? `标题“${title}”${body ? `，内容“${body}”` : ""}` : "已记录推送内容";
      return `- ${time}（${mode}）：模型决定推送，${entry.provider || "推送服务"} 已发送，${content}。`;
    }

    if (entry.decision === "push" && entry.push_status === "failed") {
      return `- ${time}（${mode}）：模型决定推送，但发送失败；原因：${clip(entry.push_reason || "未知错误", 180)}。`;
    }

    return `- ${time}（${mode}）：唤醒记录状态为“${clip(entry.status || "未知", 80)}”，不能据此确认是否推送。`;
  }).join("\n");
}

function buildLegacyWakeHistoryEntry(content, options = {}) {
  const text = String(content || "").trim();
  const parseTime = typeof options.parseTime === "function" ? options.parseTime : null;
  if (!text || !isSpecialEventContent(text) || !parseTime) return null;

  const attemptedAt = parseTime(text);
  if (!(attemptedAt instanceof Date) || Number.isNaN(attemptedAt.getTime())) return null;

  const base = {
    id: `legacy:${attemptedAt.toISOString()}:${text.slice(0, 120)}`,
    attempted_at: attemptedAt.toISOString(),
    user_message_at: null,
    mode: "legacy",
    legacy: true,
    status: "completed"
  };

  if (isSuccessfulPushEventContent(text)) {
    const provider = text.match(/发了\s*(Bark|ntfy)?\s*推送/i)?.[1] || "推送服务";
    const pushContent = text.match(/推送[：:]\s*(.*?)(?:｜|\||[）)]\s*$)/)?.[1]?.trim() || "";
    return {
      ...base,
      decision: "push",
      push_status: "sent",
      provider,
      push_content: clip(pushContent, 260)
    };
  }

  const reason = text.match(/原因[：:]\s*([^｜|）)]*)/)?.[1]?.trim();
  return {
    ...base,
    decision: "no_action",
    reason: reason || "旧版未记录具体原因"
  };
}

module.exports = {
  DEFAULT_HISTORY_LIMIT,
  buildLegacyWakeHistoryEntry,
  clip,
  formatWakeHistory
};
