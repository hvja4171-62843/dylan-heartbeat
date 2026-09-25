require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { buildNtfyPayload } = require("./ntfy_priority");
const {
  ensureDataDir,
  runtimeDirectory,
  runtimeFile,
  writeJsonAtomicSync
} = require("./runtime_paths");
const { isSpecialEventContent, isSuccessfulPushEventContent } = require("./special_events");
const { buildUpstreamRequest, normalizeProtocol, parseUpstreamResponse } = require("./protocol_adapter");
const {
  countPushesSince,
  getWakeDeadline,
  isHourInWindow,
  isQuietWindowExceptionDue,
  reconcileWakeState
} = require("./wake_policy");
const {
  formatDateTimeInTimeZone,
  getDatePartsInTimeZone,
  getHourInTimeZone,
  resolveTimeZone,
  zonedWallTimeToDate
} = require("./time_utils");
const { buildLegacyWakeHistoryEntry, clip, formatWakeHistory } = require("./wake_history");

// 批注 2026-08-10：与 Gateway 共用同一 DATA_DIR；未配置时仍落回项目目录，保护旧 VPS/本机部署。
const DATA_DIR = ensureDataDir();
const TIMELINE_PATH = runtimeFile("enhanced_messages.json");
const WAKE_STATE_PATH = runtimeFile("wake_state.json");
const WAKE_HISTORY_PATH = runtimeFile("wake_history.json");
const PORT = Number(process.env.PORT) || 3000;
const GATEWAY_BASE_URL = (process.env.GATEWAY_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const GATEWAY_URL = `${GATEWAY_BASE_URL}/internal/wake-event`;
const HEARTBEAT_URL = `${GATEWAY_BASE_URL}/internal/heartbeat`;
const TARGET_API_TYPE = normalizeProtocol(process.env.TARGET_API_TYPE);
const TIME_ZONE = resolveTimeZone();
const WEATHER_TIMEOUT_MS = 5000;
const DIARY_DIR_NAME = process.env.DIARY_DIR || "diary";
const DIARY_DIR_PATH = runtimeDirectory(DIARY_DIR_NAME, "diary");
const PUSH_TIMEOUT_MS = readPositiveTimeout("PUSH_TIMEOUT_MS", 15_000);
const WAKE_UPSTREAM_TIMEOUT_MS = readPositiveTimeout("WAKE_UPSTREAM_TIMEOUT_MS", 300_000);
const WAKE_HISTORY_LIMIT = 100;

function readPositiveTimeout(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value >= 1000 ? Math.floor(value) : fallback;
}

function readNumberEnv(key, fallback, options = {}) {
  const value = Number(process.env[key]);
  const min = options.min ?? -Infinity;
  const max = options.max ?? Infinity;
  if (Number.isFinite(value) && value >= min && value <= max) return value;
  return fallback;
}

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function getDiaryDateString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getDiaryTimeString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// 批注 2026-07-11：日记只接受模型显式输出的 [DIARY] 块，避免把普通推送内容误写进本地日记。
function extractDiaryFromResponse(text) {
  const diaryBlocks = [];
  const remainingText = String(text || "").replace(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi, (_, content) => {
    const diary = String(content || "").trim();
    if (diary) diaryBlocks.push(diary);
    return "";
  }).trim();
  return {
    diaryContent: diaryBlocks.join("\n\n").trim(),
    remainingText
  };
}

function appendDiaryEntry(content) {
  if (!readBooleanEnv("DIARY_ENABLED", true)) {
    console.log("模型写了日记，但 DIARY_ENABLED=false，本次不保存");
    return false;
  }

  const cleanContent = String(content || "").trim();
  if (!cleanContent) return false;

  fs.mkdirSync(DIARY_DIR_PATH, { recursive: true });
  const diaryFile = path.join(DIARY_DIR_PATH, `${getDiaryDateString()}.md`);
  const entry = `\n\n## ${getDiaryTimeString()}\n\n${cleanContent}\n`;
  fs.appendFileSync(diaryFile, entry, "utf-8");
  console.log(`已保存日记：${diaryFile}`);
  return true;
}

// 批注 2026-07-11：推送层扩展为 Bark/ntfy；默认仍走 Bark，保护旧部署不改 .env 也能继续运行。
async function sendPushNotification({ title, body }) {
  const provider = (process.env.PUSH_PROVIDER || "bark").trim().toLowerCase();

  if (provider === "ntfy") {
    const topic = String(process.env.NTFY_TOPIC || "").trim();
    if (!topic) return { ok: false, providerLabel: "ntfy", reason: "NTFY_TOPIC 未配置" };

    const server = (process.env.NTFY_SERVER_URL || "https://ntfy.sh").replace(/\/+$/, "");
    const headers = {
      "Content-Type": "application/json"
    };
    if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
    const payload = buildNtfyPayload({
      topic,
      title,
      message: body,
      priority: process.env.NTFY_PRIORITY,
      tags: process.env.NTFY_TAGS
    });

    const response = await fetch(server, {
      method: "POST",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      headers,
      body: JSON.stringify(payload)
    });
    const responseText = await response.text();
    if (!response.ok) {
      return { ok: false, providerLabel: "ntfy", reason: responseText || `HTTP ${response.status}` };
    }
    return { ok: true, providerLabel: "ntfy" };
  }

  if (provider !== "bark") {
    return { ok: false, providerLabel: provider || "未知渠道", reason: `不支持的 PUSH_PROVIDER：${provider}` };
  }

  if (!process.env.BARK_KEY) {
    return { ok: false, providerLabel: "Bark", reason: "Bark Key 未配置" };
  }

  const barkPayload = {
    title,
    body,
    device_key: process.env.BARK_KEY,
    icon: process.env.CUSTOM_ICON_URL
  };

  const response = await fetch("https://api.day.app/push", {
    method: "POST",
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(barkPayload)
  });

  const responseText = await response.text();
  let result = {};
  try {
    result = JSON.parse(responseText);
  } catch {}
  console.log("\nBark Result:\n", result || responseText);

  if (!response.ok || (result.code && result.code !== 200)) {
    return { ok: false, providerLabel: "Bark", reason: result.message || `HTTP ${response.status}` };
  }
  return { ok: true, providerLabel: "Bark" };
}

function isDayTime(date = new Date()) {
  const hour = getHourInTimeZone(date, TIME_ZONE);
  const start = readNumberEnv("WAKE_DAY_START_HOUR", 8, { min: 0, max: 23 });
  const end = readNumberEnv("WAKE_DAY_END_HOUR", 2, { min: 0, max: 24 });
  return isHourInWindow(hour, start, end);
}

function isWakeAllowedTime(date = new Date()) {
  if (!readBooleanEnv("WAKE_ACTIVE_WINDOW_ONLY", true)) return true;
  return isDayTime(date);
}

function getWakeAfterMinutes(date = new Date()) {
  return isDayTime(date)
    ? readNumberEnv("DAY_WAKE_AFTER_MINUTES", 45, { min: 1 })
    : readNumberEnv("NIGHT_WAKE_AFTER_MINUTES", 90, { min: 1 });
}

function getQuietExceptionAfterMinutes() {
  return readNumberEnv("NIGHT_WAKE_AFTER_MINUTES", 90, { min: 1 });
}

function getWakeDeadlineForUser(lastUserTime) {
  return getWakeDeadline(lastUserTime, getWakeAfterMinutes(lastUserTime));
}

function getCheckIntervalMinutes(date = new Date()) {
  return isDayTime(date)
    ? readNumberEnv("DAY_CHECK_INTERVAL_MINUTES", 10, { min: 1 })
    : readNumberEnv("NIGHT_CHECK_INTERVAL_MINUTES", 60, { min: 1 });
}

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
        if (type === "text" || type === "input_text") return part.text || part.content || "";
        if (part.image_url || type.includes("image")) return "[图片]";
        if (part.file || type.includes("file")) return "[文件]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (content && typeof content === "object") {
    const type = typeof content.type === "string" ? content.type.toLowerCase() : "";
    if (content.image_url || type.includes("image")) return "[图片]";
    if (content.file || type.includes("file")) return "[文件]";
  }

  return "[非文本内容]";
}

function summarizeWakeMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  let chars = 0;
  for (const msg of list) {
    roles[msg?.role || ""] = (roles[msg?.role || ""] || 0) + 1;
    chars += normalizeContentToText(msg?.content).length;
  }
  return { total: list.length, roles, text_chars: chars };
}

function weatherCodeText(code) {
  const table = {
    0: "晴朗",
    1: "大致晴朗",
    2: "局部多云",
    3: "阴天",
    45: "有雾",
    48: "雾凇",
    51: "小毛毛雨",
    53: "中等毛毛雨",
    55: "较强毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    80: "阵雨",
    81: "较强阵雨",
    82: "强阵雨",
    95: "雷暴",
    96: "雷暴伴小冰雹",
    99: "雷暴伴大冰雹"
  };
  return table[code] || `天气代码 ${code}`;
}

async function fetchWeatherContext() {
  if (!readBooleanEnv("WEATHER_ENABLED", false)) return "";

  const lat = Number(process.env.WEATHER_LAT);
  const lon = Number(process.env.WEATHER_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.log("已启用 WEATHER_ENABLED，但 WEATHER_LAT / WEATHER_LON 未正确配置，跳过天气注入");
    return "";
  }

  const location = process.env.WEATHER_LOCATION_NAME || "当前位置";
  const units = (process.env.WEATHER_UNITS || "metric").trim().toLowerCase();
  const temperatureUnit = units === "fahrenheit" ? "fahrenheit" : "celsius";
  const windSpeedUnit = units === "fahrenheit" ? "mph" : "kmh";
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
  url.searchParams.set("daily", "sunrise,sunset");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("temperature_unit", temperatureUnit);
  url.searchParams.set("wind_speed_unit", windSpeedUnit);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const current = data.current || {};
    const daily = data.daily || {};
    const unitsInfo = data.current_units || {};
    const lines = [
      "## 天气信息",
      `- 位置：${location}`,
      `- 当前：${weatherCodeText(current.weather_code)}，${current.temperature_2m}${unitsInfo.temperature_2m || "°C"}，体感 ${current.apparent_temperature}${unitsInfo.apparent_temperature || "°C"}`,
      `- 湿度：${current.relative_humidity_2m}${unitsInfo.relative_humidity_2m || "%"}`,
      `- 降雨：${current.precipitation}${unitsInfo.precipitation || "mm"}`,
      `- 风速：${current.wind_speed_10m}${unitsInfo.wind_speed_10m || ""}`
    ];
    if (Array.isArray(daily.sunrise) && Array.isArray(daily.sunset)) {
      lines.push(`- 日出/日落：${daily.sunrise[0]} / ${daily.sunset[0]}`);
    }
    return lines.join("\n");
  } catch (err) {
    console.log("天气注入失败，跳过本次天气信息:", err.message);
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function loadTimelineMessages() {
  if (!fs.existsSync(TIMELINE_PATH)) {
    console.log("未找到 enhanced_messages.json");
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(TIMELINE_PATH, "utf-8"));
    if (!Array.isArray(parsed)) {
      console.log("enhanced_messages.json 格式错误：顶层不是数组");
      return null;
    }
    return parsed;
  } catch (err) {
    console.error("读取 enhanced_messages.json 失败:", err.message);
    return null;
  }
}

