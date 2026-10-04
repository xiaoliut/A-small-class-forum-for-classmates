'use strict';

/**
 * 数据库初始化：建表 + 种子数据。
 * 幂等：可以重复执行；加 --force 会先删除旧库文件（重建）。
 */

const fs = require('fs');
const bcrypt = require('bcryptjs');
const config = require('./config');
const settings = require('./settings');
const db = require('./db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  nickname      TEXT    NOT NULL,
  real_name     TEXT    NOT NULL,
  school        TEXT    NOT NULL,
  class_name    TEXT    NOT NULL,
  student_no    TEXT,
  email         TEXT,
  phone         TEXT,
  avatar        TEXT,
  apply_reason  TEXT,
  role          TEXT    NOT NULL DEFAULT 'student',
  status        TEXT    NOT NULL DEFAULT 'pending',
  mute_until    TEXT,
  ban_reason    TEXT,
  reviewed_by   INTEGER,
  reviewed_at   TEXT,
  created_at    TEXT    NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS posts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section           TEXT    NOT NULL DEFAULT 'general',
  title             TEXT    NOT NULL,
  content           TEXT    NOT NULL,
  images            TEXT,
  cover             TEXT,
  status            TEXT    NOT NULL DEFAULT 'pending',
  pinned            INTEGER NOT NULL DEFAULT 0,
  is_notice         INTEGER NOT NULL DEFAULT 0,
  ai_verdict        TEXT    NOT NULL DEFAULT 'unchecked',
  ai_risk           INTEGER NOT NULL DEFAULT 0,
  ai_labels         TEXT,
  ai_summary        TEXT,
  ai_source         TEXT,
  reviewed_by       INTEGER,
  reviewed_at       TEXT,
  reject_reason     TEXT,
  warning_reason    TEXT,
  warning_at        TEXT,
  admin_edited      INTEGER NOT NULL DEFAULT 0,
  edited_at         TEXT,
  author_class      TEXT,
  prev_post_id      INTEGER,
  next_post_id      INTEGER,
  view_count        INTEGER NOT NULL DEFAULT 0,
  comment_count     INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT    NOT NULL,
  images     TEXT,
  status     TEXT    NOT NULL DEFAULT 'visible',
  ai_verdict TEXT    NOT NULL DEFAULT 'unchecked',
  ai_risk    INTEGER NOT NULL DEFAULT 0,
  ai_labels  TEXT,
  ai_summary TEXT,
  ai_source  TEXT,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT    NOT NULL,
  target_id   INTEGER NOT NULL,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT    NOT NULL,
  detail      TEXT,
  status      TEXT    NOT NULL DEFAULT 'open',
  handled_by  INTEGER,
  handled_at  TEXT,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS rename_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_name    TEXT    NOT NULL,
  new_name    TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending',
  reviewed_by INTEGER,
  reviewed_at TEXT,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_id  INTEGER,
  reason        TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending',
  cooling_until TEXT,
  reviewed_by   INTEGER,
  reviewed_at   TEXT,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS moderation_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id    INTEGER,
  admin_name  TEXT,
  action      TEXT    NOT NULL,
  target_type TEXT,
  target_id   INTEGER,
  detail      TEXT,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_status_created ON posts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_user          ON posts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_post       ON comments(post_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_users_status        ON users(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_created        ON moderation_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_status      ON reports(status, created_at DESC);
`;

function nowIso() {
  return new Date().toISOString();
}

function daysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function migrate() {
  db.exec(SCHEMA);
  // 轻量向前兼容：老库缺列时补上（忽略"已存在"错误）
  const addColumn = (table, definition) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition};`);
    } catch (_) {
      /* 列已存在 */
    }
  };
  addColumn('users', 'apply_reason TEXT');
  addColumn('users', 'email TEXT');
  addColumn('users', 'phone TEXT');
  addColumn('users', 'avatar TEXT');
  addColumn('posts', 'admin_edited INTEGER NOT NULL DEFAULT 0');
  addColumn('posts', 'warning_reason TEXT');
  addColumn('posts', 'warning_at TEXT');
  addColumn('posts', 'images TEXT');
  addColumn('posts', 'cover TEXT');
  addColumn('comments', 'status TEXT NOT NULL DEFAULT \'visible\'');
  addColumn('comments', 'images TEXT');
}

function seed() {
  const adminCount = db.get("SELECT COUNT(*) AS c FROM users WHERE role IN ('admin','superadmin')").c;
  if (adminCount > 0) {
    return { seeded: false, adminPassword: null };
  }

  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = (plain) => bcrypt.hashSync(plain, 10);
  const now = nowIso();

  const insertUser = db.db.prepare(`
    INSERT INTO users (username, password_hash, nickname, real_name, school, class_name,
                       student_no, apply_reason, role, status, reviewed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // 超级管理员：能改网站所有内容（默认只建这一个账号，管理员/同学由超管在后台添加）
  insertUser.run('admin', hash(adminPassword), '超级管理员', '超级管理员', 'XX中学', 'XX班',
    null, '超级管理员', 'superadmin', 'approved', now, now);


  return { seeded: true, adminPassword };
}

function afterSeedFixup() {
  // 同步评论数，保证与真实数据一致
  db.exec(`
    UPDATE posts SET comment_count = (
      SELECT COUNT(*) FROM comments c WHERE c.post_id = posts.id AND c.status = 'visible'
    );
  `);
}

/**
 * 把 config/site.jsonc 里的站点设置作为初始值写进 settings 表。
 * 只在表里没有该键时写入，之后以数据库（后台保存）为准。
 */
function seedSiteSettings() {
  const existing = db.get("SELECT value FROM settings WHERE key = 'site'");
  if (existing) return false;
  const site = settings.getSite();
  db.run(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
    'site', JSON.stringify(site), new Date().toISOString()
  );
  return true;
}

function init({ force = false } = {}) {
  if (force) {
    // 删除数据库文件前先断开已有连接，否则 Windows 上会因文件被占用而失败
    db.close();
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const file = `${config.dbFile}${suffix}`;
      if (!fs.existsSync(file)) continue;
      try {
        fs.rmSync(file, { maxRetries: 5, retryDelay: 100 });
      } catch (err) {
        console.warn(`[init-db] 无法删除 ${file}：${err.code || err.message}`);
      }
    }
  }
  migrate();
  const result = seed();
  seedSiteSettings();
  afterSeedFixup();
  return result;
}

module.exports = { init, migrate, seed, seedSiteSettings, nowIso };

if (require.main === module) {
  const force = process.argv.includes('--force');
  const result = init({ force });
  console.log(`✅ 数据库已就绪：${config.dbFile}（驱动：${db.getDriverName()}）`);
  if (result.seeded) {
    console.log('👤 超级管理员：admin / ' + result.adminPassword);
    console.log('ℹ️  管理员和同学账号请用超级管理员登录后，在后台「用户管理」里添加。');
  } else {
    console.log('ℹ️  已存在管理员账号，跳过种子数据。');
  }
  db.close();
}
