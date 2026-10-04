'use strict';

/**
 * 演示模式（.env 里设 DEMO_MODE=1 开启）：
 *
 *   1. 访客一进来就自动以「共用超级管理员」身份登录
 *      —— 站点只有一个超管账号，所有访客共用它
 *   2. 站点设置只读，任何保存操作都会被拒绝
 *   3. 想测试普通成员/普通管理员，走正常的注册申请流程
 *   4. 每隔一小时清一次场：评论、除超管外的所有账号、非公告类的帖子
 *      （站长自己发的置顶帖 / 公告帖会保留）
 *
 * 站长入口（默认 /master）不会被自动登录接管，站长可以在那里正常输账号密码，
 * 登录后依然是超管身份。退出登录会带上 demo_exit cookie，之后不再自动登录。
 */

const config = require('./config');
const db = require('./db');
const crypto = require('crypto');

const EXIT_COOKIE = 'demo_exit';
const MASTER_COOKIE = 'demo_master';

/** 定长字符串比较，避免时序攻击 */
function safeEqualStr(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** 站长身份的 Cookie 值：用会话密钥对口令签名，不可伪造、也不泄露口令本身 */
function masterCookieValue() {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update('master:' + config.demo.masterKey)
    .digest('hex')
    .slice(0, 40);
}

// 清场时间状态，给站长面板显示用
let lastCleanAt = null;
let nextCleanAt = null;

/** 从 Cookie 头读一个值（不额外引 cookie-parser，保持零多余依赖） */
function readCookie(req, name) {
  const raw = req.headers?.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return '';
}

/** 共用的超级管理员账号（取最早创建的那一个） */
function sharedAdmin() {
  return db.get(
    "SELECT id, username, nickname FROM users WHERE role = 'superadmin' ORDER BY id LIMIT 1"
  );
}

/** 判断某个请求路径是否落在站长入口下 */
function isMasterPath(pathname) {
  if (!config.demo.masterPath) return false;
  const base = '/' + config.demo.masterPath;
  return pathname === base || pathname.startsWith(base + '/');
}

/**
 * 中间件：演示模式下，未登录且没有主动退出过时，自动登录为共用超管。
 * 必须挂在 attachUser 之前，attachUser 才能读到 session.userId。
 */
function autoLogin(req, res, next) {
  if (!config.demo.enabled) return next();
  // 站长入口不接管，否则根本没法输入账号密码
  if (isMasterPath(req.path)) return next();
  if (req.session?.userId) return next();
  if (readCookie(req, EXIT_COOKIE) === '1') return next();

  const admin = sharedAdmin();
  if (!admin) return next();

  req.session.userId = admin.id;
  req.session.demoShared = true;
  return next();
}

/**
 * 当前请求是不是「真正的站长」。
 * 只有通过站长入口输对了口令的会话才算，被自动登录接管的访客不算。
 * 没配 MASTER_KEY 时永远为 false —— 那时没人能改演示站设置。
 */
function isMaster(req) {
  if (!config.demo.masterKey) return false;
  if (req.session && req.session.masterUnlocked) return true;
  // 会话丢了也能靠 Cookie 认出来，不然刷新一下就要重新输口令
  const fromCookie = readCookie(req, MASTER_COOKIE);
  return Boolean(fromCookie) && safeEqualStr(fromCookie, masterCookieValue());
}

/** 记下站长身份：会话和 Cookie 各存一份，互为备份 */
function grantMaster(req, res) {
  if (req.session) req.session.masterUnlocked = true;
  if (res) {
    res.cookie(MASTER_COOKIE, masterCookieValue(), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
  }
}

/** 撤销站长身份（锁定、退出登录时用） */
function revokeMaster(req, res) {
  if (req && req.session) delete req.session.masterUnlocked;
  if (res) res.clearCookie(MASTER_COOKIE);
}

/**
 * 中间件：演示模式下，只允许通过站长口令的会话继续。
 * 其他人一律退回站长入口（去输口令），连页面都不给看。
 */
function requireMaster(message) {
  return (req, res, next) => {
    if (!config.demo.enabled) return next();
    if (isMaster(req)) return next();
    req.flash('error', message || '这个页面在演示模式下已锁定，请从站长入口进入。');
    return res.redirect('/' + config.demo.masterPath);
  };
}

/**
 * 中间件：演示模式下锁住超级管理员的账号资料。
 * 访客共用同一个超管账号，要是能改密码或资料就全乱套了 —— 只能看，不能改。
 */
function blockMasterProfile(message) {
  return (req, res, next) => {
    if (!config.demo.enabled) return next();
    if (req.user && req.user.isSuperAdmin) {
      req.flash('error', message || '演示站点的超级管理员账号已锁定，资料和密码只能查看、不能修改。');
      return res.redirect('/me');
    }
    return next();
  };
}

/**
 * 中间件：演示模式下拒绝写操作。
 * 站长（口令解锁过的）不受限制，站点设置照样能改。
 */
function blockWrite(message) {
  return (req, res, next) => {
    if (!config.demo.enabled) return next();
    if (isMaster(req)) return next();
    req.flash('error', message || '演示网站禁止修改。');
    return res.redirect(req.get('Referer') || '/');
  };
}

/**
 * 清场：删掉所有评论、除超管外的所有账号，以及非公告类的帖子。
 * 站长（超管）自己发的置顶帖 / 公告帖会保留下来，免得演示站被清成一片空白。
 * 各表的 user_id / post_id 外键都是 ON DELETE CASCADE，级联会一并清掉举报、申请等。
 */
function cleanup() {
  const admin = sharedAdmin();
  if (!admin) return null;

  const keep = db
    .all('SELECT id FROM posts WHERE user_id = ? AND (pinned = 1 OR is_notice = 1)', admin.id)
    .map((row) => row.id);

  const stat = {
    posts: db.get('SELECT COUNT(*) AS c FROM posts').c - keep.length,
    comments: db.get('SELECT COUNT(*) AS c FROM comments').c,
    users: db.get("SELECT COUNT(*) AS c FROM users WHERE id != ?", admin.id).c,
    kept: keep.length
  };

  db.run('DELETE FROM comments');
  if (keep.length) {
    const marks = keep.map(() => '?').join(',');
    db.run(`DELETE FROM posts WHERE id NOT IN (${marks})`, ...keep);
    db.run(`UPDATE posts SET comment_count = 0 WHERE id IN (${marks})`, ...keep);
  } else {
    db.run('DELETE FROM posts');
  }
  db.run('DELETE FROM users WHERE id != ?', admin.id);

  lastCleanAt = new Date();
  return stat;
}

/** 当前演示站状态，供站长面板展示 */
function getStatus() {
  const admin = sharedAdmin();
  const adminId = admin ? admin.id : -1;
  return {
    enabled: config.demo.enabled,
    masterPath: config.demo.masterPath,
    intervalMs: Math.max(60 * 1000, config.demo.cleanIntervalMs),
    lastCleanAt: lastCleanAt ? lastCleanAt.toISOString() : null,
    nextCleanAt: nextCleanAt ? nextCleanAt.toISOString() : null,
    posts: db.get('SELECT COUNT(*) AS c FROM posts').c,
    kept: db.get(
      'SELECT COUNT(*) AS c FROM posts WHERE user_id = ? AND (pinned = 1 OR is_notice = 1)',
      adminId
    ).c,
    comments: db.get('SELECT COUNT(*) AS c FROM comments').c,
    users: db.get('SELECT COUNT(*) AS c FROM users').c,
    visitors: db.get("SELECT COUNT(*) AS c FROM users WHERE id != ?", adminId).c
  };
}

/** 启动定时清理器（返回 timer，未开启演示模式时返回 null） */
function startCleaner() {
  if (!config.demo.enabled) return null;

  const interval = Math.max(60 * 1000, config.demo.cleanIntervalMs);

  const tick = () => {
    try {
      const stat = cleanup();
      if (stat) {
        console.log(
          `[demo] 清场完成 —— 帖子 ${stat.posts} 条、评论 ${stat.comments} 条、账号 ${stat.users} 个` +
            (stat.kept ? `（保留公告 ${stat.kept} 条）` : '')
        );
      }
    } catch (err) {
      console.error('[demo] 清场失败：' + err.message);
    }
    nextCleanAt = new Date(Date.now() + interval);
  };

  nextCleanAt = new Date(Date.now() + interval);
  tick(); // 启动时先清一次，免得留下上次的数据
  const timer = setInterval(tick, interval);
  if (timer.unref) timer.unref(); // 别因为这个定时器拖住进程退出
  console.log(`[demo] 演示模式已开启，每 ${Math.round(interval / 60000)} 分钟清理一次游客数据`);
  return timer;
}

module.exports = {
  EXIT_COOKIE,
  MASTER_COOKIE,
  readCookie,
  sharedAdmin,
  isMasterPath,
  isMaster,
  grantMaster,
  revokeMaster,
  requireMaster,
  blockMasterProfile,
  autoLogin,
  blockWrite,
  cleanup,
  getStatus,
  startCleaner
};
