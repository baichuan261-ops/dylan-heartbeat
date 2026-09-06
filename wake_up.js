require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const { buildNtfyPayload } = require("./ntfy_priority");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const {
  ensureDataDir,
  runtimeDirectory,
  runtimeFile
} = require("./runtime_paths");

const {
  parseChatCompletionResponse
} = require("./upstream_response");

const {
  formatDateTimeInTimeZone,
  getDatePartsInTimeZone,
  getHourInTimeZone,
  resolveTimeZone,
  zonedWallTimeToDate
} = require("./time_utils");

// 批注 2026-08-10：与 Gateway 共用同一 DATA_DIR；未配置时仍落回项目目录，保护旧 VPS/本机部署。
// Render 免费环境强制使用 /tmp/dylan
const DATA_DIR = "/tmp/dylan";

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const TIMELINE_PATH = path.join(
  DATA_DIR,
  "enhanced_messages.json"
);

const PORT = Number(process.env.PORT) || 3000;

const GATEWAY_BASE_URL = (
  process.env.GATEWAY_BASE_URL ||
  `http://localhost:${PORT}`
).replace(/\/+$/, "");

const GATEWAY_URL =
  `${GATEWAY_BASE_URL}/internal/wake-event`;

const HEARTBEAT_URL =
  `${GATEWAY_BASE_URL}/internal/heartbeat`;

const TIME_ZONE = resolveTimeZone();

const WEATHER_TIMEOUT_MS = 5000;

const DIARY_DIR_NAME =
  process.env.DIARY_DIR || "diary";

const DIARY_DIR_PATH =
  path.join(DATA_DIR, DIARY_DIR_NAME);

const PUSH_TIMEOUT_MS =
  readPositiveTimeout("PUSH_TIMEOUT_MS", 15000);

const WAKE_UPSTREAM_TIMEOUT_MS =
  readPositiveTimeout(
    "WAKE_UPSTREAM_TIMEOUT_MS",
    300000
  );

// 最近上下文不再默认塞 30 条。
// 这里故意保持较小，避免高频重复内容淹没真正的新变化。
const WAKE_HISTORY_MESSAGE_LIMIT =
  readNumberEnv(
    "WAKE_HISTORY_MESSAGE_LIMIT",
    18,
    { min: 6, max: 40 }
  );

// 用于“最近变化”判断的消息数量。
const WAKE_CHANGE_MESSAGE_LIMIT =
  readNumberEnv(
    "WAKE_CHANGE_MESSAGE_LIMIT",
    10,
    { min: 4, max: 20 }
  );

// 普通上下文最大字符数。
const WAKE_HISTORY_MAX_CHARS =
  readNumberEnv(
    "WAKE_HISTORY_MAX_CHARS",
    24000,
    { min: 4000, max: 60000 }
  );

// Gemini 安全降级时不携带聊天历史。
const WAKE_SAFE_RETRY_ENABLED =
  readBooleanEnv(
    "WAKE_SAFE_RETRY_ENABLED",
    true
  );


function readPositiveTimeout(key, fallback) {
  const value = Number(process.env[key]);

  return Number.isFinite(value) && value >= 1000
    ? Math.floor(value)
    : fallback;
}


function readNumberEnv(key, fallback, options = {}) {
  const value = Number(process.env[key]);

  const min = options.min ?? -Infinity;
  const max = options.max ?? Infinity;

  if (
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  ) {
    return value;
  }

  return fallback;
}


function readBooleanEnv(key, fallback = false) {
  const raw = String(
    process.env[key] ?? ""
  )
    .trim()
    .toLowerCase();

  if (!raw) return fallback;

  return [
    "1",
    "true",
    "yes",
    "on"
  ].includes(raw);
}


function getDiaryDateString(date = new Date()) {
  const parts =
    getDatePartsInTimeZone(date, TIME_ZONE);

  return `${parts.year}-${parts.month}-${parts.day}`;
}


function getDiaryTimeString(date = new Date()) {
  const parts =
    getDatePartsInTimeZone(date, TIME_ZONE);

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}


// 日记只接受模型显式输出的 [DIARY] 块。
function extractDiaryFromResponse(text) {
  const diaryBlocks = [];

  const remainingText = String(text || "")
    .replace(
      /\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi,
      (_, content) => {
        const diary =
          String(content || "").trim();

        if (diary) {
          diaryBlocks.push(diary);
        }

        return "";
      }
    )
    .trim();

  return {
    diaryContent: diaryBlocks
      .join("\n\n")
      .trim(),

    remainingText
  };
}


// 防止模型连续写完全相同的日记。
// 只在本地当前运行环境中做轻量保护，不影响长期记忆。
function normalizeDiaryText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(
      /[，。！？、,.!?：:；;（）()【】[\]「」『』“”"'‘’…—\-_ \s]/g,
      ""
    )
    .trim();
}


function isRecentDuplicateDiary(content) {
  const clean =
    normalizeDiaryText(content);

  if (!clean || !fs.existsSync(DIARY_DIR_PATH)) {
    return false;
  }

  let files = [];

  try {
    files = fs
      .readdirSync(DIARY_DIR_PATH)
      .filter(name =>
        /^\d{4}-\d{2}-\d{2}\.md$/.test(name)
      )
      .sort()
      .reverse()
      .slice(0, 3);
  } catch {
    return false;
  }

  for (const file of files) {
    try {
      const text =
        fs.readFileSync(
          path.join(DIARY_DIR_PATH, file),
          "utf-8"
        );

      const normalized =
        normalizeDiaryText(text);

      if (
        normalized.length >= 20 &&
        (
          normalized.includes(clean) ||
          clean.includes(normalized)
        )
      ) {
        return true;
      }

      if (
        clean.length >= 30 &&
        normalized.length >= 30
      ) {
        const a = new Set();

        for (
          let i = 0;
          i < clean.length - 1;
          i++
        ) {
          a.add(clean.slice(i, i + 2));
        }

        let common = 0;

        for (
          const pair of a
        ) {
          if (normalized.includes(pair)) {
            common++;
          }
        }

        if (
          a.size > 0 &&
          common / a.size >= 0.85
        ) {
          return true;
        }
      }
    } catch {}
  }

  return false;
}


