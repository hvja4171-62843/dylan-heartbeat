const test = require("node:test");
const assert = require("node:assert/strict");
const { compactHistoricalImages, compactHistoricalToolLogs } = require("../tool_log_compaction");

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

test("replaces historical images while preserving dialogue text and the latest image", () => {
  const oldImage = { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(1000)}` } };
  const latestImage = { type: "image_url", image_url: { url: "https://example.test/current.png" } };
  const messages = [
    { role: "user", content: [{ type: "text", text: "What is in this picture?" }, oldImage] },
    { role: "assistant", content: "It is a red car." },
    { role: "assistant", content: [oldImage] },
    { role: "user", content: [{ type: "text", text: "Compare it with this one." }, latestImage] }
  ];

  const result = compactHistoricalImages(messages);

  assert.deepEqual(result.messages[0], {
    role: "user",
    content: [
      { type: "text", text: "What is in this picture?" },
      { type: "text", text: "[历史图片已省略]" }
    ]
  });
  assert.equal(result.messages[1].content, "It is a red car.");
  assert.deepEqual(result.messages[2].content, [{ type: "text", text: "[历史图片已省略]" }]);
  assert.equal(result.messages[3], messages[3]);
  assert.equal(messages[0].content[1], oldImage);
  assert.equal(result.stats.stripped_image_parts, 2);
  assert.ok(result.stats.removed_image_payload_chars > 1000);
  assert.ok(result.stats.removed_payload_chars > 0);
});

test("preserves all images when no user message exists or the feature is disabled", () => {
  const messages = [{ role: "system", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] }];

  assert.equal(compactHistoricalImages(messages).messages, messages);
  assert.equal(compactHistoricalImages(messages, { enabled: false }).messages, messages);
});
