'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const settings = require('../settings');
const { csrfToken, logModeration } = require('../middleware/common');
/* #demo-start */
const config = require('../config');
const demo = require('../demo');
/* #demo-end */

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function registrationOpen() {
  return settings.getSite().features.allowRegister !== false;
}

function safeNext(value) {
  const next = String(value || '');
  return next.startsWith('/') && !next.startsWith('//') ? next : '';
}

/** 登录页 */
router.get('/login', (req, res) => {
  if (req.user && !req.user.isBanned) return res.redirect('/');
  res.render('login', { title: '登录', next: safeNext(req.query.next), form: {} });
});

/** 登录提交 */
router.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const next = safeNext(req.body.next);
  const form = { username };

  const fail = (message) => {
    req.flash('error', message);
    res.status(401).render('login', { title: '登录', next, form });
  };

  if (!username || !password) return fail('请输入用户名和密码。');

  const user = db.get('SELECT * FROM users WHERE username = ?', username);
  // 统一提示，避免暴露账号是否存在
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return fail('用户名或密码不正确。');
  }
  if (user.status === 'banned') {
    req.flash('error', `账号已被封禁：${user.ban_reason || '违反班级论坛规范'}`);
    return res.redirect('/banned');
  }

  const token = csrfToken(req);
/* #demo-start */
  const wasMasterUnlocked = Boolean(req.session && req.session.masterUnlocked);
/* #demo-end */
  req.session.regenerate((err) => {
    if (err) return fail('登录失败，请重试。');
    req.session.userId = user.id;
    req.session.csrfToken = token; // 会话 ID 变化后保留 CSRF token，避免正在提交的表单失效
/* #demo-start */
    // 登录会重建会话，这里把站长控制台的解锁状态带过去
    if (wasMasterUnlocked) req.session.masterUnlocked = true;
/* #demo-end */
    db.run('UPDATE users SET last_login_at = ? WHERE id = ?', new Date().toISOString(), user.id);
    req.flash('success', `欢迎回来，${user.nickname}！`);
    if (user.role === 'admin' || user.role === 'superadmin') return res.redirect(next || '/admin');
    if (user.status !== 'approved') return res.redirect('/pending');
    return res.redirect(next || '/');
  });
});

/** 注册（提交入班申请，等待管理员审核） */
router.get('/register', (req, res) => {
  if (req.user && !req.user.isBanned) return res.redirect('/');
  if (!registrationOpen()) {
    req.flash('info', '本站当前关闭了入班申请，请联系超级管理员开通账号。');
    return res.redirect('/login');
  }
  res.render('register', { title: '申请加入', form: {} });
});

router.post('/register', (req, res) => {
  if (!registrationOpen()) {
    req.flash('error', '本站当前关闭了入班申请，请联系管理员。');
    return res.redirect('/login');
  }
  const form = {
    username: String(req.body.username || '').trim(),
    nickname: String(req.body.nickname || '').trim(),
    real_name: String(req.body.real_name || '').trim(),
    school: String(req.body.school || '').trim(),
    class_name: String(req.body.class_name || '').trim(),
    student_no: String(req.body.student_no || '').trim(),
    email: String(req.body.email || '').trim(),
    phone: String(req.body.phone || '').trim(),
    apply_reason: String(req.body.apply_reason || '').trim()
  };
  const password = String(req.body.password || '');
  const password2 = String(req.body.password2 || '');

  const errors = [];
  if (!USERNAME_RE.test(form.username)) errors.push('用户名需为 3-20 位字母、数字或下划线。');
  if (password.length < 6) errors.push('密码至少 6 位。');
  if (password !== password2) errors.push('两次输入的密码不一致。');
  if (form.nickname.length < 1 || form.nickname.length > 16) errors.push('昵称长度需为 1-16 个字符。');
  if (!form.real_name) errors.push('请填写真实姓名，方便管理员核对。');
  if (!form.school) errors.push('请填写学校名称。');
  if (!form.class_name) errors.push('请填写班级。');
  if (form.apply_reason.length > 200) errors.push('申请说明请控制在 200 字以内。');

  // 邮箱 / 手机号至少填一个
  if (!form.email && !form.phone) {
    errors.push('邮箱和手机号至少填写一个，方便管理员联系你。');
  }
  if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
    errors.push('邮箱格式不正确。');
  }
  if (form.phone && !/^1\d{10}$/.test(form.phone)) {
    errors.push('手机号格式不正确（应为 11 位数字）。');
  }

  if (db.get('SELECT id FROM users WHERE username = ?', form.username)) {
    errors.push('该用户名已被使用，换一个试试。');
  }

  if (errors.length) {
    req.flash('error', errors.join(' '));
    return res.status(400).render('register', { title: '申请加入', form });
  }

  const now = new Date().toISOString();
  const info = db.run(
    `INSERT INTO users (username, password_hash, nickname, real_name, school, class_name,
                        student_no, email, phone, apply_reason, role, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'student', 'pending', ?)`,
    form.username,
    bcrypt.hashSync(password, 10),
    form.nickname,
    form.real_name,
    form.school,
    form.class_name,
    form.student_no || null,
    form.email || null,
    form.phone || null,
    form.apply_reason || null,
    now
  );

  logModeration(null, 'submit_application', 'user', info.lastInsertRowid, `${form.real_name} 提交入班申请`);
  req.flash('success', '申请已提交！管理员审核通过后即可登录使用论坛。');
  res.redirect('/register/done?u=' + encodeURIComponent(form.username));
});

router.get('/register/done', (req, res) => {
  res.render('register-done', { title: '申请已提交', username: String(req.query.u || '') });
});

/** 退出登录 */
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('forum.sid');
/* #demo-start */
    // 演示模式：记一个标记，之后不再自动登录，方便访客切普通身份
    // 同时撤掉站长身份（不然退出登录后站长 Cookie 还留着）
    demo.revokeMaster(null, res);
    if (config.demo.enabled) {
      res.cookie(demo.EXIT_COOKIE, '1', {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 12 * 60 * 60 * 1000
      });
    }
/* #demo-end */
    res.redirect('/');
  });
});

/* #demo-start */
/** 演示模式：清除退出标记，重新以共用超级管理员身份进入 */
router.get('/demo/enter', (req, res) => {
  res.clearCookie(demo.EXIT_COOKIE);
  req.flash('success', '已切回超级管理员演示身份。');
  res.redirect('/');
});
/* #demo-end */

module.exports = router;