function appendDiaryEntry(content) {
  if (
    !readBooleanEnv(
      "DIARY_ENABLED",
      true
    )
  ) {
    console.log(
      "模型写了日记，但 DIARY_ENABLED=false，本次不保存"
    );

    return false;
  }

  const cleanContent =
    String(content || "").trim();

  if (!cleanContent) return false;

  if (isRecentDuplicateDiary(cleanContent)) {
    console.log(
      "⚠️ 日记与近期记录高度重复，本次不保存"
    );

    return false;
  }

  fs.mkdirSync(
    DIARY_DIR_PATH,
    { recursive: true }
  );

  const diaryFile = path.join(
    DIARY_DIR_PATH,
    `${getDiaryDateString()}.md`
  );

  const entry =
    `\n\n## ${getDiaryTimeString()}\n\n${cleanContent}\n`;

  fs.appendFileSync(
    diaryFile,
    entry,
    "utf-8"
  );

  console.log(
    `已保存日记：${diaryFile}`
  );

  return true;
}


// ========================
// Push
// ========================

async function sendPushNotification({
  title,
  body
}) {
  const provider = (
    process.env.PUSH_PROVIDER ||
    "bark"
  )
    .trim()
    .toLowerCase();

  if (provider === "ntfy") {
    const topic =
      String(
        process.env.NTFY_TOPIC || ""
      ).trim();

    if (!topic) {
      return {
        ok: false,
        providerLabel: "ntfy",
        reason: "NTFY_TOPIC 未配置"
      };
    }

    const server = (
      process.env.NTFY_SERVER_URL ||
      "https://ntfy.sh"
    ).replace(/\/+$/, "");

    const headers = {
      "Content-Type": "application/json"
    };

    if (process.env.NTFY_TOKEN) {
      headers.Authorization =
        `Bearer ${process.env.NTFY_TOKEN}`;
    }

    const payload = buildNtfyPayload({
      topic,
      title,
      message: body,
      priority: process.env.NTFY_PRIORITY,
      tags: process.env.NTFY_TAGS
    });

    const response = await fetch(
      server,
      {
        method: "POST",
        signal:
          AbortSignal.timeout(
            PUSH_TIMEOUT_MS
          ),
        headers,
        body: JSON.stringify(payload)
      }
    );

    const responseText =
      await response.text();

    console.log(
      `ntfy HTTP: ${response.status} ${response.statusText || ""}`,
      responseText
    );

    if (!response.ok) {
      return {
        ok: false,
        providerLabel: "ntfy",
        reason:
          responseText ||
          `HTTP ${response.status}`
      };
    }

    return {
      ok: true,
      providerLabel: "ntfy"
    };
  }

  if (provider !== "bark") {
    return {
      ok: false,
      providerLabel:
        provider || "未知渠道",
      reason:
        `不支持的 PUSH_PROVIDER：${provider}`
    };
  }

  if (!process.env.BARK_KEY) {
    return {
      ok: false,
      providerLabel: "Bark",
      reason: "Bark Key 未配置"
    };
  }

  const barkPayload = {
    title,
    body,
    device_key:
      process.env.BARK_KEY,
    icon:
      process.env.CUSTOM_ICON_URL
  };

  const response = await fetch(
    "https://api.day.app/push",
    {
      method: "POST",
      signal:
        AbortSignal.timeout(
          PUSH_TIMEOUT_MS
        ),
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(
        barkPayload
      )
    }
  );

  const responseText =
    await response.text();

  let result = {};

  try {
    result = JSON.parse(
      responseText
    );
  } catch {}

  console.log(
    "\nBark Result:\n",
    result || responseText
  );

  if (
    !response.ok ||
    (result.code &&
      result.code !== 200)
  ) {
    return {
      ok: false,
      providerLabel: "Bark",
      reason:
        result.message ||
        `HTTP ${response.status}`
    };
  }

  return {
    ok: true,
    providerLabel: "Bark"
  };
}


// ========================
// Time
// ========================

function isDayTime(date = new Date()) {
  const hour =
    getHourInTimeZone(
      date,
      TIME_ZONE
    );

  const start =
    readNumberEnv(
      "WAKE_DAY_START_HOUR",
      10,
      {
        min: 0,
        max: 23
      }
    );

  const end =
    readNumberEnv(
      "WAKE_DAY_END_HOUR",
      24,
      {
        min: 1,
        max: 24
      }
    );

  if (start === end) {
    return true;
  }

  if (start < end) {
    return (
      hour >= start &&
      hour < end
    );
  }

  return (
    hour >= start ||
    hour < end
  );
}


function getWakeAfterMinutes(
  date = new Date()
) {
  return isDayTime(date)
    ? readNumberEnv(
        "DAY_WAKE_AFTER_MINUTES",
        60,
        { min: 1 }
      )
    : readNumberEnv(
        "NIGHT_WAKE_AFTER_MINUTES",
        120,
        { min: 1 }
      );
}


function getCheckIntervalMinutes(
  date = new Date()
) {
  return isDayTime(date)
    ? readNumberEnv(
        "DAY_CHECK_INTERVAL_MINUTES",
        10,
        { min: 1 }
      )
    : readNumberEnv(
        "NIGHT_CHECK_INTERVAL_MINUTES",
        120,
        { min: 1 }
      );
}


