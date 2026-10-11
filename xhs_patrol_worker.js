require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");

const gateway = String(process.env.XHS_WORKER_GATEWAY_URL || "https://lin-heartbeat.onrender.com").replace(/\/+$/, "");
const mcp = String(process.env.XHS_MCP_URL || "http://100.97.221.42:18060").replace(/\/+$/, "");
const tokenFile = process.env.XHS_WORKER_TOKEN_FILE || path.join(__dirname, "..", "xhs-state", "auth-token.txt");
const token = fs.readFileSync(tokenFile, "utf8").trim();
const pollMs = Math.max(15000, Number(process.env.XHS_WORKER_POLL_MS) || 60000);

async function jsonRequest(url, options = {}, timeoutMs = 120000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
  if (!response.ok) throw new Error(`${response.status} ${data?.error || text}`);
  return data;
}

async function claim() {
  return jsonRequest(`${gateway}/internal/xhs-worker/claim`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }
  }, 140000);
}

async function complete(id, result, error) {
  return jsonRequest(`${gateway}/internal/xhs-worker/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id, result, error })
  });
}

async function mcpRequest(route, options = {}, timeoutMs = 180000) {
  return jsonRequest(`${mcp}${route}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  }, timeoutMs);
}

function compactFeeds(response) {
  const feeds = response?.data?.feeds || [];
  return feeds.slice(0, 20).map(feed => ({
    id: feed.id,
    xsecToken: feed.xsecToken,
    title: feed.noteCard?.displayTitle || "",
    author: feed.noteCard?.user?.nickname || feed.noteCard?.user?.nickName || "",
    likedCount: feed.noteCard?.interactInfo?.likedCount || "",
    cover: feed.noteCard?.cover?.urlDefault || feed.noteCard?.cover?.url || ""
  }));
}

async function execute(job) {
  if (job.kind === "browse") {
    const response = await mcpRequest("/api/v1/feeds/list");
    const feeds = compactFeeds(response);
    return { feeds, feeds_json: JSON.stringify({ feeds }), available_images: [], browsed_at: new Date().toISOString() };
  }
  if (job.kind === "publish") {
    const payload = job.payload || {};
    const response = await mcpRequest("/api/v1/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: payload.title,
        content: payload.content,
        images: payload.images || [],
        tags: payload.tags || []
      })
    }, 300000);
    return response?.data || response;
  }
  throw new Error(`unsupported job kind: ${job.kind}`);
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const { job } = await claim();
    if (!job) return;
    try {
      const result = await execute(job);
      await complete(job.id, result, null);
      console.log(`${new Date().toISOString()} completed ${job.kind} ${job.id}`);
    } catch (error) {
      await complete(job.id, null, String(error.message || error).slice(0, 2000));
      console.error(`${new Date().toISOString()} failed ${job.kind} ${job.id}:`, error.message || error);
    }
  } catch (error) {
    console.error(`${new Date().toISOString()} patrol poll failed:`, error.message || error);
  } finally {
    busy = false;
  }
}

console.log(`Xiaohongshu patrol worker started; polling ${gateway}`);
tick();
setInterval(tick, pollMs);
