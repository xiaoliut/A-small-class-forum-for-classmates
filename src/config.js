'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * 读取 .env 文件（不依赖 dotenv，保持零多余依赖）。
 * 已存在的真实环境变量优先，不会被文件覆盖。
 */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT_DIR, '.env'));

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const num = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT_DIR, 'data');

const config = {
  rootDir: ROOT_DIR,
  dataDir: DATA_DIR,
  dbFile: path.join(DATA_DIR, 'forum.db'),
  host: process.env.HOST || '127.0.0.1',
  port: num(process.env.PORT, 3000),
  siteName: process.env.SITE_NAME || '班级论坛',
  sessionSecret: process.env.SESSION_SECRET || 'class-forum-dev-secret-please-change',
  accessLog: bool(process.env.ACCESS_LOG, true),
  ai: {
    enabled: bool(process.env.AI_ENABLED, false),
    baseUrl: (process.env.AI_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || 'deepseek-chat',
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 8000),
    autoApprove: bool(process.env.AI_AUTO_APPROVE, true)
  }
};

module.exports = config;
