'use strict';

/**
 * SQLite 数据库封装。
 * 优先使用 Node 22.5+ 内置的 node:sqlite（零原生编译）；
 * 如果运行环境是老版本 Node，则自动回退到 better-sqlite3。
 * 两种驱动的 API 差异在这一层被抹平，上层只看到 prepare/run/get/all/exec。
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

let driverName = 'unknown';
let raw = null;
let lastInsertIdImpl = null;

function toNumber(value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function createDriver() {
  const preference = (process.env.DB_DRIVER || 'auto').toLowerCase();

  // 1) 优先尝试内置 node:sqlite（Node 22.5+，零原生编译）
  if (preference === 'auto' || preference === 'node') {
    try {
      // eslint-disable-next-line global-require
      const sqlite = require('node:sqlite');
      const db = new sqlite.DatabaseSync(config.dbFile);
      driverName = 'node:sqlite';
      lastInsertIdImpl = (info) => toNumber(info.lastInsertRowid);
      return wrap(db);
    } catch (err) {
      console.warn(`[db] node:sqlite 不可用（${err.message}），回退 better-sqlite3`);
    }
  }

  // 2) 回退 better-sqlite3
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3');
  const db = new Database(config.dbFile);
  driverName = 'better-sqlite3';
  lastInsertIdImpl = (info) => toNumber(info.lastInsertRowid);
  return wrap(db);
}

function wrap(db) {
  return {
    raw: db,
    exec(sql) {
      return db.exec(sql);
    },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run(...params) {
          const info = stmt.run(...params);
          return {
            changes: toNumber(info.changes),
            lastInsertRowid: lastInsertIdImpl(info)
          };
        },
        get(...params) {
          return paramSafe(stmt.get(...params));
        },
        all(...params) {
          return paramSafe(stmt.all(...params)) || [];
        }
      };
    },
    close() {
      return db.close();
    }
  };
}

/** 把 row 里的 BigInt 字段转成 Number，方便 JSON 序列化与 EJS 渲染 */
function paramSafe(row) {
  if (row == null) return row;
  if (Array.isArray(row)) return row.map(paramSafe);
  if (typeof row !== 'object') return toNumber(row);
  const out = {};
  for (const [key, value] of Object.entries(row)) out[key] = toNumber(value);
  return out;
}

function ensureDataDir() {
  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }
}

/** 获取（惰性初始化）数据库连接 */
function getDb() {
  if (raw) return raw;
  ensureDataDir();
  raw = createDriver();
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('PRAGMA busy_timeout = 5000;');
  return raw;
}

function getDriverName() {
  return driverName;
}

/** 便捷查询封装 */
const db = {
  get db() {
    return getDb();
  },
  run(sql, ...params) {
    return getDb().prepare(sql).run(...params);
  },
  get(sql, ...params) {
    return getDb().prepare(sql).get(...params);
  },
  all(sql, ...params) {
    return getDb().prepare(sql).all(...params);
  },
  exec(sql) {
    return getDb().exec(sql);
  },
  transaction(fn) {
    return (...args) => {
      const conn = getDb();
      conn.exec('BEGIN');
      try {
        const result = fn(...args);
        conn.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          conn.exec('ROLLBACK');
        } catch (_) {
          /* ignore */
        }
        throw err;
      }
    };
  },
  close() {
    if (raw) {
      raw.close();
      raw = null;
    }
  },
  getDriverName,
  get file() {
    return config.dbFile;
  }
};

module.exports = db;