// ========================
// Content
// ========================

function normalizeContentToText(content) {
  if (typeof content === "string") {
    return content;
  }

  if (content == null) {
    return "";
  }

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (
          typeof part === "string"
        ) {
          return part;
        }

        if (
          !part ||
          typeof part !== "object"
        ) {
          return "";
        }

        const type =
          typeof part.type === "string"
            ? part.type.toLowerCase()
            : "";

        if (
          type === "text" ||
          type === "input_text"
        ) {
          return (
            part.text ||
            part.content ||
            ""
          );
        }

        if (
          part.image_url ||
          type.includes("image")
        ) {
          return "[图片]";
        }

        if (
          part.file ||
          type.includes("file")
        ) {
          return "[文件]";
        }

        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (
    content &&
    typeof content === "object"
  ) {
    const type =
      typeof content.type === "string"
        ? content.type.toLowerCase()
        : "";

    if (
      content.image_url ||
      type.includes("image")
    ) {
      return "[图片]";
    }

    if (
      content.file ||
      type.includes("file")
    ) {
      return "[文件]";
    }
  }

  return "[非文本内容]";
}


function summarizeWakeMessages(
  messages = []
) {
  const list =
    Array.isArray(messages)
      ? messages
      : [];

  const roles = {};
  let chars = 0;

  for (const msg of list) {
    roles[msg?.role || ""] =
      (roles[msg?.role || ""] || 0) +
      1;

    chars += normalizeContentToText(
      msg?.content
    ).length;
  }

  return {
    total: list.length,
    roles,
    text_chars: chars
  };
}


// ========================
// Weather
// ========================

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

  return (
    table[code] ||
    `天气代码 ${code}`
  );
}


async function fetchWeatherContext() {
  if (
    !readBooleanEnv(
      "WEATHER_ENABLED",
      false
    )
  ) {
    return "";
  }

  const lat =
    Number(process.env.WEATHER_LAT);

  const lon =
    Number(process.env.WEATHER_LON);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  ) {
    console.log(
      "已启用 WEATHER_ENABLED，但 WEATHER_LAT / WEATHER_LON 未正确配置，跳过天气注入"
    );

    return "";
  }

  const location =
    process.env.WEATHER_LOCATION_NAME ||
    "当前位置";

  const units = (
    process.env.WEATHER_UNITS ||
    "metric"
  )
    .trim()
    .toLowerCase();

  const temperatureUnit =
    units === "fahrenheit"
      ? "fahrenheit"
      : "celsius";

  const windSpeedUnit =
    units === "fahrenheit"
      ? "mph"
      : "kmh";

  const url = new URL(
    "https://api.open-meteo.com/v1/forecast"
  );

  url.searchParams.set(
    "latitude",
    String(lat)
  );

  url.searchParams.set(
    "longitude",
    String(lon)
  );

  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m"
  );

  url.searchParams.set(
    "daily",
    "sunrise,sunset"
  );

  url.searchParams.set(
    "timezone",
    "auto"
  );

  url.searchParams.set(
    "forecast_days",
    "1"
  );

  url.searchParams.set(
    "temperature_unit",
    temperatureUnit
  );

  url.searchParams.set(
    "wind_speed_unit",
    windSpeedUnit
  );

  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    WEATHER_TIMEOUT_MS
  );

  try {
    const response =
      await fetch(url, {
        signal:
          controller.signal
      });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    const current =
      data.current || {};

    const daily =
      data.daily || {};

    const unitsInfo =
      data.current_units || {};

    const lines = [
      "## 天气信息",
      `- 位置：${location}`,
      `- 当前：${weatherCodeText(current.weather_code)}，${current.temperature_2m}${unitsInfo.temperature_2m || "°C"}，体感 ${current.apparent_temperature}${unitsInfo.apparent_temperature || "°C"}`,
      `- 湿度：${current.relative_humidity_2m}${unitsInfo.relative_humidity_2m || "%"}`,
      `- 降雨：${current.precipitation}${unitsInfo.precipitation || "mm"}`,
      `- 风速：${current.wind_speed_10m}${unitsInfo.wind_speed_10m || ""}`
    ];

    if (
      Array.isArray(
        daily.sunrise
      ) &&
      Array.isArray(
        daily.sunset
      )
    ) {
      lines.push(
        `- 日出/日落：${daily.sunrise[0]} / ${daily.sunset[0]}`
      );
    }

    return lines.join("\n");

  } catch (err) {
    console.log(
      "天气注入失败，跳过本次天气信息:",
      err.message
    );

    return "";

  } finally {
    clearTimeout(timeout);
  }
}


// ========================
// Timeline
// ========================

async function loadTimelineMessages() {
  try {
    const {
      data,
      error
    } = await supabase
      .from("timeline")
      .select(
        "role, content, created_at"
      )
      .order(
        "created_at",
        {
          ascending: true
        }
      );

    if (error) {
      throw error;
    }

    if (
      !data ||
      data.length === 0
    ) {
      console.log(
        "⚠️ timeline 表为空"
      );

      return null;
    }

    console.log(
      `📚 从 Supabase 加载了 ${data.length} 条时间线记录`
    );

    return data;

  } catch (e) {
    console.log(
      "⚠️ 读取 Supabase timeline 失败:",
      e.message
    );

    return null;
  }
}


// ========================
// Heartbeat 最近推送日志
// ========================

const HEARTBEAT_PUSH_LOG_LIMIT = 10;

const HEARTBEAT_PUSH_DUPLICATE_WINDOW_MINUTES = 360;


