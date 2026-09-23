const test = require("node:test");
const assert = require("node:assert/strict");
const { compactHistoricalToolLogs } = require("../tool_log_compaction");

test("removes historical tool traces without changing visible dialogue", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "old question" },
    { role: "assistant", content: null, tool_calls: [{ id: "old-call", type: "function" }] },
    { role: "tool", tool_call_id: "old-call", content: "large historical tool output" },
    { role: "assistant", content: "old visible answer" },
    { role: "user", content: "new question" },
    { role: "assistant", content: null, tool_calls: [{ id: "current-call", type: "function" }] },
    { role: "tool", tool_call_id: "current-call", content: "current tool output" }
  ];

  const result = compactHistoricalToolLogs(messages);

  assert.deepEqual(result.messages, [
    { role: "system", content: "system prompt" },
    { role: "user", content: "old question" },
    { role: "assistant", content: "old visible answer" },
    { role: "user", content: "new question" },
    { role: "assistant", content: null, tool_calls: [{ id: "current-call", type: "function" }] },
    { role: "tool", tool_call_id: "current-call", content: "current tool output" }
  ]);
  assert.equal(result.stats.removed_messages, 2);
  assert.equal(result.stats.removed_tool_messages, 1);
  assert.equal(result.stats.stripped_assistant_calls, 1);
  assert.ok(result.stats.removed_payload_chars > 0);
});

test("keeps assistant text while removing historical call metadata", () => {
  const messages = [
    { role: "user", content: "old question" },
    {
      role: "assistant",
      content: "I will check that.",
      tool_calls: [{ id: "old-call", type: "function" }]
    },
    { role: "tool", tool_call_id: "old-call", content: "tool output" },
    { role: "user", content: "new question" }
  ];

  const result = compactHistoricalToolLogs(messages);

  assert.deepEqual(result.messages, [
    { role: "user", content: "old question" },
    { role: "assistant", content: "I will check that." },
    { role: "user", content: "new question" }
  ]);
});

test("removes historical tool content parts but preserves normal content parts", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "tool_result", tool_call_id: "old-call", content: "large result" },
        { type: "text", text: "visible note" }
      ]
    },
    { role: "assistant", content: "old visible answer" },
    { role: "user", content: "new question" }
  ];

  const result = compactHistoricalToolLogs(messages);

  assert.deepEqual(result.messages[0], {
    role: "user",
    content: [{ type: "text", text: "visible note" }]
  });
  assert.equal(result.stats.removed_content_parts, 1);
});

test("can be disabled without cloning or changing messages", () => {
  const messages = [
    { role: "user", content: "old question" },
    { role: "tool", content: "tool output" },
    { role: "user", content: "new question" }
  ];

  const result = compactHistoricalToolLogs(messages, { enabled: false });
  assert.equal(result.messages, messages);
  assert.equal(result.stats.removed_messages, 0);
});
