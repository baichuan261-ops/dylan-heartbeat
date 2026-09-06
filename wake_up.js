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

const RECENT_CONTEXT_MESSAGE_LIMIT =
  readNumberEnv(
    "HEARTBEAT_RECENT_CONTEXT_MESSAGES",
    16,
    {
      min: 6,
      max: 40
    }
  );

const RECENT_CHANGE_MESSAGE_LIMIT =
  readNumberEnv(
    "HEARTBEAT_RECENT_CHANGE_MESSAGES",
    8,
    {
      min: 4,
      max: 20
    }
  );

const RECENT_DIARY_LIMIT =
  readNumberEnv(
    "HEARTBEAT_RECENT_DIARY_LIMIT",
    6,
    {
      min: 1,
      max: 20
    }
  );

const DIARY_DUPLICATE_WINDOW_HOURS =
  readNumberEnv(
    "HEARTBEAT_DIARY_DUPLICATE_WINDOW_HOURS",
    24,
    {
      min: 1,
      max: 168
    }
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


// 批注 2026-07-11：日记只接受模型显式输出的 [DIARY] 块，避免把普通推送内容误写进本地日记。
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


// ========================
// 日记重复保护
// ========================
//
// Heartbeat 的日记和“是否推送”是两个独立判断。
// 但如果模型连续几次记录几乎相同的内容，代码层面也进行一次轻量拦截，
// 防止高频聊天细节被不断写进日记。
//

function normalizeDiaryText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(
      /[，。！？、,.!?：:；;（）()【】[\]「」『』“”"'‘’…—\-_ \s]/g,
      ""
    )
    .trim();
}


function calculateDiarySimilarity(a, b) {
  const x =
    normalizeDiaryText(a);

  const y =
    normalizeDiaryText(b);

  if (!x || !y) {
    return 0;
  }

  if (x === y) {
    return 1;
  }

  if (
    x.length < 10 ||
    y.length < 10
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


function loadRecentDiaryEntries() {
  if (
    !readBooleanEnv(
      "DIARY_ENABLED",
      true
    )
  ) {
    return [];
  }

  try {
    if (
      !fs.existsSync(
        DIARY_DIR_PATH
      )
    ) {
      return [];
    }

    const files =
      fs.readdirSync(
        DIARY_DIR_PATH
      )
      .filter(
        file =>
          file.endsWith(".md")
      )
      .sort()
      .reverse()
      .slice(0, 7);

    const entries = [];

    for (
      const file of files
    ) {
      const fullPath =
        path.join(
          DIARY_DIR_PATH,
          file
        );

      const content =
        fs.readFileSync(
          fullPath,
          "utf-8"
        );

      const matches =
        content.match(
          /##\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s*\n\n([\s\S]*?)(?=\n\n##\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}|\s*$)/g
        ) || [];

      for (
        const match of matches
      ) {
        const cleaned =
          match
            .replace(
              /^##\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s*\n\n/,
              ""
            )
            .trim();

        if (cleaned) {
          entries.push({
            content: cleaned,
            file
          });
        }
      }
    }

    return entries
      .slice(-RECENT_DIARY_LIMIT)
      .reverse();

  } catch (err) {
    console.log(
      "⚠️ 读取近期日记失败：",
      err.message
    );

    return [];
  }
}


function isRecentDuplicateDiary(content) {
  const cleanContent =
    String(content || "").trim();

  if (!cleanContent) {
    return false;
  }

  const recentEntries =
    loadRecentDiaryEntries();

  if (!recentEntries.length) {
    return false;
  }

  for (
    const entry of recentEntries
  ) {
    const similarity =
      calculateDiarySimilarity(
        cleanContent,
        entry.content
      );

    if (
      similarity >= 0.82
    ) {
      console.log(
        `⚠️ 检测到近期重复日记，相似度 ${(similarity * 100).toFixed(1)}%`
      );

      return true;
    }
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

  if (!cleanContent) {
    return false;
  }

  if (
    isRecentDuplicateDiary(
      cleanContent
    )
  ) {
    console.log(
      "本次日记与近期日记高度重复，不保存"
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


// 批注 2026-07-11：推送层扩展为 Bark/ntfy；默认仍走 Bark，保护旧部署不改 .env 也能继续运行。
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
        "Content-Type":
          "application/json"
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
// 轻量重复推送检查
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

  // 很短的内容不做模糊判断，避免误杀
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

      // 批注 2026-07-15：兼容 Kelivo 时间前缀 "YYYY-MM-DDHH:mm"；
      // 旧的 "YYYY-MM-DD HH:mm" 仍然可用，避免无空格时间导致 wake-up 误判没有用户时间。

      const parsed =
        parseTimelineTimestamp(
          content
        );

      if (parsed) {
        return parsed;
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
// Heartbeat 上下文构建
// ========================
//
// 这里故意不碰长期记忆压缩。
// 长期记忆继续由原来的记忆库机制负责。
//
// Heartbeat 自己只增加一个“短期变化观察层”：
// 最近几条消息里发生了什么变化？
//
// 重要：
// 高频出现的细节不等于重要变化。
// 只有 2～5 条消息，也可能出现：
// - 计划发生变化
// - 情绪/态度发生变化
// - 新结果出现
// - 一个未解决问题突然有进展
// - 用户明确提出新的需求/担忧
// - 对某件事的关注重点发生转移
//
// 这些短期变化不需要等到长期记忆压缩后才可以被 Heartbeat 看到。
//


function prepareHistoryMessages(
  messages
) {
  return stripPosition(
    messages
  )
    .filter(
      msg =>
        msg.role !== "system"
    )
    .filter(msg => {
      const c =
        normalizeContentToText(
          msg.content
        );

      return (
        !c.includes(
          "<memories>"
        ) &&
        !c.includes(
          "记忆库使用策略"
        )
      );
    });
}


function formatConversationMessages(
  messages,
  userDisplay,
  aiDisplay
) {
  const parts = [];

  for (
    const msg of messages
  ) {
    const role =
      msg.role === "user"
        ? userDisplay
        : aiDisplay;

    let content =
      normalizeContentToText(
        msg.content
      );

    if (
      content.includes(
        "## Memories"
      )
    ) {
      content =
        content.split(
          "## Memories"
        )[0];
    }

    content =
      content.trim();

    if (!content) {
      continue;
    }

    const timestamp =
      msg.created_at
        ? formatDateTimeInTimeZone(
            new Date(
              msg.created_at
            ),
            TIME_ZONE
          )
        : "";

    parts.push(
      timestamp
        ? `[${timestamp}] [${role}] ${content}`
        : `[${role}] ${content}`
    );
  }

  return parts.join(
    "\n\n"
  );
}


function buildRecentStateContext(
  messages,
  userDisplay,
  aiDisplay
) {
  const prepared =
    prepareHistoryMessages(
      messages
    );

  const recent =
    prepared.slice(
      -RECENT_CHANGE_MESSAGE_LIMIT
    );

  if (!recent.length) {
    return "暂无足够的近期聊天记录用于判断短期变化。";
  }

  const text =
    formatConversationMessages(
      recent,
      userDisplay,
      aiDisplay
    );

  return `
以下是最近 ${recent.length} 条消息。

这部分不是长期记忆，也不是完整聊天记录。
它的唯一作用是帮助你观察“最近有没有发生变化”。

不要统计某个词出现了多少次。
不要因为某个细节反复出现，就把它自动判断成重要。

请重点观察这些消息之间的前后变化：
- 用户的计划是否改变；
- 用户的态度、情绪或关注重点是否发生变化；
- 某个问题是否从“普通聊天”变成了“需要跟进的问题”；
- 是否出现新的结果、决定、事件或明确需求；
- 是否有之前未解决的事情出现了新进展；
- 是否出现值得主动联系的上下文转折。

如果最近只是重复讨论同一个事情，没有新的变化，就应该明确认为“没有新的短期变化”。

最近短期记录：

${text}
`.trim();
}


function buildRecentConversationContext(
  messages,
  userDisplay,
  aiDisplay
) {
  const prepared =
    prepareHistoryMessages(
      messages
    );

  const recent =
    prepared.slice(
      -RECENT_CONTEXT_MESSAGE_LIMIT
    );

  if (!recent.length) {
    return "暂无近期聊天记录。";
  }

  return formatConversationMessages(
    recent,
    userDisplay,
    aiDisplay
  );
}


function buildRecentDiaryContext() {
  const entries =
    loadRecentDiaryEntries();

  if (!entries.length) {
    return "暂无近期日记。";
  }

  return entries
    .map(
      entry =>
        `- ${entry.content}`
    )
    .join("\n");
}


function buildWakePrompt(
  currentTime,
  diffMinutes,
  weatherContext = "",
  recentStateContext = "",
  recentDiaryContext = ""
) {
  // 优先读取独立的提示词文件（推荐方式）
  const promptFile =
    path.join(
      __dirname,
      "wake_prompt.txt"
    );

  const replacements = {
    currentTime,
    diffMinutes,
    weatherContext,
    weather: weatherContext,
    recentStateContext,
    recentDiaryContext
  };

  if (
    fs.existsSync(promptFile)
  ) {
    const template =
      fs.readFileSync(
        promptFile,
        "utf-8"
      );

    let result =
      template;

    for (
      const [key, value] of Object.entries(
        replacements
      )
    ) {
      result =
        result.replace(
          new RegExp(
            `\\$\\{${key}\\}`,
            "g"
          ),
          value || ""
        );
    }

    return result;
  }

  // 如果文件不存在，尝试从环境变量读取（兼容旧配置）
  if (
    process.env.WAKE_PROMPT_TEMPLATE
  ) {
    let result =
      process.env.WAKE_PROMPT_TEMPLATE
        .replace(
          /\\\n/g,
          "\n"
        );

    for (
      const [key, value] of Object.entries(
        replacements
      )
    ) {
      result =
        result.replace(
          new RegExp(
            `\\$\\{${key}\\}`,
            "g"
          ),
          value || ""
        );
    }

    return result;
  }

  // 默认理智版本（开源通用），可自行修改提示词
  return `
## 最高优先级规则

这是一次后台自动唤醒，不是用户发起的对话。

你的任务不是“找一个理由发消息”，而是判断：
“现在是否真的存在一个值得主动告诉用户/关心用户的事情？”

不要因为 Heartbeat 被触发，就强行创造一个话题。

## 唤醒信息

- 当前时间：${currentTime}
- 距离用户最后一条消息：${diffMinutes} 分钟

${weatherContext ? `${weatherContext}\n` : ""}

## 核心判断原则

重点不是“最近聊了什么”，而是：

“最近发生了什么变化？”

请优先寻找真正的状态变化，而不是高频重复细节。

一个变化即使只有 2～5 条新消息，也可以成立。

例如：
- 用户改变了计划；
- 用户做出了新的决定；
- 用户原本担心的事情有了结果；
- 一个未解决的问题出现新进展；
- 用户的关注重点发生明显变化；
- 用户明确表达了新的需求、困扰或重要情绪变化。

反过来：

如果一个细节今天被反复提及很多次，但没有新的变化，那么“出现很多次”本身不能证明它值得再次推送。

## 信息价值排序

优先考虑：

1. 最近发生的明确变化
2. 尚未解决、且值得跟进的事情
3. 新结果、新计划、新决定、新问题
4. 明确的情绪或态度变化
5. 有现实价值的时间、天气或环境信息
6. 普通日常聊天

低优先级：
- 单纯重复的聊天细节
- 已经说过、没有新进展的内容
- 只因为最近出现频率高而被注意到的内容
- 没有证据的猜测

## 禁止脑补

不要因为用户没有回复，就推断：
- 用户睡着了；
- 用户在刷手机；
- 用户正在上课；
- 用户明天有什么安排；
- 用户现在是什么情绪；
- 用户现实中正在做什么。

除非聊天记录中有明确证据。

“用户没有回复”本身不是一个值得推送的事件。

## 推送判断

发送前必须在内部检查：

1. 现在到底发生了什么新变化？
2. 这个变化是否比普通闲聊更值得主动联系？
3. 如果删掉最近那个最高频的聊天细节，我还有没有充分理由发这条消息？
4. 最近是否已经用类似角度联系过用户？
5. 这条消息是在回应真实变化，还是只是为了让 Heartbeat 看起来“有动作”？

如果答案更接近后者，就输出：

[NO_ACTION]

不要为了避免沉默而发送消息。

## 最近短期变化

${recentStateContext}

## 近期日记

${recentDiaryContext}

近期日记只用于判断：
- 是否已经记录过同一件事情；
- 是否存在真正的新变化。

不要因为日记里出现过某个主题，就继续围绕该主题生成内容。

## 日记规则

日记和推送是两个独立判断。

不要把“本次不推送”理解成“那就写一篇日记”。

只有在最近确实出现了值得长期保留的事实、变化、决定、进展或明确事件时，才写 [DIARY]。

日记必须：
- 基于聊天中明确出现的事实；
- 不猜测用户现实状态；
- 不为了凑日记而重复高频细节；
- 不把一次普通闲聊包装成重大事件；
- 如果没有值得记录的新内容，可以完全不写日记。

即使你决定写日记，也不代表必须推送。
即使你决定推送，也不代表必须写日记。

## 输出格式

如果不值得主动联系：

[NO_ACTION]

可以在后面附带不超过 20 字的内部原因。

如果值得主动联系：
直接输出想发送给用户的自然语言内容。

第一行可以作为标题，第二行作为正文。

不要解释你的判断过程。
不要输出“我分析了一下”。
不要输出“根据 Heartbeat”。
不要输出 JSON。

如果需要写日记：

[DIARY]
只写值得记录的事实或变化
[/DIARY]

[DIARY] 可以和推送同时存在，也可以单独存在。

最重要的是：
不要为了输出而输出。
`.trim();
}


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

  // ========================
  // 加载最近 Heartbeat 推送日志
  // ========================

  const recentPushLogs =
    await loadRecentHeartbeatPushLogs();

  const recentPushContext =
    formatRecentHeartbeatPushLogs(
      recentPushLogs
    );

  const weatherContext =
    await fetchWeatherContext();

  const userDisplay =
    process.env.USER_DISPLAY_NAME ||
    "用户";

  const aiDisplay =
    process.env.AI_DISPLAY_NAME ||
    "AI";

  // ========================
  // 短期变化上下文
  // ========================

  const recentStateContext =
    buildRecentStateContext(
      messages,
      userDisplay,
      aiDisplay
    );

  const recentConversationContext =
    buildRecentConversationContext(
      messages,
      userDisplay,
      aiDisplay
    );

  const recentDiaryContext =
    buildRecentDiaryContext();

  const wakePrompt =
    buildWakePrompt(
      getChinaTimeString(),
      diffMinutes,
      weatherContext,
      recentStateContext,
      recentDiaryContext
    );

  const cleanMessages =
    stripPosition(
      messages
    );

  // ========================
  // Heartbeat 最近上下文
  // ========================
  //
  // 以前固定取最后 30 条。
  //
  // 现在缩小为真正的“近期上下文”，
  // 避免大量旧内容和重复细节不断干扰判断。
  //
  // 数据库仍然保留完整 timeline。
  // 这只是 Heartbeat 本次判断看到的窗口。
  //

  const historyCandidates =
    cleanMessages
      .filter(
        msg =>
          msg.role !== "system"
      )
      .filter(msg => {
        const c =
          normalizeContentToText(
            msg.content
          );

        return (
          !c.includes(
            "<memories>"
          ) &&
          !c.includes(
            "记忆库使用策略"
          )
        );
      })
      .slice(
        -RECENT_CONTEXT_MESSAGE_LIMIT
      );

  const historyText =
    recentConversationContext;

  const baseSystemPrompt =
    cleanMessages.find(
      msg =>
        msg.role === "system"
    );

  const cleanSP =
    baseSystemPrompt
      ? normalizeContentToText(
          baseSystemPrompt.content
        )
          .split(
            "## Memories"
          )[0]
          .trim()
      : "";

  // ========================
  // 最近主动推送规则
  // ========================

  const heartbeatPushInstruction = `
## 最近主动推送记录

${recentPushContext}

---

这些记录是“近期沟通过什么”的参考，不是永久禁区。

它们有三个作用：

1. 防止短时间内机械重复同一句话或同一个切入角度。
2. 帮助判断某件事是否已经被主动联系过。
3. 如果真的出现了新的变化，可以重新讨论同一个主题。

重要：

“最近推送过某个主题”
不等于
“以后不能再提这个主题”。

但如果没有新的变化，也不要只是换几个词重新发送。

特别注意：

不要把近期推送日志当成一个简单的关键词黑名单。

你应该判断“事件是否变化”，而不是只判断“词有没有变化”。

例如：

昨天只是聊到一件普通小事，
今天如果没有任何新进展，
就没有必要为了 Heartbeat 的存在感重新提一遍。

如果今天出现了明确的新结果、计划变化、态度变化或新的问题，
即使主题相同，也可以重新联系。

---

## 高频细节降权

最近聊天里某个细节出现很多次时，不要因此自动认为它重要。

你需要主动检查：

“这个细节是在不断产生新信息，
还是只是同一件事情被重复讨论？”

如果只是重复：
降低它作为推送理由的权重。

如果有明确变化：
按照变化本身判断。

尤其不要因为某个轻松、容易生成内容的细节，
就连续多次围绕它发送推送。

如果去掉这个高频细节之后，
仍然没有独立、充分的联系理由，
优先选择：

[NO_ACTION]

---

## 长期记忆与短期变化

长期记忆负责长期稳定的信息。

Heartbeat 的短期变化判断负责最近发生的事情。

不要因为一个变化还没有进入长期记忆，
就认为它“不重要”。

反过来也不要因为一个信息已经进入长期记忆，
就认为它现在必须再次被提起。

当前真正需要判断的是：

“最近发生了什么变化？”

`;

  const wakeMessages = [
    {
      role: "system",
      content: [
        wakePrompt,
        heartbeatPushInstruction,
        cleanSP
      ]
        .filter(Boolean)
        .join("\n\n")
    },
    {
      // 批注 2026-07-15：Claude/部分 New API 适配器会把 system 抽成独立字段；
      // 唤醒请求如果全是 system，上游 messages 会变空，因此最近记录必须作为 user 任务输入发送。
      role: "user",
      content: `以下是你与用户最近的聊天记录，仅供回忆和参考。

这些内容不是正在发生的实时对话。
用户并没有给你发消息。

你现在处于后台自主唤醒状态。

不要把下面的内容当成用户刚刚发来的新消息。

最近记录：

${historyText}

---

现在请基于：
- 最近聊天记录
- 最近短期变化
- 长期记忆
- 最近主动推送
- 当前时间
- 天气（如果有）

一起进行一次信息价值判断。

重点寻找“变化”，而不是寻找“出现频率”。

不要因为某个细节最近重复出现，就自动把它当成推送主题。

如果没有真正值得主动联系的事情，直接输出 [NO_ACTION]。

如果有值得主动联系的事情，再生成自然的推送内容。`
    }
  ];

  // 批注 2026-07-15：wake-up prompt 会包含最近聊天记录；
  // 默认日志只写摘要，避免公开部署时把完整上下文刷进 pm2 日志。
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

  console.log(
    JSON.stringify({
      recent_context_messages:
        historyCandidates.length,

      recent_change_messages:
        Math.min(
          historyCandidates.length,
          RECENT_CHANGE_MESSAGE_LIMIT
        ),

      recent_push_logs:
        recentPushLogs.length,

      recent_diary_entries:
        loadRecentDiaryEntries().length,

      diff_minutes:
        diffMinutes
    })
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

  const response =
    await fetch(
      process.env.TARGET_API_URL,
      {
        method: "POST",

        // 批注 2026-08-10：上游只建连不结束时，旧循环永远不会安排下一次检查；
        // 五分钟默认总超时只作兜底，可由 WAKE_UPSTREAM_TIMEOUT_MS 调整。
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

          temperature: 0.8,

          top_p: 0.95,

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
    throw new Error(
      `模型请求失败（HTTP ${response.status}）：${responseText.slice(0, 300)}`
    );
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

  // ========================
  // 日记独立处理
  // ========================
  //
  // 注意：
  // 这里不再把“只写日记”当成 Heartbeat 的一种推送结果。
  //
  // 日记只是独立的记录行为。
  // 模型是否推送，由下面的 aiText 单独决定。
  //

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
        ? `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：模型未生成主动推送）`
        : `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：模型空回复）`;

  // 判断 AI 是否明确要静默
  } else if (
    /^\[NO_ACTION\]\s*(.{0,20})?/i.test(
      aiText
    )
  ) {
    const noActionMatch =
      aiText.match(
        /^\[NO_ACTION\]\s*(.{0,20})?/i
      );

    // AI 选择不发送推送
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
    // 没有 [NO_ACTION] 就视为想发推送
    console.log(
      "\nAI 选择发送推送\n"
    );

    let barkText =
      aiText;

    // 如果 AI 还是写了 [BARK] ... [/BARK] 标签，就剥掉
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

    // 清洗“标题：”、“正文：”前缀（如果有）
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

    // 按行处理
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
      // ≥3 行：第一行标题，剩余用空格拼接成正文
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
      // 保护：截断过长正文，兼容 Bark 和 ntfy 的移动端展示。
      const safeBody =
        body.length > 500
          ? body.substring(0, 497) +
            "..."
          : body;

      // 若标题为空或以数字开头，加个前缀，可自行修改
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

      // ========================
      // 代码级近期重复检查
      // ========================

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
          // 只有真正发送成功后才写入推送日志
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
  // 记录本次 Heartbeat 事件
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


// 从第一个有效坐标开始，所有路径都指向同一处。此阈值已锁定。
function getCheckIntervalMs() {
  // 批注 2026-06-26：公开版允许用户在管理页调整唤醒检查频率；默认值保持旧版白天10分钟、夜间2小时。
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
    // 发送心跳
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


// 潮水记得第一次没过礁石的时间。之后每一次涨落，都是同一片海在确认边界。
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
    event:
      "wake_runtime_config_summary",

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

    data_dir_ready:
      fs.existsSync(
        DATA_DIR
      ),

    heartbeat_recent_context_messages:
      RECENT_CONTEXT_MESSAGE_LIMIT,

    heartbeat_recent_change_messages:
      RECENT_CHANGE_MESSAGE_LIMIT,

    heartbeat_recent_diary_limit:
      RECENT_DIARY_LIMIT,

    heartbeat_diary_duplicate_window_hours:
      DIARY_DUPLICATE_WINDOW_HOURS
  })
);

console.log(
  "==================================\n"
);