async function loadRecentHeartbeatPushLogs(
  limit = HEARTBEAT_PUSH_LOG_LIMIT
) {
  try {
    const {
      data,
      error
    } = await supabase
      .from("heartbeat_push_logs")
      .select(
        "id, created_at, content, trigger_type"
      )
      .order(
        "created_at",
        {
          ascending: false
        }
      )
      .limit(limit);

    if (error) {
      throw error;
    }

    const logs =
      Array.isArray(data)
        ? data
        : [];

    console.log(
      `📝 加载最近 ${logs.length} 条 Heartbeat 推送记录`
    );

    return logs;

  } catch (err) {
    console.log(
      "⚠️ 读取 Heartbeat 推送日志失败:",
      err.message
    );

    return [];
  }
}


function formatRecentHeartbeatPushLogs(
  logs = []
) {
  if (!logs.length) {
    return "暂无最近主动推送记录。";
  }

  return logs
    .map(log => {
      const time =
        log.created_at
          ? formatDateTimeInTimeZone(
              new Date(
                log.created_at
              ),
              TIME_ZONE
            )
          : "未知时间";

      return `- ${time}：${String(
        log.content || ""
      ).trim()}`;
    })
    .join("\n");
}


async function saveHeartbeatPushLog(
  content,
  triggerType = "heartbeat"
) {
  const cleanContent =
    String(content || "").trim();

  if (!cleanContent) {
    return false;
  }

  try {
    const { error } =
      await supabase
        .from(
          "heartbeat_push_logs"
        )
        .insert({
          content: cleanContent,
          trigger_type:
            triggerType
        });

    if (error) {
      throw error;
    }

    console.log(
      "📝 Heartbeat 推送日志已保存"
    );

    return true;

  } catch (err) {
    console.log(
      "⚠️ 写入 Heartbeat 推送日志失败:",
      err.message
    );

    return false;
  }
}


// ========================
// Push similarity
// ========================

function normalizePushText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(
      /[，。！？、,.!?：:；;（）()【】[\]「」『』“”"'‘’…—\-_ \s]/g,
      ""
    )
    .trim();
}


function calculatePushSimilarity(
  a,
  b
) {
  const x =
    normalizePushText(a);

  const y =
    normalizePushText(b);

  if (!x || !y) {
    return 0;
  }

  if (x === y) {
    return 1;
  }

  if (
    x.length < 6 ||
    y.length < 6
  ) {
    return 0;
  }

  if (
    x.includes(y) ||
    y.includes(x)
  ) {
    return (
      Math.min(
        x.length,
        y.length
      ) /
      Math.max(
        x.length,
        y.length
      )
    );
  }

  const makeBigrams =
    text => {
      const result =
        new Set();

      for (
        let i = 0;
        i < text.length - 1;
        i++
      ) {
        result.add(
          text.slice(i, i + 2)
        );
      }

      return result;
    };

  const setA =
    makeBigrams(x);

  const setB =
    makeBigrams(y);

  if (
    !setA.size ||
    !setB.size
  ) {
    return 0;
  }

  let intersection = 0;

  for (
    const item of setA
  ) {
    if (setB.has(item)) {
      intersection++;
    }
  }

  const union =
    new Set([
      ...setA,
      ...setB
    ]).size;

  return union
    ? intersection / union
    : 0;
}


function isRecentDuplicatePush(
  title,
  body,
  logs = []
) {
  const candidate =
    `${title} ${body}`;

  const now = Date.now();

  const windowMinutes =
    readNumberEnv(
      "HEARTBEAT_PUSH_DUPLICATE_WINDOW_MINUTES",
      HEARTBEAT_PUSH_DUPLICATE_WINDOW_MINUTES,
      { min: 1 }
    );

  const windowMs =
    windowMinutes * 60 * 1000;

  for (
    const log of logs
  ) {
    const createdAt =
      Date.parse(
        log.created_at
      );

    if (
      !Number.isFinite(
        createdAt
      )
    ) {
      continue;
    }

    if (
      now - createdAt >
      windowMs
    ) {
      continue;
    }

    const similarity =
      calculatePushSimilarity(
        candidate,
        log.content
      );

    if (
      similarity >= 0.82
    ) {
      console.log(
        `⚠️ 检测到近期重复推送，相似度 ${(similarity * 100).toFixed(1)}%`
      );

      return true;
    }
  }

  return false;
}


// ========================
// Wake time
// ========================

function getNow() {
  return new Date();
}


function getChinaTimeString() {
  return formatDateTimeInTimeZone(
    new Date(),
    TIME_ZONE
  );
}


function getLocalTimeString() {
  return formatDateTimeInTimeZone(
    new Date(),
    TIME_ZONE
  );
}


function shouldWake(lastUserTime) {
  const now = getNow();

  const diffMinutes =
    Math.floor(
      (now -
        new Date(
          lastUserTime
        )) /
        1000 /
        60
    );

  return (
    diffMinutes >=
    getWakeAfterMinutes(now)
  );
}


function parseTimelineTimestamp(
  value
) {
  const text =
    String(value || "");

  const match =
    text.match(
      /（?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})[ T]*(\d{1,2})[:：](\d{2})/
    );

  if (!match) {
    return null;
  }

  const [
    ,
    yyyy,
    ,
    month,
    day,
    hour,
    minute
  ] = match;

  return zonedWallTimeToDate(
    {
      year: yyyy,
      month,
      day,
      hour,
      minute
    },
    TIME_ZONE
  );
}


