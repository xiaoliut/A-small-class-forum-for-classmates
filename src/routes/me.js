'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const accountDeletion = require('../account-deletion');
const { requireApproved, verifyCsrf } = require('../middleware/common');

const router = express.Router();

// ---------------------------------------------------------------------------
// 头像上传（multer，存到 data/avatars/）
// ---------------------------------------------------------------------------
const AVATAR_DIR = path.join(config.dataDir, 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, AVATAR_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      cb(null, `${req.user.id}${ext}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('头像只支持 jpg / png / gif / webp 格式。'));
    }
  }
});

/** 删除用户的旧头像文件（换头像时避免残留） */
function removeOldAvatar(userId) {
  try {
    for (const file of fs.readdirSync(AVATAR_DIR)) {
      if (file.startsWith(`${userId}.`)) {
        fs.rmSync(path.join(AVATAR_DIR, file), { force: true });
      }
    }
  } catch (_) {
    /* ignore */
  }
}

/** 个人中心 */
router.get('/', requireApproved, (req, res) => {
  const stats = {
    posts: db.get("SELECT COUNT(*) AS c FROM posts WHERE user_id = ? AND status <> 'deleted'", req.user.id).c,
    approved: db.get("SELECT COUNT(*) AS c FROM posts WHERE user_id = ? AND status = 'approved'", req.user.id).c,
    pending: db.get("SELECT COUNT(*) AS c FROM posts WHERE user_id = ? AND status IN ('pending','flagged')", req.user.id).c,
    comments: db.get("SELECT COUNT(*) AS c FROM comments WHERE user_id = ? AND status = 'visible'", req.user.id).c
  };
  const reports = db.get(
    "SELECT COUNT(*) AS c FROM reports WHERE reporter_id = ?", req.user.id
  ).c;

  res.render('me', { title: '个人中心', stats, reportCount: reports });
});

/** 提交销号申请（填理由，审核通过后进入 7 天冷静期） */
router.get('/delete-account', requireApproved, (req, res) => {
  const pending = db.get(
    "SELECT * FROM account_deletion_requests WHERE user_id = ? AND status IN ('pending','cooling')",
    req.user.id
  );
  res.render('me-delete', { title: '注销账号', deletion: pending || null });
});

router.post('/delete-account', requireApproved,(req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (!reason) {
    req.flash('error', '请填写注销理由。');
    return res.redirect('/me/delete-account');
  }
  accountDeletion.submit(req.user.id, req.user.id, reason);
  req.flash('success', '注销申请已提交：审核通过后进入 7 天冷静期，到期自动注销账号。');
  res.redirect('/me');
});

/** 我的帖子（含审核状态） */
router.get('/posts', requireApproved, (req, res) => {
  const posts = db.all(
    `SELECT * FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
    req.user.id
  );
  res.render('me-posts', { title: '我的帖子', posts });
});

/** 我的评论 */
router.get('/comments', requireApproved, (req, res) => {
  const comments = db.all(
    `SELECT c.*, p.title AS post_title, p.status AS post_status
       FROM comments c JOIN posts p ON p.id = c.post_id
      WHERE c.user_id = ?
      ORDER BY c.created_at DESC LIMIT 100`,
    req.user.id
  );
  res.render('me-comments', { title: '我的评论', comments });
});

/** 修改密码 */
router.get('/password', requireApproved, (req, res) => {
  res.render('me-password', { title: '修改密码' });
});

router.post('/password', requireApproved,(req, res) => {
  const current = String(req.body.current || '');
  const next = String(req.body.next || '');
  const confirm = String(req.body.confirm || '');

  const user = db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  const back = (message) => {
    req.flash('error', message);
    res.status(400).render('me-password', { title: '修改密码' });
  };

  if (!bcrypt.compareSync(current, user.password_hash)) return back('当前密码不正确。');
  if (next.length < 6) return back('新密码至少 6 位。');
  if (next !== confirm) return back('两次输入的新密码不一致。');

  db.run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(next, 10), req.user.id);
  req.flash('success', '密码已更新，下次请使用新密码登录。');
  res.redirect('/me');
});

/** 修改个人资料 */
router.get('/profile', requireApproved, (req, res) => {
  const user = db.get('SELECT email, phone, avatar FROM users WHERE id = ?', req.user.id);
  const pendingRename = db.get("SELECT * FROM rename_requests WHERE user_id = ? AND status = 'pending'", req.user.id) || null;
  res.render('me-profile', { title: '修改资料', contact: user || {}, pendingRename });
});