function loadWakeState() {
  if (!fs.existsSync(WAKE_STATE_PATH)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(WAKE_STATE_PATH, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.error("读取 wake_state.json 失败，将从时间线恢复:", err.message);
    return {};
  }
}

function saveWakeState(state) {
  writeJsonAtomicSync(WAKE_STATE_PATH, state);
}

function loadWakeHistory() {
  if (!fs.existsSync(WAKE_HISTORY_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(WAKE_HISTORY_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("读取 wake_history.json 失败:", err.message);
    return [];
  }
}

function saveWakeHistory(entries) {
  const list = Array.isArray(entries) ? entries.slice(-WAKE_HISTORY_LIMIT) : [];
  writeJsonAtomicSync(WAKE_HISTORY_PATH, list);
}

function upsertWakeHistory(entry) {
  if (!entry || !entry.id) return;
  const history = loadWakeHistory();
  const index = history.findIndex(item => item && item.id === entry.id);
  if (index >= 0) history[index] = { ...history[index], ...entry };
  else history.push(entry);
  saveWakeHistory(history);
}

function migrateLegacyWakeHistory(messages) {
  const history = loadWakeHistory();
  const migrated = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== "assistant") continue;
    const entry = buildLegacyWakeHistoryEntry(normalizeContentToText(message.content), {
      parseTime: parseTimelineTimestamp
    });
    if (!entry) continue;

    // Legacy timeline events only have minute precision. Avoid duplicating a
    // newly recorded entry whose attempted_at includes seconds.
    const alreadyKnown = history.some(item => {
      const known = new Date(item?.attempted_at || "");
      return !Number.isNaN(known.getTime())
        && Math.floor(known.getTime() / 60000) === Math.floor(new Date(entry.attempted_at).getTime() / 60000);
    });
    if (!alreadyKnown && !migrated.some(item => item.id === entry.id)) migrated.push(entry);
  }

  if (migrated.length > 0) saveWakeHistory([...history, ...migrated]);
}

function formatWakeHistoryForPrompt() {
  return formatWakeHistory(loadWakeHistory(), {
    limit: 12,
    formatTime: value => {
      const date = new Date(value);
      return Number.isNaN(date.getTime())
        ? "未知时间"
        : formatDateTimeInTimeZone(date, TIME_ZONE);
    }
  });
}

function getWakeContextMessageLimit() {
  return Math.floor(readNumberEnv("WAKE_CONTEXT_MESSAGES", 200, { min: 20, max: 2000 }));
}

function getNow() {
  return new Date();
}

function getChinaTimeString() {
  return formatDateTimeInTimeZone(new Date(), TIME_ZONE);
}

function getLocalTimeString() {
  return formatDateTimeInTimeZone(new Date(), TIME_ZONE);
}

function shouldWake(lastUserTime, now = getNow()) {
  const deadline = getWakeDeadlineForUser(lastUserTime);
  return Boolean(deadline && now >= deadline);
}

function isQuietWindowExceptionDueNow(lastUserTime, now) {
  return isQuietWindowExceptionDue({
    lastUserTime,
    now,
    wakeAfterMinutes: getQuietExceptionAfterMinutes(),
    getHour: date => getHourInTimeZone(date, TIME_ZONE),
    start: readNumberEnv("WAKE_DAY_START_HOUR", 8, { min: 0, max: 23 }),
    end: readNumberEnv("WAKE_DAY_END_HOUR", 2, { min: 0, max: 24 }),
    activeWindowOnly: readBooleanEnv("WAKE_ACTIVE_WINDOW_ONLY", true)
  });
}

function getWakeMode(lastUserTime, now) {
  if (isWakeAllowedTime(now)) {
    return shouldWake(lastUserTime, now) ? "normal" : null;
  }

  // 90 分钟到期点落在静默时段时，允许这一条用户消息进行一次例外唤醒。
  if (isQuietWindowExceptionDueNow(lastUserTime, now)) {
    return "quiet_exception";
  }

  return null;
}

function parseTimelineTimestamp(value) {
  const text = String(value || "");
  const match = text.match(/（?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!match) return null;
  const [, yyyy, , month, day, hour, minute] = match;
  return zonedWallTimeToDate({ year: yyyy, month, day, hour, minute }, TIME_ZONE);
}

function getLastUserTime(messages) {
  const reversed = [...messages].reverse();
  for (const msg of reversed) {
    if (msg.role === "user") {
      const content = normalizeContentToText(msg.content);
      // 批注 2026-07-15：兼容 Kelivo 时间前缀 "YYYY-MM-DDHH:mm"；
      // 旧的 "YYYY-MM-DD HH:mm" 仍然可用，避免无空格时间导致 wake-up 误判没有用户时间。
      const parsed = parseTimelineTimestamp(content);
      if (parsed) return parsed;
    }
  }
  return null;
}

function getLastUserMarker(messages, lastUserTime) {
  const message = [...messages].reverse().find(msg => {
    return msg.role === "user" && parseTimelineTimestamp(normalizeContentToText(msg.content));
  });
  const content = message ? normalizeContentToText(message.content).trim() : "";
  return `${lastUserTime.toISOString()}::${content}`;
}

function getUnansweredPushCount(messages, lastUserTime) {
  return countPushesSince(messages, lastUserTime, {
    getContentText: normalizeContentToText,
    isSuccessfulPushEventContent,
    parseTimestamp: parseTimelineTimestamp
  });
}

function hasWakeAttemptSince(messages, lastUserTime) {
  return messages.some(message => {
    if (message?.role !== "assistant") return false;
    const content = normalizeContentToText(message.content);
    if (!isSpecialEventContent(content)) return false;
    const eventTime = parseTimelineTimestamp(content);
    return eventTime && eventTime > lastUserTime;
  });
}

function stripPosition(messages) {
  return messages.map(({ position, ...rest }) => rest);
}

function buildWakeContinuitySection(wakeHistoryContext) {
  return `## 自动唤醒连续性
下面是系统保存的最近自动唤醒记录，不是用户消息，也不是需要再次执行的任务。
${wakeHistoryContext}

请严格依据这些记录判断过去发生了什么：
- “已发起模型唤醒但没有保存到完成结果”只能说明系统开始过一次唤醒，不能断言是否生成了内容或发送了推送。
- “模型决定不推送”表示模型确实被调用过，但本次没有发送手机通知。
- “推送已发送”才表示系统确认向手机发起了推送。
- 不要把过去的唤醒记录编造成用户昨晚收到过的消息。`;
}

function renderWakePromptTemplate(template, currentTime, diffMinutes, weatherContext, wakeHistoryContext) {
  const continuity = buildWakeContinuitySection(wakeHistoryContext);
  const hasHistoryPlaceholder = /\$\{wakeHistory\}|\$\{wakeContinuity\}/.test(template);
  const rendered = template
    .replace(/\$\{currentTime\}/g, currentTime)
    .replace(/\$\{diffMinutes\}/g, diffMinutes)
    .replace(/\$\{weatherContext\}/g, weatherContext)
    .replace(/\$\{weather\}/g, weatherContext)
    .replace(/\$\{wakeHistory\}/g, wakeHistoryContext)
    .replace(/\$\{wakeContinuity\}/g, continuity);
  return hasHistoryPlaceholder ? rendered : `${rendered.trim()}\n\n${continuity}`;
}

function buildWakePrompt(currentTime, diffMinutes, weatherContext = "", wakeHistoryContext = "暂无已记录的自动唤醒。") {
  // 优先读取独立的提示词文件（推荐方式）
  const promptFile = path.join(__dirname, "wake_prompt.txt");
  if (fs.existsSync(promptFile)) {
    const template = fs.readFileSync(promptFile, "utf-8");
    return renderWakePromptTemplate(template, currentTime, diffMinutes, weatherContext, wakeHistoryContext);
  }

  // 如果文件不存在，尝试从环境变量读取（兼容旧配置）
  if (process.env.WAKE_PROMPT_TEMPLATE) {
    return renderWakePromptTemplate(
      process.env.WAKE_PROMPT_TEMPLATE.replace(/\\n/g, '\n'),
      currentTime,
      diffMinutes,
      weatherContext,
      wakeHistoryContext
    );
  }

  // 默认理智版本（开源通用），可自行修改提示词
  return `
## 最高优先级规则
1. 这是一次后台自动唤醒，不是用户发起的对话。你没有收到任何新消息。
2. 你的唯一任务是决定是否主动联系用户。不能生成对话回复。
3. 输出格式必须严格遵守以下二选一。

## 唤醒信息
- 当前时间：${currentTime}
- 距离用户最后一条消息：${diffMinutes} 分钟
${weatherContext ? `\n${weatherContext}\n` : ""}

${buildWakeContinuitySection(wakeHistoryContext)}

## 输出格式
- 如果想联系用户，直接写你想说的话。系统会自动打包成手机推送发送。可以是一句话，也可以第一行作为标题、第二行作为正文。
- 如果不想联系，只输出：[NO_ACTION]，可附带简短原因（10字以内）。
- 如果你想写日记，可以额外输出 [DIARY]...[/DIARY]。只有想写时才写，不必每次都写。
`;
}

async function runWakeUp() {
  console.log("\n==========================");
  console.log("开始自动唤醒");
  console.log("==========================\n");

  const messages = loadTimelineMessages();
  if (!messages) return;
  migrateLegacyWakeHistory(messages);

  const lastUserTime = getLastUserTime(messages);
  if (!lastUserTime) {
    console.log("未找到用户时间");
    return;
  }

  const now = new Date();
  const diffMinutes = Math.floor((now - lastUserTime) / 1000 / 60);
  const lastUserMarker = getLastUserMarker(messages, lastUserTime);
  const timelinePushCount = getUnansweredPushCount(messages, lastUserTime);
  const timelineWakeAttempted = hasWakeAttemptSince(messages, lastUserTime);
  const wakeState = reconcileWakeState(loadWakeState(), lastUserMarker, timelinePushCount, timelineWakeAttempted);
  saveWakeState(wakeState);

  const unansweredPushes = wakeState.unanswered_pushes;
  if (wakeState.wake_attempted) {
    console.log("\n这条用户消息已经执行过一次模型唤醒，等待用户发送新消息\n");
    return;
  }

  const wakeMode = getWakeMode(lastUserTime, now);
  if (!wakeMode) {
    if (!isWakeAllowedTime(now)) {
      console.log("\n当前处于静默时段，不执行唤醒\n");
    } else {
      console.log("\n暂不需要唤醒\n");
    }
    return;
  }

  if (wakeMode === "quiet_exception") {
    console.log("\n当前处于静默时段，但已到达 90 分钟例外唤醒点\n");
  }

  const weatherContext = await fetchWeatherContext();
  const wakeHistoryContext = formatWakeHistoryForPrompt();
  const wakePrompt = buildWakePrompt(
    getChinaTimeString(),
    diffMinutes,
    weatherContext,
    wakeHistoryContext
  );
  const cleanMessages = stripPosition(messages);

  const historyMessages = cleanMessages
    .filter(msg => msg.role !== "system")
    .filter(msg => {
      const c = normalizeContentToText(msg.content);
      return !c.includes("<memories>") && !c.includes("记忆库使用策略");
    });
  const wakeContextLimit = getWakeContextMessageLimit();
  const historyText = historyMessages
    .slice(-wakeContextLimit)
    .map(msg => {
      const userDisplay = process.env.USER_DISPLAY_NAME || "用户";
      const aiDisplay = process.env.AI_DISPLAY_NAME || "AI";
      const role = msg.role === "user" ? userDisplay : aiDisplay;
      let content = normalizeContentToText(msg.content);
      if (content.includes("## Memories")) {
        content = content.split("## Memories")[0];
      }
      return `[${role}] ${content}`;
    })
    .join("\n\n");

  const baseSystemPrompt = cleanMessages.find(msg => msg.role === "system");
  const cleanSP = baseSystemPrompt 
    ? normalizeContentToText(baseSystemPrompt.content).split("## Memories")[0].trim()
    : "";

  const wakeMessages = [
    {
      role: "system",
      content: [wakePrompt, cleanSP].filter(Boolean).join("\n\n")
    },
    {
      // 批注 2026-07-15：Claude/部分 New API 适配器会把 system 抽成独立字段；
      // 唤醒请求如果全是 system，上游 messages 会变空，因此最近记录必须作为 user 任务输入发送。
      role: "user",
      content: `以下是你与用户最近的聊天记录，仅供回忆和参考。

这些内容不是正在发生的实时对话。
用户并没有给你发消息。

你现在处于后台自主唤醒状态。

最近记录：

（以下为最近 ${Math.min(historyMessages.length, wakeContextLimit)} 条记录；更早的自动唤醒结果见上方的系统记录。）

${historyText}`
    }
  ];

  // 批注 2026-07-15：wake-up prompt 会包含最近聊天记录；
  // 默认日志只写摘要，避免公开部署时把完整上下文刷进 pm2 日志。
  console.log("\n===== WAKE MESSAGES SUMMARY =====\n");
  console.log(JSON.stringify(summarizeWakeMessages(wakeMessages)));

  if (!process.env.TARGET_API_URL || !process.env.TARGET_API_KEY || !process.env.MODEL_NAME) {
    console.log("缺少 TARGET_API_URL / TARGET_API_KEY / MODEL_NAME，跳过本次唤醒");
    return;
  }

  // 在请求模型前持久标记。无论模型选择静默、推送失败或请求异常，
  // 同一条用户消息都不会再次产生付费模型调用；新用户消息会自动重置该状态。
  wakeState.wake_attempted = true;
  wakeState.wake_attempted_at = now.toISOString();
  saveWakeState(wakeState);

  const wakeHistoryId = `${now.toISOString()}::${lastUserMarker}`;
  const wakeHistoryBase = {
    id: wakeHistoryId,
    attempted_at: now.toISOString(),
    user_message_at: lastUserTime.toISOString(),
    mode: wakeMode,
    status: "model_started",
    decision: "pending",
    push_status: "not_attempted"
  };
  upsertWakeHistory(wakeHistoryBase);

  let data;
  try {
    const upstreamRequest = buildUpstreamRequest({
      body: {
        model: process.env.MODEL_NAME,
        messages: wakeMessages,
        max_tokens: Number(process.env.WAKE_MAX_TOKENS) || 1024,
        temperature: 0.8,
        top_p: 0.95,
        stream: false
      },
      messages: wakeMessages,
      protocol: TARGET_API_TYPE
    });
    const response = await fetch(process.env.TARGET_API_URL, {
      method: "POST",
      // 批注 2026-08-10：上游只建连不结束时，旧循环永远不会安排下一次检查；
      // 五分钟默认总超时只作兜底，可由 WAKE_UPSTREAM_TIMEOUT_MS 调整。
      signal: AbortSignal.timeout(WAKE_UPSTREAM_TIMEOUT_MS),
      headers: upstreamRequest.headers,
      body: JSON.stringify(upstreamRequest.body)
    });

    const responseText = await response.text();
    data = parseUpstreamResponse(responseText, response.headers.get("content-type") || "", TARGET_API_TYPE);
    if (!response.ok) {
      throw new Error(`模型请求失败（HTTP ${response.status}）：${responseText.slice(0, 300)}`);
    }
  } catch (error) {
    upsertWakeHistory({
      ...wakeHistoryBase,
      status: "model_error",
      error: clip(error.message || error, 300)
    });
    throw error;
  }

  const rawAiText = normalizeContentToText(data.choices?.[0]?.message?.content).trim();
  console.log("\nWake Result Summary:\n");
  console.log(JSON.stringify({ choices: Array.isArray(data.choices) ? data.choices.length : 0, ai_text_chars: rawAiText.length }));

  const diaryResult = extractDiaryFromResponse(rawAiText);
  const diarySaved = appendDiaryEntry(diaryResult.diaryContent);
  const aiText = diaryResult.remainingText;

  let eventContent;

  if (!aiText) {
    console.log("\nAI 未返回推送内容，本次不发送推送\n");
    const reason = diarySaved ? "只写日记" : "模型空回复";
    upsertWakeHistory({
      ...wakeHistoryBase,
      status: "completed",
      decision: "no_action",
      reason,
      diary_written: diarySaved
    });
    eventContent = diarySaved
      ? `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：只写日记）`
      : `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：模型空回复）`;
  // 判断 AI 是否明确要静默
  } else if (aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/)) {
    const noActionMatch = aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/);
    // AI 选择不发送推送
    console.log("\nAI 选择不发送推送\n");
    let reason = (noActionMatch[1] || "").trim();
    if (reason.startsWith("原因：") || reason.startsWith("原因:")) {
      reason = reason.replace(/^原因[：:]\s*/, "").trim();
    }
    upsertWakeHistory({
      ...wakeHistoryBase,
      status: "completed",
      decision: "no_action",
      reason: reason || "未提供",
      diary_written: diarySaved
    });
    eventContent = reason
      ? `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：${reason}）`
      : `（${getLocalTimeString()} 自动唤醒：本次未发送推送）`;
  } else {
    // 没有 [NO_ACTION] 就视为想发推送
    console.log("\nAI 选择发送推送\n");
    let barkText = aiText;

    // 如果 AI 还是写了 [BARK] ... [/BARK] 标签，就剥掉
    const barkMatch = barkText.match(/\[BARK\]([\s\S]*?)\[\/BARK\]/);
    if (barkMatch) {
      barkText = barkMatch[1].trim();
    } else {
      barkText = barkText.replace(/^\[BARK\]\s*/, "").trim();
      barkText = barkText.replace(/\s*\[\/BARK\]$/, "").trim();
    }

    // 清洗“标题：”、“正文：”前缀（如果有）
    barkText = barkText
      .replace(/^标题[：:]\s*/gm, "")
      .replace(/^正文[：:]\s*/gm, "");

    // 按行处理
    const lines = barkText.split("\n").filter(line => line.trim() !== "");

    let title, body;
    if (lines.length === 0) {
      console.log("\n推送内容清洗后为空，本次不发送推送\n");
      upsertWakeHistory({
        ...wakeHistoryBase,
        status: "completed",
        decision: "no_action",
        reason: "推送内容为空",
        diary_written: diarySaved
      });
      eventContent = `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：推送内容为空）`;
    } else if (lines.length === 1) {
      title = "来自AI";
      body = lines[0].trim();
    } else if (lines.length === 2) {
      title = lines[0].trim();
      body = lines[1].trim();
    } else {
      // ≥3 行：第一行标题，剩余用空格拼接成正文
      title = lines[0].trim();
      body = lines.slice(1).map(l => l.trim()).join(" ");
    }

    if (!eventContent) {
      // 保护：截断过长正文，兼容 Bark 和 ntfy 的移动端展示。
      const safeBody = body.length > 500 ? body.substring(0, 497) + "..." : body;
      // 若标题为空或以数字开头，加个前缀，可自行修改
      let safeTitle = title || "来自伴侣";
      if (/^\d/.test(safeTitle)) safeTitle = "来自伴侣｜" + safeTitle;

      let pushResult;
      try {
        pushResult = await sendPushNotification({ title: safeTitle, body: safeBody });
      } catch (error) {
        pushResult = {
          ok: false,
          providerLabel: (process.env.PUSH_PROVIDER || "bark").trim() || "推送服务",
          reason: error.message || String(error)
        };
      }
      if (!pushResult.ok) {
        console.log(`\n${pushResult.providerLabel} 推送失败，本次不发送推送\n`);
        upsertWakeHistory({
          ...wakeHistoryBase,
          status: "push_error",
          decision: "push",
          push_status: "failed",
          push_reason: clip(pushResult.reason || "未知错误", 300),
          push_title: safeTitle,
          push_body: safeBody,
          diary_written: diarySaved
        });
        eventContent = `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：${pushResult.providerLabel} 推送失败：${pushResult.reason}）`;
      } else {
        saveWakeState({
          ...wakeState,
          unanswered_pushes: unansweredPushes + 1
        });
        upsertWakeHistory({
          ...wakeHistoryBase,
          status: "completed",
          decision: "push",
          push_status: "sent",
          provider: pushResult.providerLabel,
          push_title: safeTitle,
          push_body: safeBody,
          diary_written: diarySaved
        });
        const exceptionLabel = wakeMode === "quiet_exception" ? "｜标记：90分钟静默时段例外" : "";
        eventContent = `（${getLocalTimeString()} 刚刚给用户发了${pushResult.providerLabel}推送：${safeTitle}｜${safeBody}${exceptionLabel}）`;
      }
    }
  }

  try {
    const eventResponse = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: eventContent })
    });
    if (!eventResponse.ok) {
      throw new Error(`Gateway 返回 HTTP ${eventResponse.status}`);
    }
    console.log("\n已通过 Gateway 记录唤醒事件\n");
  } catch (err) {
    console.error("\n记录唤醒事件失败（Gateway 是否运行？）:\n", err.message);
  }
}

