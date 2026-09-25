const { parseChatCompletionResponse } = require("./upstream_response");

function normalizeProtocol(value) {
  return String(value || "openai").trim().toLowerCase() === "claude"
    ? "claude"
    : "openai";
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if (typeof part.text === "string") return part.text;
    if (typeof part.content === "string") return part.content;
    return "";
  }).filter(Boolean).join("\n");
}

function openAiContentToClaude(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return textFromContent(content);

  const blocks = [];
  for (const part of content) {
    if (typeof part === "string") {
      blocks.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string" || part.type === "text") {
      blocks.push({ type: "text", text: part.text || part.content || "" });
      continue;
    }
    if (part.type === "image_url" && part.image_url?.url) {
      const url = String(part.image_url.url);
      const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
      blocks.push(dataMatch
        ? { type: "image", source: { type: "base64", media_type: dataMatch[1], data: dataMatch[2] } }
        : { type: "image", source: { type: "url", url } });
    }
  }
  return blocks.length ? blocks : textFromContent(content);
}

function openAiMessagesToClaude(messages) {
  const output = [];
  let system = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role;
    if (role === "system") {
      const text = textFromContent(message.content);
      if (text) system.push(text);
      continue;
    }

    if (role === "tool") {
      const toolResult = {
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: textFromContent(message.content)
      };
      const previous = output[output.length - 1];
      if (previous?.role === "user" && Array.isArray(previous.content)) previous.content.push(toolResult);
      else output.push({ role: "user", content: [toolResult] });
      continue;
    }

    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const content = [];
      const text = textFromContent(message.content);
      if (text) content.push({ type: "text", text });
      for (const call of message.tool_calls) {
        let input = {};
        try { input = JSON.parse(call?.function?.arguments || "{}"); } catch {}
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.function?.name || "tool",
          input
        });
      }
      output.push({ role: "assistant", content });
      continue;
    }

    output.push({
      role: role === "assistant" ? "assistant" : "user",
      content: openAiContentToClaude(message?.content)
    });
  }

  return { system: system.join("\n\n"), messages: output };
}

function claudeBlockToOpenAi(block) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "text") return { type: "text", text: block.text || "" };
  if (block.type === "image" && block.source) {
    const source = block.source;
    const url = source.type === "base64"
      ? `data:${source.media_type};base64,${source.data}`
      : source.url;
    return { type: "image_url", image_url: { url } };
  }
  return null;
}

function claudeContentToOpenAi(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return textFromContent(content);
  const blocks = content.map(claudeBlockToOpenAi).filter(Boolean);
  return blocks.length ? blocks : textFromContent(content);
}

function claudeRequestToOpenAi(body) {
  const messages = [];
  const systemText = textFromContent(body?.system);
  if (systemText) messages.push({ role: "system", content: systemText });

  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    const content = Array.isArray(message.content) ? message.content : [];
    const toolUses = content.filter(block => block?.type === "tool_use");
    const toolResults = content.filter(block => block?.type === "tool_result");
    const normalBlocks = content.filter(block => !["tool_use", "tool_result"].includes(block?.type));

    if (toolUses.length) {
      messages.push({
        role: "assistant",
        content: claudeContentToOpenAi(normalBlocks),
        tool_calls: toolUses.map(block => ({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
        }))
      });
    } else if (normalBlocks.length || typeof message.content === "string") {
      messages.push({
        role: message.role === "assistant" ? "assistant" : "user",
        content: typeof message.content === "string" ? message.content : claudeContentToOpenAi(normalBlocks)
      });
    }

    for (const result of toolResults) {
      messages.push({ role: "tool", tool_call_id: result.tool_use_id, content: textFromContent(result.content) });
    }
  }

  return {
    ...body,
    messages,
    max_tokens: body?.max_tokens || body?.max_completion_tokens || 4096
  };
}

function openAiToolsToClaude(tools) {
  return Array.isArray(tools)
    ? tools.map(tool => tool?.function ? {
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters || { type: "object", properties: {} }
    } : tool).filter(Boolean)
    : undefined;
}