router.post('/profile', requireApproved,(req, res, next) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) {
      req.flash('error', err.message || '头像上传失败，请检查文件大小或格式。');
      return res.redirect('/me/profile');
    }
    next();
  });
}, (req, res) => {
  // multipart 表单的 CSRF 需要在这里（multer 解析后）手动校验
  if (!verifyCsrf(req)) {
    if (req.file) removeOldAvatar(req.user.id);
    req.flash('error', '表单已过期或来源不合法，请返回上一页重新提交。');
    return res.redirect('/me/profile');
  }

  const nickname = String(req.body.nickname || '').trim();
  const realName = String(req.body.real_name || '').trim();
  const className = String(req.body.class_name || '').trim();
  const school = String(req.body.school || '').trim();
  const studentNo = String(req.body.student_no || '').trim();
  const email = String(req.body.email || '').trim();
  const phone = String(req.body.phone || '').trim();

  const errors = [];
  if (nickname.length < 1 || nickname.length > 16) errors.push('昵称长度需为 1-16 个字符。');
  if (!realName) errors.push('请填写真实姓名。');
  if (realName.length > 20) errors.push('真实姓名请控制在 20 字以内。');
  if (!className) errors.push('班级不能为空。');
  if (!school) errors.push('学校不能为空。');
  if (!email && !phone) errors.push('邮箱和手机号至少填一个。');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('邮箱格式不正确。');
  if (phone && !/^1\d{10}$/.test(phone)) errors.push('手机号格式不正确（应为 11 位数字）。');

  if (errors.length) {
    // 校验失败时，若已上传头像则删掉，避免留下孤儿文件
    if (req.file) removeOldAvatar(req.user.id);
    req.flash('error', errors.join(' '));
    return res.redirect('/me/profile');
  }

  // 处理头像
  if (req.file) {
    removeOldAvatar(req.user.id);
    db.run('UPDATE users SET avatar = ? WHERE id = ?', req.file.filename, req.user.id);
  }

  // 真实姓名变更走「申请-审核」：成员由任意管理员审核，管理员由超级管理员审核
  const current = db.get('SELECT real_name, role FROM users WHERE id = ?', req.user.id);
  let renamePending = false;
  if (current && current.real_name !== realName) {
    const existing = db.get("SELECT id FROM rename_requests WHERE user_id = ? AND status = 'pending'", req.user.id);
    if (existing) {
      db.run('UPDATE rename_requests SET new_name = ?, created_at = ? WHERE id = ?', realName, new Date().toISOString(), existing.id);
    } else {
      db.run(
        "INSERT INTO rename_requests (user_id, old_name, new_name, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
        req.user.id, current.real_name, realName, new Date().toISOString()
      );
    }
    renamePending = true;
  }

  db.run(
    'UPDATE users SET nickname = ?, class_name = ?, school = ?, student_no = ?, email = ?, phone = ? WHERE id = ?',
    nickname, className, school, studentNo || null, email || null, phone || null, req.user.id
  );
  req.flash('success', renamePending
    ? '资料已更新；真实姓名修改申请已提交，等待管理员审核后生效。'
    : '资料已更新。');
  res.redirect('/me');
});

/**
 * 上传裁剪后的头像（base64，JSON body）。
 * 前端裁剪器把圆形头像裁成 PNG 后 POST 到这里，返回 JSON。
 */
router.post('/avatar', requireApproved,(req, res) => {
  const dataUrl = String(req.body.avatar || '').trim();
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) {
    return res.status(400).json({ ok: false, error: '头像数据无效，请重新上传。' });
  }

  let buffer;
  try {
    buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  } catch (_) {
    return res.status(400).json({ ok: false, error: '头像数据损坏，请重新上传。' });
  }

  if (!buffer.length || buffer.length > 2 * 1024 * 1024) {
    return res.status(400).json({ ok: false, error: '头像文件过大或为空。' });
  }

  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  removeOldAvatar(req.user.id);
  const filename = `${req.user.id}.${ext}`;
  try {
    fs.writeFileSync(path.join(AVATAR_DIR, filename), buffer);
  } catch (err) {
    return res.status(500).json({ ok: false, error: `头像保存失败：${err.message}` });
  }
  db.run('UPDATE users SET avatar = ? WHERE id = ?', filename, req.user.id);
  res.json({ ok: true, avatar: `/avatars/${filename}?t=${Date.now()}` });
});

/** 删除自己的一条评论（个人中心入口，复用同一套逻辑） */
router.post('/comments/:id/delete', requireApproved, (req, res) => {
  const id = Number.parseInt(req.params.id, 10) || 0;
  const comment = db.get('SELECT * FROM comments WHERE id = ? AND user_id = ?', id, req.user.id);
  if (!comment) {
    req.flash('error', '评论不存在或不属于你。');
    return res.redirect('/me/comments');
  }
  db.run("UPDATE comments SET status = 'deleted' WHERE id = ?", id);
  db.run(
    "UPDATE posts SET comment_count = (SELECT COUNT(*) FROM comments WHERE post_id = ? AND status = 'visible') WHERE id = ?",
    comment.post_id, comment.post_id
  );
  req.flash('success', '评论已删除。');
  res.redirect('/me/comments');
});

module.exports = router;