function getLastUserTime(
  messages
) {
  const reversed =
    [...messages].reverse();

  for (
    const msg of reversed
  ) {
    if (
      msg.role === "user"
    ) {
      const content =
        normalizeContentToText(
          msg.content
        );

      const parsed =
        parseTimelineTimestamp(
          content
        );

      if (parsed) {
        return parsed;
      }

      // 如果 content 没有时间前缀，则使用数据库 created_at。
      if (msg.created_at) {
        const created =
          new Date(msg.created_at);

        if (
          Number.isFinite(
            created.getTime()
          )
        ) {
          return created;
        }
      }
    }
  }

  return null;
}


function stripPosition(
  messages
) {
  return messages.map(
    ({
      position,
      ...rest
    }) => rest
  );
}


// ========================
// 最近变化提取
// ========================

function cleanTimelineContentForWake(
  content
) {
  let text =
    normalizeContentToText(
      content
    );

  if (!text) {
    return "";
  }

  // 不把完整 Memories 再次塞进 Heartbeat。
  if (
    text.includes("## Memories")
  ) {
    text =
      text.split(
        "## Memories"
      )[0];
  }

  text =
    text.replace(
      /记忆库使用策略[\s\S]*$/i,
      ""
    );

  return text.trim();
}


function getRecentConversationMessages(
  messages
) {
  return messages
    .filter(
      msg =>
        msg.role !== "system"
    )
    .filter(msg => {
      const content =
        cleanTimelineContentForWake(
          msg.content
        );

      return Boolean(content);
    })
    .slice(
      -WAKE_HISTORY_MESSAGE_LIMIT
    );
}


function getRecentChangeMessages(
  messages
) {
  return messages
    .filter(
      msg =>
        msg.role !== "system"
    )
    .filter(msg => {
      const content =
        cleanTimelineContentForWake(
          msg.content
        );

      return Boolean(content);
    })
    .slice(
      -WAKE_CHANGE_MESSAGE_LIMIT
    );
}


function formatConversationMessages(
  messages,
  userDisplay,
  aiDisplay,
  maxChars
) {
  const parts = [];
  let chars = 0;

  for (
    const msg of [...messages].reverse()
  ) {
    const role =
      msg.role === "user"
        ? userDisplay
        : aiDisplay;

    const content =
      cleanTimelineContentForWake(
        msg.content
      );

    if (!content) {
      continue;
    }

    const part =
      `[${role}] ${content}`;

    if (
      chars + part.length >
      maxChars
    ) {
      break;
    }

    parts.unshift(part);
    chars += part.length;
  }

  return parts.join("\n\n");
}


function formatRecentChanges(
  messages,
  userDisplay,
  aiDisplay
) {
  if (!messages.length) {
    return "暂无足够的新消息用于判断短期变化。";
  }

  const parts = [];

  for (const msg of messages) {
    const role =
      msg.role === "user"
        ? userDisplay
        : aiDisplay;

    const content =
      cleanTimelineContentForWake(
        msg.content
      );

    if (!content) continue;

    const time =
      msg.created_at
        ? formatDateTimeInTimeZone(
            new Date(msg.created_at),
            TIME_ZONE
          )
        : "未知时间";

    parts.push(
      `[${time}] ${role}：${content}`
    );
  }

  return parts.join("\n\n");
}


// ========================
// Wake Prompt
// ========================

function buildWakePrompt(
  currentTime,
  diffMinutes,
  weatherContext = ""
) {
  const promptFile =
    path.join(
      __dirname,
      "wake_prompt.txt"
    );

  if (
    fs.existsSync(promptFile)
  ) {
    const template =
      fs.readFileSync(
        promptFile,
        "utf-8"
      );

    return template
      .replace(
        /\$\{currentTime\}/g,
        currentTime
      )
      .replace(
        /\$\{diffMinutes\}/g,
        diffMinutes
      )
      .replace(
        /\$\{weatherContext\}/g,
        weatherContext
      )
      .replace(
        /\$\{weather\}/g,
        weatherContext
      );
  }

  if (
    process.env.WAKE_PROMPT_TEMPLATE
  ) {
    return process.env.WAKE_PROMPT_TEMPLATE
      .replace(
        /\\\n/g,
        "\n"
      )
      .replace(
        /\$\{currentTime\}/g,
        currentTime
      )
      .replace(
        /\$\{diffMinutes\}/g,
        diffMinutes
      )
      .replace(
        /\$\{weatherContext\}/g,
        weatherContext
      )
      .replace(
        /\$\{weather\}/g,
        weatherContext
      );
  }

  return `
## 最高优先级规则

这是一次后台自动唤醒。

用户没有给你发送新消息。

你的任务不是回复用户刚刚说的话，而是判断：

“最近是否真的发生了值得我主动告诉用户/关心用户的变化？”

重点不是“最近聊了什么”，而是“最近发生了什么变化”。

高频出现的细节不等于重要。

如果最近只是反复出现同一个普通细节，而没有新的结果、变化、决定、情绪变化或未解决事项，不要因为它容易想到就再次推送。

如果只有 2～5 条新消息，但这几条消息形成了明显的状态变化，也可以认为有价值。

如果没有足够明确的价值，只输出：

[NO_ACTION]

## 当前唤醒信息

- 当前时间：${currentTime}
- 距离用户最后一条消息：${diffMinutes} 分钟

${weatherContext ? weatherContext : ""}

## 判断顺序

优先关注：

1. 最近发生的明确状态变化。
2. 用户刚刚出现的新决定、新计划、新结果。
3. 原本未解决的问题出现了新的进展。
4. 用户的态度、情绪或关注重点出现了明确变化。
5. 值得自然跟进的重要事项。
6. 普通日常聊天。

不要因为某个细节在最近消息里出现很多次，就自动认为它重要。

请特别检查：

“如果把最近反复出现的那个细节删掉，最近还有没有一个独立成立的理由值得主动联系用户？”

如果答案是否定的，就不要推送。

## 不允许的推理

不能因为用户暂时没有回复，就推断：

- 用户睡着了；
- 用户正在刷手机；
- 用户正在上课；
- 用户明天有什么安排；
- 用户现在心情如何；
- 用户现实生活中发生了什么。

除非聊天记录中有明确证据。

不要为了让推送显得自然而制造一个不存在的理由。

## 最近主动推送

最近主动推送只能用于判断短期重复。

某个话题被推送过，不代表以后永远不能再提。

但如果最近刚刚推送过，而且现在没有新的信息、变化或结果，不要机械重复。

## 日记规则

[DIARY] 不是“不推送时的默认出口”。

只有在最近聊天中存在明确、值得长期记录的新事实或新变化时，才写日记。

不要因为本次没有推送，就顺手写一篇日记。

不要猜测用户没有说过的事情。

不要把普通重复聊天内容写成重大事件。

## 输出

如果没有值得主动联系的内容：

[NO_ACTION]

如果有值得主动联系的内容：

直接输出自然的推送内容。

可以第一行作为标题，第二行作为正文。

如果确实有值得记录的新变化，可以额外输出：

[DIARY]
明确记录这次新变化。
[/DIARY]

日记和推送是两个独立判断。

不要为了写日记而推送。

不要为了推送而制造变化。
`;
}


