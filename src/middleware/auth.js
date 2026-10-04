'use strict';

/**
 * 通用中间件：flash 提示、CSRF 防护、认证辅助。
 */

const crypto = require('crypto');
const db = require('../db');

// ---------------------------------------------------------------------------
// flash 提示（存在 session 里，读取一次即清除）
// ---------------------------------------------------------------------------
function flashMiddleware(req, res, next) {
  // 把已有提示搬到 res.locals，供模板渲染
  const list = req.session.flash || [];
  req.session.flash = [];
  res.locals.flash = list;

  req.flash = (type, message) => {
    if (!req.session.flash) req.session.flash = [];
    const item = { type, message };
    req.session.flash.push(item);
    // 同一次请求内就要显示（例如登录失败直接 render 登录页）
    res.locals.flash.push(item);
  };
  next();
}

// ---------------------------------------------------------------------------
// CSRF：会话级 token + 表单隐藏域 / X-CSRF-Token 头
// ---------------------------------------------------------------------------
function csrfToken(req) {
  if (!req.session) return '';
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrfToken;
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** 标记：本会话的 CSRF token 是否已经落库，避免每次请求重复写库 */
const CSRF_SAVED = Symbol('csrfSaved');

function csrfMiddleware(req, res, next) {
  // 确保会话里已经有 token 并立即持久化：
  // saveUninitialized 为 false 时，只写 session 字段而没有真正改动的会话不会被保存，
  // 会导致 GET 页面发出的 token 在 POST 时校验失败。
  if (req.session && !req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    req.session[CSRF_SAVED] = true;
    req.session.save(() => {});
  }

  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) return next();

  // multipart/form-data 的 body 要等 multer 解析后才能读到 _csrf，
  // 这里先放行，由具体路由在 multer 之后调用 verifyCsrf 手动校验。
  if (req.is && req.is('multipart/form-data')) return next();

  const expected = req.session ? req.session.csrfToken : null;
  const provided = req.body?._csrf || req.get('x-csrf-token');
  if (!expected || !safeEqual(expected, provided)) {
    const err = new Error('表单已过期或来源不合法，请返回上一页重新提交。');
    err.status = 403;
    err.expose = true;
    return next(err);
  }
  return next();
}

/** 供 multipart 路由在 multer 解析后手动校验 CSRF */
function verifyCsrf(req) {
  const expected = req.session ? req.session.csrfToken : null;
  const provided = req.body?._csrf;
  return Boolean(expected && safeEqual(expected, provided));
}

// ---------------------------------------------------------------------------
// 登录态
// ---------------------------------------------------------------------------
function attachUser(req, res, next) {
  res.locals.currentUser = null;
  if (!req.session?.userId) return next();

  const user = db.get(
    `SELECT id, username, nickname, real_name, school, class_name, student_no, email, phone,
            avatar, role, status, mute_until, ban_reason, created_at, last_login_at
       FROM users WHERE id = ?`,
    req.session.userId
  );

  if (!user) {
    delete req.session.userId;
    return next();
  }

  // 销号冷静期到期：懒删除账号
  const accountDeletion = require('../account-deletion');
  if (accountDeletion.processCooling(user.id)) {
    delete req.session.userId;
    res.locals.currentUser = null;
    req.flash('info', '你的销号冷静期已结束，账号已注销。');
    return next();
  }
  if (user.status === 'deleted') {
    delete req.session.userId;
    res.locals.currentUser = null;
    return next();
  }

  req.user = user;
  user.isSuperAdmin = user.role === 'superadmin';
  user.isAdmin = user.role === 'admin' || user.role === 'superadmin';
  user.isBanned = user.status === 'banned';
  user.mutedUntil = user.mute_until ? new Date(user.mute_until) : null;
  user.isMuted = Boolean(user.mutedUntil && user.mutedUntil.getTime() > Date.now());
  res.locals.currentUser = user;
  return next();
}

function requireLogin(req, res, next) {
  if (req.user && !req.user.isBanned) return next();
  if (req.user && req.user.isBanned) {
    req.flash('error', `账号已被封禁：${req.user.ban_reason || '违反班级论坛规范'}`);
    return res.redirect('/banned');
  }
  req.flash('error', '请先登录后再进行该操作。');
  return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

/** 允许 pending 用户访问的轻量校验（例如查看自己的申请状态） */
function requireApproved(req, res, next) {
  if (!req.user) {
    req.flash('error', '请先登录。');
    return res.redirect('/login');
  }
  if (req.user.isBanned) return res.redirect('/banned');
  if (req.user.status !== 'approved') {
    return res.redirect('/pending');
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    req.flash('error', '请先以管理员身份登录。');
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  if (!req.user.isAdmin) {
    const err = new Error('只有管理员可以访问该页面。');
    err.status = 403;
    err.expose = true;
    return next(err);
  }
  return next();
}

/** 仅超级管理员可访问：站点设置等全站内容修改 */
function requireSuperAdmin(req, res, next) {
  if (!req.user) {
    req.flash('error', '请先登录。');
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  if (!req.user.isSuperAdmin) {
    const err = new Error('只有超级管理员可以修改网站内容设置。');
    err.status = 403;
    err.expose = true;
    return next(err);
  }
  return next();
}

/** 写操作前检查禁言状态 */
function requireNotMuted(req, res, next) {
  if (req.user?.isMuted) {
    req.flash('error', `你已被禁言至 ${req.user.mute_until.slice(0, 16).replace('T', ' ')}，暂时无法发帖或评论。`);
    return res.redirect(req.get('Referer') || '/');
  }
  return next();
}

/** 管理员操作审计日志 */
function logModeration(admin, action, targetType, targetId, detail) {
  db.run(
    `INSERT INTO moderation_logs (admin_id, admin_name, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    admin?.id ?? null,
    admin ? (admin.nickname || admin.username) : '系统',
    action,
    targetType,
    targetId ?? null,
    detail ?? null,
    new Date().toISOString()
  );
}

module.exports = {
  flashMiddleware,
  csrfMiddleware,
  verifyCsrf,
  csrfToken,
  attachUser,
  requireLogin,
  requireApproved,
  requireAdmin,
  requireSuperAdmin,
  requireNotMuted,
  logModeration,
  safeEqual
};
