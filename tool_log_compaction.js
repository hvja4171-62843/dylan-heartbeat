const TOOL_CONTENT_TYPES = new Set([
  "tool_use",
  "tool_result",
  "tool_call",
  "function_call",
  "function_result"
]);

function isToolContentPart(part) {
  if (!part || typeof part !== "object") return false;
  const type = String(part.type || "").trim().toLowerCase();
  return TOOL_CONTENT_TYPES.has(type) || Boolean(part.tool_call_id);
}

function hasMeaningfulContent(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) return content.length > 0;
  if (content != null) return true;
  return typeof message?.reasoning_content === "string" && message.reasoning_content.trim().length > 0;
}

function payloadSize(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function compactHistoricalToolLogs(messages, { enabled = true } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const beforePayloadChars = payloadSize(list);
  const latestUserIndex = list.findLastIndex(message => message?.role === "user");

  const stats = {
    enabled: Boolean(enabled),
    latest_user_index: latestUserIndex,
    removed_messages: 0,
    removed_tool_messages: 0,
    stripped_assistant_calls: 0,
    removed_content_parts: 0,
    before_payload_chars: beforePayloadChars,
    after_payload_chars: beforePayloadChars,
    removed_payload_chars: 0
  };

  if (!enabled || latestUserIndex < 0) {
    return { messages: list, stats };
  }

  const compacted = [];

  for (let index = 0; index < list.length; index++) {
    const message = list[index];

    // Preserve the latest user turn and everything after it so an active tool flow remains valid.
    if (index >= latestUserIndex) {
      compacted.push(message);
      continue;
    }

    if (message?.role === "tool" || message?.role === "function") {
      stats.removed_messages += 1;
      stats.removed_tool_messages += 1;
      continue;
    }

    let nextMessage = message;
    let changed = false;

    if (message?.role === "assistant" && (message.tool_calls || message.function_call)) {
      nextMessage = { ...nextMessage };
      delete nextMessage.tool_calls;
      delete nextMessage.function_call;
      stats.stripped_assistant_calls += 1;
      changed = true;
    }

    if (Array.isArray(message?.content)) {
      const filteredContent = message.content.filter(part => !isToolContentPart(part));
      const removedParts = message.content.length - filteredContent.length;
      if (removedParts > 0) {
        if (!changed) nextMessage = { ...nextMessage };
        nextMessage.content = filteredContent;
        stats.removed_content_parts += removedParts;
        changed = true;
      }
    }

    if (changed && !hasMeaningfulContent(nextMessage) && ["assistant", "user"].includes(nextMessage?.role)) {
      stats.removed_messages += 1;
      continue;
    }

    compacted.push(nextMessage);
  }

  stats.after_payload_chars = payloadSize(compacted);
  stats.removed_payload_chars = Math.max(0, stats.before_payload_chars - stats.after_payload_chars);
  return { messages: compacted, stats };
}

module.exports = { compactHistoricalToolLogs, isToolContentPart };