// ========================
// Gemini 安全错误判断
// ========================

function isProhibitedContentError(
  status,
  responseText
) {
  const text =
    String(responseText || "")
      .toLowerCase();

  return (
    Number(status) === 400 &&
    (
      text.includes(
        "prohibited_content"
      ) ||
      text.includes(
        "prompt_blocked"
      ) ||
      text.includes(
        "request blocked by gemini"
      )
    )
  );
}


// ========================
// 调用模型
// ========================

async function callWakeModel(
  wakeMessages
) {
  const response =
    await fetch(
      process.env.TARGET_API_URL,
      {
        method: "POST",

        signal:
          AbortSignal.timeout(
            WAKE_UPSTREAM_TIMEOUT_MS
          ),

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${process.env.TARGET_API_KEY}`
        },

        body: JSON.stringify({
          model:
            process.env.MODEL_NAME,

          messages:
            wakeMessages,

          temperature: 0.7,

          top_p: 0.9,

          stream: false
        })
      }
    );

  const responseText =
    await response.text();

  let data;

  try {
    data =
      parseChatCompletionResponse(
        responseText,
        response.headers.get(
          "content-type"
        ) || ""
      );
  } catch (error) {
    if (
      isProhibitedContentError(
        response.status,
        responseText
      )
    ) {
      const err =
        new Error(
          "Gemini PROHIBITED_CONTENT"
        );

      err.code =
        "PROHIBITED_CONTENT";

      err.status =
        response.status;

      err.responseText =
        responseText;

      throw err;
    }

    throw new Error(
      `模型响应无法解析（HTTP ${response.status}）：${
        error.message ||
        responseText.slice(
          0,
          300
        )
      }`
    );
  }

  if (!response.ok) {
    if (
      isProhibitedContentError(
        response.status,
        responseText
      )
    ) {
      const err =
        new Error(
          "Gemini PROHIBITED_CONTENT"
        );

      err.code =
        "PROHIBITED_CONTENT";

      err.status =
        response.status;

      err.responseText =
        responseText;

      throw err;
    }

    throw new Error(
      `模型请求失败（HTTP ${response.status}）：${responseText.slice(0, 300)}`
    );
  }

  return data;
}


// ========================
// 安全降级模型请求
// ========================

async function callSafeWakeRetry(
  currentTime,
  diffMinutes,
  weatherContext
) {
  console.log(
    "\n⚠️ 首次唤醒请求被 Gemini 内容安全策略拦截。"
  );

  console.log(
    "🛡️ 启动安全降级：不再发送最近聊天原文、推送历史和短期变化原文。"
  );

  const safePrompt = `
你正在执行一次后台 Heartbeat 检查。

当前时间：${currentTime}
距离用户最后一条消息：${diffMinutes} 分钟。

${weatherContext || ""}

请只根据你当前已经拥有的长期上下文和一般判断，决定是否存在一个明确、低风险、值得主动联系用户的理由。

重要规则：

- 不要猜测用户现实状态。
- 不要因为用户没有回复而推断用户正在睡觉、刷手机、上课等。
- 不要重复普通细节。
- 高频话题不等于重要。
- 如果没有明确理由，必须输出 [NO_ACTION]。
- 不要写日记。
- 不要输出任何敏感内容。

只输出以下两种结果之一：

[NO_ACTION]

或者一条非常简短、自然、普通的主动消息。
`;

  const messages = [
    {
      role: "system",
      content: safePrompt
    },
    {
      role: "user",
      content:
        "请完成这次后台 Heartbeat 判断。"
    }
  ];

  try {
    return await callWakeModel(
      messages
    );
  } catch (error) {
    if (
      error?.code ===
      "PROHIBITED_CONTENT"
    ) {
      console.log(
        "🛡️ Gemini 安全降级请求仍被拦截，本轮静默。"
      );

      return {
        choices: [
          {
            message: {
              content:
                "[NO_ACTION]"
            }
          }
        ]
      };
    }

    throw error;
  }
}


// ========================
// 主唤醒
// ========================

async function runWakeUp() {
  console.log(
    "\n=========================="
  );

  console.log(
    "开始自动唤醒"
  );

  console.log(
    "==========================\n"
  );

  const messages =
    await loadTimelineMessages();

  if (!messages) {
    return;
  }

  const lastUserTime =
    getLastUserTime(
      messages
    );

  if (!lastUserTime) {
    console.log(
      "未找到用户时间"
    );

    return;
  }

  const now = new Date();

  const diffMinutes =
    Math.floor(
      (now -
        lastUserTime) /
        1000 /
        60
    );

  if (
    !shouldWake(
      lastUserTime
    )
  ) {
    console.log(
      "\n暂不需要唤醒\n"
    );

    return;
  }

  const recentPushLogs =
    await loadRecentHeartbeatPushLogs();

  const recentPushContext =
    formatRecentHeartbeatPushLogs(
      recentPushLogs
    );

  const weatherContext =
    await fetchWeatherContext();

  const wakePrompt =
    buildWakePrompt(
      getChinaTimeString(),
      diffMinutes,
      weatherContext
    );

  const cleanMessages =
    stripPosition(
      messages
    );

  const userDisplay =
    process.env.USER_DISPLAY_NAME ||
    "用户";

  const aiDisplay =
    process.env.AI_DISPLAY_NAME ||
    "AI";

  // ========================
  // 最近聊天
  // ========================

  const recentConversation =
    getRecentConversationMessages(
      cleanMessages
    );

  const historyText =
    formatConversationMessages(
      recentConversation,
      userDisplay,
      aiDisplay,
      WAKE_HISTORY_MAX_CHARS
    );

  // ========================
  // 最近变化
  // ========================

  const recentChangeMessages =
    getRecentChangeMessages(
      cleanMessages
    );

  const recentChangesText =
    formatRecentChanges(
      recentChangeMessages,
      userDisplay,
      aiDisplay
    );

  // ========================
  // Heartbeat 推送规则
  // ========================

  const heartbeatPushInstruction = `
## 最近主动推送记录

${recentPushContext}

---

这些记录只用于判断短期重复。

它们不是永久禁止列表。

如果过去推送过某个话题，但现在出现了真正的新变化，可以重新联系。

如果过去刚刚推送过相同内容，而最近没有任何新信息，则不要机械重复。

不要为了“看起来主动”而强行推送。

`;

  // ========================
  // Heartbeat 输入
  // ========================

  const wakeMessages = [
    {
      role: "system",
      content: [
        wakePrompt,
        heartbeatPushInstruction
      ]
        .filter(Boolean)
        .join("\n\n")
    },
    {
      role: "user",
      content: `以下内容是后台判断材料。

注意：这些不是用户正在发送的新消息。
用户当前没有主动给你发送消息。

## 最近聊天记录

${historyText || "暂无最近聊天记录。"}

## 最近短期变化候选

${recentChangesText}

## 最后判断要求

不要只统计最近出现最多的话题。

请比较最近消息之间的前后变化。

重点判断：
- 有没有新结果；
- 有没有计划变化；
- 有没有态度变化；
- 有没有新的未解决事项；
- 有没有原本普通的事情突然变得值得关注；
- 有没有一个独立成立的主动联系理由。

如果只是同一个细节被反复提到，但没有新的变化，请忽略它。

现在独立完成“是否主动联系”的判断。`
    }
  ];

  console.log(
    "\n===== WAKE MESSAGES SUMMARY =====\n"
  );

  console.log(
    JSON.stringify(
      summarizeWakeMessages(
        wakeMessages
      )
    )
  );

  if (
    !process.env.TARGET_API_URL ||
    !process.env.TARGET_API_KEY ||
    !process.env.MODEL_NAME
  ) {
    console.log(
      "缺少 TARGET_API_URL / TARGET_API_KEY / MODEL_NAME，跳过本次唤醒"
    );

    return;
  }

  let data;

  try {
    data =
      await callWakeModel(
        wakeMessages
      );

  } catch (error) {
    // Gemini PROHIBITED_CONTENT：
    // 不让整个 Heartbeat runtime 进入错误循环。
    if (
      error?.code ===
      "PROHIBITED_CONTENT"
    ) {
      if (
        !WAKE_SAFE_RETRY_ENABLED
      ) {
        console.log(
          "⚠️ Gemini PROHIBITED_CONTENT，安全降级已关闭，本轮静默。"
        );

        return;
      }

      data =
        await callSafeWakeRetry(
          getChinaTimeString(),
          diffMinutes,
          weatherContext
        );

    } else {
      throw error;
    }
  }

  const rawAiText =
    normalizeContentToText(
      data.choices?.[0]?.message?.content
    ).trim();

  console.log(
    "\nWake Result Summary:\n"
  );

  console.log(
    JSON.stringify({
      choices:
        Array.isArray(
          data.choices
        )
          ? data.choices.length
          : 0,

      ai_text_chars:
        rawAiText.length
    })
  );

  const diaryResult =
    extractDiaryFromResponse(
      rawAiText
    );

  // 日记与推送是独立逻辑。
  // [NO_ACTION] 并不会自动产生“只写日记”的事件。
  const diarySaved =
    appendDiaryEntry(
      diaryResult.diaryContent
    );

  const aiText =
    diaryResult.remainingText;

  let eventContent;

  if (!aiText) {
    console.log(
      "\nAI 未返回推送内容，本次不发送推送\n"
    );

    eventContent =
      diarySaved
        ? `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：存在可记录变化但没有主动联系价值）`
        : `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：模型未产生主动联系内容）`;

  } else if (
    /^\[NO_ACTION\]\s*(.{0,30})?/i.test(
      aiText
    )
  ) {
    const noActionMatch =
      aiText.match(
        /^\[NO_ACTION\]\s*(.{0,30})?/i
      );

    console.log(
      "\nAI 选择不发送推送\n"
    );

    let reason =
      (
        noActionMatch?.[1] ||
        ""
      ).trim();

    if (
      reason.startsWith(
        "原因："
      ) ||
      reason.startsWith(
        "原因:"
      )
    ) {
      reason =
        reason.replace(
          /^原因[：:]\s*/,
          ""
        ).trim();
    }

    eventContent =
      reason
        ? `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：${reason}）`
        : `（${getLocalTimeString()} 自动唤醒：本次未发送推送）`;

  } else {
    console.log(
      "\nAI 选择发送推送\n"
    );

    let barkText =
      aiText;

    const barkMatch =
      barkText.match(
        /\[BARK\]([\s\S]*?)\[\/BARK\]/i
      );

    if (barkMatch) {
      barkText =
        barkMatch[1].trim();
    } else {
      barkText =
        barkText
          .replace(
            /^\[BARK\]\s*/i,
            ""
          )
          .trim();

      barkText =
        barkText
          .replace(
            /\s*\[\/BARK\]\s*$/i,
            ""
          )
          .trim();
    }

    barkText =
      barkText
        .replace(
          /^标题[：:]\s*/gm,
          ""
        )
        .replace(
          /^正文[：:]\s*/gm,
          ""
        );

    const lines =
      barkText
        .split("\n")
        .filter(
          line =>
            line.trim() !== ""
        );

    let title;
    let body;

    if (
      lines.length === 0
    ) {
      console.log(
        "\n推送内容清洗后为空，本次不发送推送\n"
      );

      eventContent =
        `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：推送内容为空）`;

    } else if (
      lines.length === 1
    ) {
      title =
        "来自AI";

      body =
        lines[0].trim();

    } else if (
      lines.length === 2
    ) {
      title =
        lines[0].trim();

      body =
        lines[1].trim();

    } else {
      title =
        lines[0].trim();

      body =
        lines
          .slice(1)
          .map(
            l => l.trim()
          )
          .join(" ");
    }

    if (!eventContent) {
      const safeBody =
        body.length > 500
          ? body.substring(0, 497) +
            "..."
          : body;

      let safeTitle =
        title || "来自伴侣";

      if (
        /^\d/.test(
          safeTitle
        )
      ) {
        safeTitle =
          "来自伴侣｜" +
          safeTitle;
      }

      const isDuplicate =
        isRecentDuplicatePush(
          safeTitle,
          safeBody,
          recentPushLogs
        );

      if (isDuplicate) {
        console.log(
          "\n本次推送与近期推送过于相似，不发送 ntfy/Bark\n"
        );

        eventContent =
          `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：与近期推送高度重复）`;

      } else {
        const pushResult =
          await sendPushNotification({
            title:
              safeTitle,
            body:
              safeBody
          });

        if (!pushResult.ok) {
          console.log(
            `\n${pushResult.providerLabel} 推送失败，本次不发送推送\n`
          );

          eventContent =
            `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：${pushResult.providerLabel} 推送失败：${pushResult.reason}）`;

        } else {
          await saveHeartbeatPushLog(
            `${safeTitle}｜${safeBody}`,
            "heartbeat"
          );

          eventContent =
            `（${getLocalTimeString()} 刚刚给用户发了${pushResult.providerLabel}推送：${safeTitle}｜${safeBody}）`;
        }
      }
    }
  }

  // ========================
  // Gateway 记录 Heartbeat 事件
  // ========================

  try {
    const eventResponse =
      await fetch(
        GATEWAY_URL,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            content:
              eventContent
          })
        }
      );

    if (
      !eventResponse.ok
    ) {
      throw new Error(
        `Gateway 返回 HTTP ${eventResponse.status}`
      );
    }

    console.log(
      "\n已通过 Gateway 记录唤醒事件\n"
    );

  } catch (err) {
    console.error(
      "\n记录唤醒事件失败（Gateway 是否运行？）:\n",
      err.message
    );
  }
}


// ========================
// 定时检查
// ========================

function getCheckIntervalMs() {
  return (
    getCheckIntervalMinutes(
      new Date()
    ) *
    60 *
    1000
  );
}


async function scheduleNextCheck() {
  try {
    try {
      await fetch(
        HEARTBEAT_URL,
        {
          method: "POST"
        }
      );
    } catch {}

    await runWakeUp();

  } catch (err) {
    console.error(
      "唤醒检查出错:",
      err
    );
  }

  setTimeout(
    scheduleNextCheck,
    getCheckIntervalMs()
  );
}


// 启动第一次检查（延迟10秒）
setTimeout(
  scheduleNextCheck,
  10000
);


console.log(
  "\n=================================="
);

console.log(
  "Dylan Heartbeat Runtime 已启动（动态间隔）"
);

console.log(
  JSON.stringify({
    railway: Boolean(
      process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.RAILWAY_SERVICE_ID
    ),

    persistent_data: Boolean(
      process.env.DATA_DIR ||
      process.env.RAILWAY_VOLUME_MOUNT_PATH
    ),

    target_url_configured:
      Boolean(
        process.env.TARGET_API_URL
      ),

    target_key_configured:
      Boolean(
        process.env.TARGET_API_KEY
      ),

    model_configured:
      Boolean(
        process.env.MODEL_NAME
      ),

    push_provider_configured:
      Boolean(
        process.env.BARK_KEY ||
        process.env.NTFY_TOPIC
      ),

    safe_retry_enabled:
      WAKE_SAFE_RETRY_ENABLED,

    wake_history_limit:
      WAKE_HISTORY_MESSAGE_LIMIT,

    wake_change_limit:
      WAKE_CHANGE_MESSAGE_LIMIT,

    data_dir_ready:
      fs.existsSync(
        DATA_DIR
      )
  })
);

console.log(
  "==================================\n"
);