function buildUpstreamRequest({ body, messages, protocol }) {
  const targetProtocol = normalizeProtocol(protocol);
  if (targetProtocol === "openai") {
    return {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TARGET_API_KEY}` },
      body: { ...body, messages }
    };
  }

  const claudeMessages = openAiMessagesToClaude(messages);
  const temperature = Number(body?.temperature);
  const claudeBody = {
    model: body?.model,
    system: claudeMessages.system || undefined,
    messages: claudeMessages.messages,
    max_tokens: body?.max_tokens || body?.max_completion_tokens || 4096,
    stream: body?.stream === true
  };
  if (Number.isFinite(temperature)) claudeBody.temperature = Math.max(0, Math.min(1, temperature));
  if (Number.isFinite(Number(body?.top_p))) claudeBody.top_p = body.top_p;
  const tools = openAiToolsToClaude(body?.tools);
  if (tools?.length) claudeBody.tools = tools;

  return {
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.TARGET_API_KEY,
      "anthropic-version": process.env.ANTHROPIC_VERSION || "2023-06-01"
    },
    body: claudeBody
  };
}

function parseClaudeSse(text) {
  let content = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^data:\s*(.*)$/i);
    if (!match) continue;
    try {
      const payload = JSON.parse(match[1]);
      if (payload?.type === "content_block_delta" && payload?.delta?.type === "text_delta") content += payload.delta.text || "";
    } catch {}
  }
  return { choices: [{ message: { content } }] };
}

function parseUpstreamResponse(text, contentType, protocol) {
  if (normalizeProtocol(protocol) === "openai") return parseChatCompletionResponse(text, contentType);
  if (/text\/event-stream/i.test(contentType) || /^\s*(?:event:.*\r?\n)?data:/i.test(String(text || ""))) return parseClaudeSse(text);
  const payload = JSON.parse(String(text || "{}"));
  const content = Array.isArray(payload.content)
    ? payload.content.filter(item => item?.type === "text").map(item => item.text || "").join("")
    : textFromContent(payload.content);
  return { ...payload, choices: [{ message: { content } }] };
}

function openAiPayloadToClaude(payload) {
  const choice = payload?.choices?.[0] || {};
  const text = textFromContent(choice.message?.content || choice.delta?.content);
  return {
    id: payload?.id || `msg_gateway_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: payload?.model,
    content: text ? [{ type: "text", text }] : [],
    stop_reason: choice.finish_reason || "end_turn",
    stop_sequence: null,
    usage: payload?.usage || {}
  };
}

function openAiSseToClaudeSse(text, contentType) {
  const raw = String(text || "");
  const isSse = /^\s*(?:event:.*\r?\n)?data:/i.test(raw);
  const payload = isSse
    ? parseChatCompletionResponse(raw, contentType || "text/event-stream")
    : parseChatCompletionResponse(raw, "application/json");
  const message = openAiPayloadToClaude(payload);
  const textBlock = message.content[0]?.text || "";
  const events = [
    { event: "message_start", data: { type: "message_start", message: { ...message, content: [], stop_reason: null } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }
  ];
  if (textBlock) {
    events.push({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: textBlock } }
    });
  }
  events.push(
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: message.stop_reason }, usage: message.usage } },
    { event: "message_stop", data: { type: "message_stop" } }
  );
  return events.map(item => `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`).join("");
}

function claudeSseToOpenAiSse(text, contentType = "") {
  const raw = String(text || "");
  const isSse = /^\s*(?:event:.*\r?\n)?data:/i.test(raw);
  const payload = isSse
    ? parseClaudeSse(raw)
    : parseUpstreamResponse(raw, contentType, "claude");
  const choice = payload.choices?.[0] || {};
  const content = choice.message?.content || "";
  const chunk = {
    id: `chatcmpl_gateway_${Date.now()}`,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }]
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

module.exports = {
  buildUpstreamRequest,
  claudeRequestToOpenAi,
  normalizeProtocol,
  parseUpstreamResponse,
  openAiPayloadToClaude,
  openAiSseToClaudeSse,
  claudeSseToOpenAiSse
};
