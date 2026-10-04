'use strict';

/**
 * 班级论坛 —— 应用入口
 * 技术栈：Node.js + Express + SQLite + EJS
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

const config = require('./src/config');
const db = require('./src/db');
const initDb = require('./src/init-db');
const settings = require('./src/settings');
const { attachUser } = require('./src/middleware/auth');
const { flashMiddleware, csrfMiddleware, csrfToken } = require('./src/middleware/common');
const viewHelpers = require('./src/utils/view-helpers');

// ---------------------------------------------------------------------------
// 1. 数据库准备
// ---------------------------------------------------------------------------
settings.ensureConfigDir();
const seedResult = initDb.init();

// ---------------------------------------------------------------------------
// 2. 会话存储（放在 SQLite 里，重启不丢登录态，生产环境不用 MemoryStore）
// ---------------------------------------------------------------------------
class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    // 每小时清理一次过期会话
    this.timer = setInterval(() => this.cleanup(), 60 * 60 * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  get(sid, callback) {
    try {
      const row = db.get('SELECT data, expires_at FROM sessions WHERE sid = ?', sid);
      if (!row) return callback(null, null);
      if (row.expires_at < Date.now()) {
        db.run('DELETE FROM sessions WHERE sid = ?', sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.data));
    } catch (err) {
      return callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      const expiresAt = sess?.cookie?.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 7 * 24 * 60 * 60 * 1000;
      db.run(
        `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
        sid, JSON.stringify(sess), expiresAt
      );
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      db.run('DELETE FROM sessions WHERE sid = ?', sid);
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }

  touch(sid, sess, callback) {
    return this.set(sid, sess, callback);
  }

  cleanup() {
    try {
      db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    } catch (_) {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Express 初始化
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', false);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(express.json({ limit: '256kb' }));
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
// 用户头像目录（运行时生成，存 data/avatars/）
app.use('/avatars', express.static(path.join(config.dataDir, 'avatars'), { maxAge: '7d' }));
// 帖子/评论图片目录（存 data/uploads/）
app.use('/uploads', express.static(path.join(config.dataDir, 'uploads'), { maxAge: '7d' }));

// 安全响应头（Lighthouse 最佳做法 / 信任与安全）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
  );
  if (req.secure || req.get('X-Forwarded-Proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// 轻量访问日志
if (config.accessLog) {
  app.use((req, res, next) => {
    if (req.path.startsWith('/static')) return next();
    const started = Date.now();
    res.on('finish', () => {
      console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });
}

app.use(
  session({
    name: 'forum.sid',
    secret: config.sessionSecret,
    store: new SqliteSessionStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);

// 全局模板变量：放在所有路由与中间件之前，保证 404/500 等错误页也能拿到
app.use((req, res, next) => {
  res.locals.siteName = config.siteName;
  res.locals.formatTime = viewHelpers.formatTime;
  res.locals.fromNow = viewHelpers.fromNow;
  res.locals.sectionMeta = viewHelpers.sectionMeta;
  res.locals.statusBadge = viewHelpers.statusBadge;
  res.locals.riskBadge = viewHelpers.riskBadge;
  res.locals.aiBadge = viewHelpers.aiBadge;
  res.locals.buildQuery = viewHelpers.buildQuery;
  res.locals.flash = [];
  next();
});

if (process.env.SESSION_DEBUG || process.argv.includes('--debug-session')) {
  app.use((req, res, next) => {
    const sentMatch = String(req.body?._csrf || '').slice(0, 8);
    const sid = String(req.sessionID || '-').slice(0, 12);
    console.log(
      `[req] ${req.method} ${req.originalUrl} sid=${sid} session_csrf=${req.session?.csrfToken ? req.session.csrfToken.slice(0, 8) : '-'} body_csrf=${sentMatch || '-'}`
    );
    next();
  });
}

app.use(csrfMiddleware);
app.use(flashMiddleware);

const csrf = (req, res, next) => {
  res.locals.csrfToken = csrfToken(req);
  next();
};

app.use(csrf);
app.use(attachUser);
app.use(viewHelpers.commonLocals);

// ---------------------------------------------------------------------------
// 4. 路由
// ---------------------------------------------------------------------------
app.use('/', require('./src/routes/index'));
app.use('/', require('./src/routes/auth'));
app.use('/posts', require('./src/routes/posts'));
app.use('/', require('./src/routes/comments'));
app.use('/me', require('./src/routes/me'));
app.use('/admin', require('./src/routes/admin'));
app.use('/uploads', require('./src/routes/uploads'));

// ---------------------------------------------------------------------------
// 5. 404 与错误处理
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).render('error', {
    title: '页面不存在',
    code: 404,
    message: '这个页面可能已经被删除，或者链接写错了。'
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  const code = err.status || 500;
  const locals = {
    siteName: config.siteName,
    sections: viewHelpers.SECTIONS,
    formatTime: viewHelpers.formatTime,
    fromNow: viewHelpers.fromNow,
    sectionMeta: viewHelpers.sectionMeta,
    statusBadge: viewHelpers.statusBadge,
    userStatusBadge: viewHelpers.userStatusBadge,
    riskBadge: viewHelpers.riskBadge,
    aiBadge: viewHelpers.aiBadge,
    buildQuery: viewHelpers.buildQuery,
    csrfInput: '',
    flash: [],
    currentUser: null,
    ...(res.locals || {}),
    title: '出了点问题',
    code,
    message: err.expose ? err.message : '服务器内部错误，请稍后重试。'
  };
  res.status(code).render('error', locals);
});

// ---------------------------------------------------------------------------
// 6. 启动
// ---------------------------------------------------------------------------
const server = app.listen(config.port, config.host, () => {
  const url = `http://${config.host}:${config.port}`;
  const site = settings.getSite();
  console.log('');
  console.log('  🌿 ' + site.siteName + ' 已启动');
  console.log('  🔗 本地访问地址: ' + url);
  console.log('  💾 数据库文件:   ' + db.file + '（驱动 ' + db.getDriverName() + '）');
  console.log('  📁 可修改配置:   ' + settings.CONFIG_DIR);
  if (seedResult.seeded) {
    console.log('  👤 管理员账号:   admin / ' + seedResult.adminPassword);
    console.log('  ℹ️  其他账号:     由超管在后台「用户管理」里添加');
  }
  console.log('  🛡️  AI 审核模式:  ' + (site.features.aiModeration === false
    ? '已关闭（新帖直接公开）'
    : (config.ai.enabled && config.ai.apiKey ? `远程模型 ${config.ai.model} + 本地规则` : '本地规则引擎（离线）')
      + (site.features.aiAutoApprove === false ? '，先审后发' : '')));
  console.log('');
});

// 后台运行时（日志重定向到文件）不必让 stdout 句柄拖住事件循环，
// 这样即使父进程退出，服务也能独立存活。
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.unref === 'function') {
    try {
      stream.unref();
    } catch (_) {
      /* ignore */
    }
  }
}

// 端口被占用等启动错误给出明确提示，而不是抛一堆栈
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${config.port} 已被占用。请先停止占用该端口的进程，或修改 .env 里的 PORT 后重试。`);
    if (process.platform === 'win32') {
      console.error(`   查看占用进程：netstat -ano | findstr :${config.port}`);
      console.error(`   结束占用进程：taskkill /PID <上面查到的 PID> /F`);
    } else {
      console.error(`   查看占用进程：lsof -i :${config.port}`);
    }
    process.exit(1);
  }
  console.error('服务启动失败：', err);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭服务...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