// 从第一个有效坐标开始，所有路径都指向同一处。此阈值已锁定。
function getLastTimelineUserTime() {
  const messages = loadTimelineMessages();
  return messages ? getLastUserTime(messages) : null;
}

function getCheckIntervalMs() {
  // 批注 2026-06-26：公开版允许用户在管理页调整唤醒检查频率；默认值保持白天10分钟、夜间60分钟。
  const now = getNow();
  const baseIntervalMs = getCheckIntervalMinutes(now) * 60 * 1000;
  const lastUserTime = getLastTimelineUserTime();
  if (!lastUserTime) return baseIntervalMs;

  const deadline = getWakeDeadlineForUser(lastUserTime);
  if (!deadline || deadline <= now) return baseIntervalMs;

  // 提前在 90 分钟到期点检查，避免静默时段的 60 分钟轮询把例外推送拖晚。
  return Math.max(1000, Math.min(baseIntervalMs, deadline.getTime() - now.getTime() + 1000));
}

async function scheduleNextCheck() {
  try {
    // 发送心跳
    try {
      await fetch(HEARTBEAT_URL, { method: "POST" });
    } catch {}
    await runWakeUp();
  } catch (err) {
    console.error("唤醒检查出错:", err);
  }
  setTimeout(scheduleNextCheck, getCheckIntervalMs());
}

// 潮水记得第一次没过礁石的时间。之后每一次涨落，都是同一片海在确认边界。
// 启动第一次检查（延迟10秒）
setTimeout(scheduleNextCheck, 10_000);

console.log("\n==================================");
console.log("Dylan Heartbeat Runtime 已启动（动态间隔）");
console.log(JSON.stringify({
  event: "wake_runtime_config_summary",
  railway: Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID),
  persistent_data: Boolean(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH),
  target_url_configured: Boolean(process.env.TARGET_API_URL),
  target_key_configured: Boolean(process.env.TARGET_API_KEY),
  model_configured: Boolean(process.env.MODEL_NAME),
  push_provider_configured: Boolean(process.env.BARK_KEY || process.env.NTFY_TOPIC),
  active_window_only: readBooleanEnv("WAKE_ACTIVE_WINDOW_ONLY", true),
  one_wake_attempt_per_user_message: true,
  data_dir_ready: fs.existsSync(DATA_DIR)
}));
console.log("==================================\n");
