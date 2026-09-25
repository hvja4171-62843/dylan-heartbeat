const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildUpstreamRequest,
  claudeRequestToOpenAi,
  parseUpstreamResponse,
  openAiPayloadToClaude,
  openAiSseToClaudeSse,
  claudeSseToOpenAiSse
} = require("../protocol_adapter");

test("builds Claude native request headers and body", () => {
  const result = buildUpstreamRequest({
    protocol: "claude",
    body: {
      model: "claude-test",
      stream: false,
      max_tokens: 100,
      temperature: 1.4,
      messages: []
    },
    messages: [
      { role: "system", content: "你是助手" },
      { role: "user", content: "你好" }
    ]
  });

  assert.equal(result.headers["x-api-key"], process.env.TARGET_API_KEY);
  assert.equal(result.headers["anthropic-version"], "2023-06-01");
  assert.equal(result.body.system, "你是助手");
  assert.equal(result.body.messages[0].content, "你好");
  assert.equal(result.body.temperature, 1);
});

test("converts Claude request messages to internal OpenAI shape", () => {
  const result = claudeRequestToOpenAi({
    model: "claude-test",
    max_tokens: 100,
    system: "系统规则",
    messages: [
      { role: "user", content: [{ type: "text", text: "调用工具" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "lookup", input: { q: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "结果" }] }
    ]
  });

  assert.deepEqual(result.messages[0], { role: "system", content: "系统规则" });
  assert.equal(result.messages[1].role, "user");
  assert.equal(result.messages[2].tool_calls[0].function.name, "lookup");
  assert.deepEqual(result.messages[3], { role: "tool", tool_call_id: "call-1", content: "结果" });
});

test("parses Claude non-stream and SSE text responses", () => {
  const json = parseUpstreamResponse(JSON.stringify({ content: [{ type: "text", text: "回来看看你" }] }), "application/json", "claude");
  assert.equal(json.choices[0].message.content, "回来看看你");

  const sse = parseUpstreamResponse([
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"回来"}}',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"看看你"}}'
  ].join("\n\n"), "text/event-stream", "claude");
  assert.equal(sse.choices[0].message.content, "回来看看你");
});

test("converts response protocols for a mismatched client", () => {
  const claude = openAiPayloadToClaude({
    id: "chat-1",
    model: "test",
    choices: [{ message: { content: "你好" }, finish_reason: "stop" }]
  });
  assert.equal(claude.type, "message");
  assert.equal(claude.content[0].text, "你好");

  const claudeSse = openAiSseToClaudeSse('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n', "text/event-stream");
  assert.match(claudeSse, /event: message_start/);
  assert.match(claudeSse, /你好/);

  const openAiSse = claudeSseToOpenAiSse('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\n\n');
  assert.match(openAiSse, /chat\.completion\.chunk/);
  assert.match(openAiSse, /你好/);
});
