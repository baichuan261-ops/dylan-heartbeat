const fs = require("fs");
const path = require("path");

const PROJECT_DIR = __dirname;

// 批注 2026-08-10：Railway 重部署会清空镜像内文件，因此运行数据可统一迁入 Volume；
// 未配置持久化目录时仍沿用项目根目录，避免改变已有本机/VPS 部署的文件位置。
function resolveDataDir(env = process.env) {
  // 优先使用环境变量，如果都没设，就用 /tmp/dylan（Render 免费环境有权限）
  const configured = String(env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || "/tmp/dylan").trim();
  if (!configured) return "/tmp/dylan";
  return path.isAbsolute(configured) ? configured : path.join(PROJECT_DIR, configured);
}

function ensureDataDir(env = process.env) {
  const dataDir = resolveDataDir(env);
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function runtimeFile(name, env = process.env) {
  return path.join(resolveDataDir(env), name);
}

function runtimeDirectory(configured, fallback, env = process.env) {
  const value = String(configured || fallback).trim() || fallback;
  return path.isAbsolute(value) ? value : path.join(resolveDataDir(env), value);
}

function writeJsonAtomicSync(filePath, value) {
  // 批注 2026-08-10：时间线和设置写入时先落临时文件并保留上一版，避免进程中断留下半截 JSON。
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const backup = `${filePath}.bak`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  try {
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, backup);
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

module.exports = {
  PROJECT_DIR,
  ensureDataDir,
  resolveDataDir,
  runtimeDirectory,
  runtimeFile,
  writeJsonAtomicSync
};
