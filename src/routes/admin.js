'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db');
const ai = require('../ai');
const settings = require('../settings');
const accountDeletion = require('../account-deletion');
const { requireAdmin, requireSuperAdmin, logModeration } = require('../middleware/common');
/* #demo-start */
const demo = require('../demo');
/* #demo-end */

const router = express.Router();
router.use(requireAdmin);

function safeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

/** 后台首页：待办概览 */
router.get('/', (req, res) => {
  const counts = {
    pendingUsers: db.get("SELECT COUNT(*) AS c FROM users WHERE status = 'pending'").c,
    pendingPosts: db.get("SELECT COUNT(*) AS c FROM posts WHERE status = 'pending'").c,
    flaggedPosts: db.get("SELECT COUNT(*) AS c FROM posts WHERE status = 'flagged'").c,
    hiddenComments: db.get("SELECT COUNT(*) AS c FROM comments WHERE status = 'hidden'").c,
    openReports: db.get("SELECT COUNT(*) AS c FROM reports WHERE status = 'open'").c,
    mutedUsers: db.get(
      "SELECT COUNT(*) AS c FROM users WHERE mute_until IS NOT NULL AND mute_until > ?", new Date().toISOString()
    ).c,
    bannedUsers: db.get("SELECT COUNT(*) AS c FROM users WHERE status = 'banned'").c,
    aiViolations: db.get("SELECT COUNT(*) AS c FROM posts WHERE ai_verdict = 'violation'").c
  };

  const recentFlagged = db.all(
    `SELECT p.id, p.title, p.status, p.ai_verdict, p.ai_risk, p.ai_labels, p.created_at, u.nickname
       FROM posts p JOIN users u ON u.id = p.user_id
      WHERE p.status IN ('pending','flagged')
      ORDER BY p.ai_risk DESC, p.created_at DESC LIMIT 8`
  );

  const recentReports = db.all(
    `SELECT r.*, u.nickname AS reporter_name FROM reports r
       JOIN users u ON u.id = r.reporter_id
      WHERE r.status = 'open' ORDER BY r.created_at DESC LIMIT 6`
  );

  const logs = db.all('SELECT * FROM moderation_logs ORDER BY created_at DESC LIMIT 12');

  res.render('admin/dashboard', { title: '管理后台', counts, recentFlagged, recentReports, logs });
});

/** 入班申请审核 */
router.get('/applications', (req, res) => {
  const applications = db.all(
    `SELECT * FROM users WHERE status IN ('pending','rejected') ORDER BY
       CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`
  );
  res.render('admin/applications', { title: '入班申请', applications });
});

router.post('/users/:id/approve', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const user = db.get('SELECT * FROM users WHERE id = ?', id);
  if (!user) {
    req.flash('error', '用户不存在。');
    return res.redirect('/admin/applications');
  }
  db.run(
    "UPDATE users SET status = 'approved', reviewed_by = ?, reviewed_at = ?, ban_reason = NULL WHERE id = ?",
    req.user.id, new Date().toISOString(), id
  );
  logModeration(req.user, 'approve_user', 'user', id, `通过 ${user.real_name}（${user.class_name}）的入班申请`);
  req.flash('success', `已通过 ${user.nickname} 的申请。`);
  res.redirect('/admin/applications');
});

router.post('/users/:id/reject', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const user = db.get('SELECT * FROM users WHERE id = ?', id);
  if (!user) {
    req.flash('error', '用户不存在。');
    return res.redirect('/admin/applications');
  }
  const reason = String(req.body.reason || '').trim().slice(0, 200);
  db.run(
    "UPDATE users SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, ban_reason = ? WHERE id = ?",
    req.user.id, new Date().toISOString(), reason || '资料不符，未通过审核', id
  );
  logModeration(req.user, 'reject_user', 'user', id, `驳回申请：${reason || '未填写原因'}`);
  req.flash('success', `已驳回 ${user.nickname} 的申请。`);
  res.redirect('/admin/applications');
});

/** 改名申请审核：成员的申请由任意管理员审核，管理员的申请仅超级管理员可审核 */
router.get('/renames', (req, res) => {
  const where = req.user.isSuperAdmin
    ? "r.status = 'pending'"
    : "r.status = 'pending' AND u.role = 'student'";
  const renames = db.all(
    `SELECT r.*, u.nickname, u.username, u.role AS user_role, u.class_name
       FROM rename_requests r JOIN users u ON u.id = r.user_id
      WHERE ${where}
      ORDER BY r.created_at DESC`
  );
  res.render('admin/renames', { title: '改名申请', renames });
});

router.post('/renames/:id/approve', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const rq = db.get('SELECT * FROM rename_requests WHERE id = ?', id);
  if (!rq || rq.status !== 'pending') {
    req.flash('error', '该申请不存在或已处理。');
    return res.redirect('/admin/renames');
  }
  const user = db.get('SELECT * FROM users WHERE id = ?', rq.user_id);
  if (!user) {
    req.flash('error', '申请人不存在。');
    return res.redirect('/admin/renames');
  }
  if (user.role === 'admin' && !req.user.isSuperAdmin) {
    req.flash('error', '只有超级管理员能审核管理员的改名申请。');
    return res.redirect('/admin/renames');
  }
  const now = new Date().toISOString();
  db.run('UPDATE users SET real_name = ? WHERE id = ?', rq.new_name, user.id);
  db.run("UPDATE rename_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?", req.user.id, now, id);
  logModeration(req.user, 'approve_rename', 'user', user.id, `通过 ${user.nickname} 改名「${rq.old_name}」→「${rq.new_name}」`);
  req.flash('success', `已通过 ${user.nickname} 的改名申请。`);
  res.redirect('/admin/renames');
});

router.post('/renames/:id/reject', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const rq = db.get('SELECT * FROM rename_requests WHERE id = ?', id);
  if (!rq || rq.status !== 'pending') {
    req.flash('error', '该申请不存在或已处理。');
    return res.redirect('/admin/renames');
  }
  const user = db.get('SELECT * FROM users WHERE id = ?', rq.user_id);
  if (!user) {
    req.flash('error', '申请人不存在。');
    return res.redirect('/admin/renames');
  }
  if (user.role === 'admin' && !req.user.isSuperAdmin) {
    req.flash('error', '只有超级管理员能审核管理员的改名申请。');
    return res.redirect('/admin/renames');
  }
  db.run("UPDATE rename_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?", req.user.id, new Date().toISOString(), id);
  logModeration(req.user, 'reject_rename', 'user', user.id, `驳回 ${user.nickname} 改名「${rq.old_name}」→「${rq.new_name}」`);
  req.flash('success', `已驳回 ${user.nickname} 的改名申请。`);
  res.redirect('/admin/renames');
});

/** 账号删除/销号申请审核 */
router.get('/deletions', (req, res) => {
  const where = req.user.isSuperAdmin
    ? "d.status IN ('pending','cooling')"
    : "d.status IN ('pending','cooling') AND u.role = 'student'";
  const deletions = db.all(
    `SELECT d.*, u.nickname, u.username, u.role AS user_role, u.class_name
       FROM account_deletion_requests d JOIN users u ON u.id = d.user_id
      WHERE ${where}
      ORDER BY d.created_at DESC`
  );
  res.render('admin/deletions', { title: '销号申请', deletions });
});

router.post('/deletions/:id/approve', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const req2 = db.get('SELECT * FROM account_deletion_requests WHERE id = ?', id);
  if (!req2 || req2.status !== 'pending') {
    req.flash('error', '该申请不存在或已处理。');
    return res.redirect('/admin/deletions');
  }
  const user = db.get('SELECT * FROM users WHERE id = ?', req2.user_id);
  if (!user) {
    req.flash('error', '申请人不存在。');
    return res.redirect('/admin/deletions');
  }
  if (user.role === 'admin' && !req.user.isSuperAdmin) {
    req.flash('error', '只有超级管理员能审核管理员的销号申请。');
    return res.redirect('/admin/deletions');
  }
  if (req2.requester_id === req.user.id) {
    req.flash('error', '不能审核自己发起的删除申请。');
    return res.redirect('/admin/deletions');
  }
  accountDeletion.approve(id, req.user.id);
  logModeration(req.user, 'approve_deletion', 'user', user.id, `通过 ${user.nickname} 的销号申请，进入 7 天冷静期`);
  req.flash('success', `已通过 ${user.nickname} 的销号申请，进入 7 天冷静期后自动注销。`);
  res.redirect('/admin/deletions');
});

router.post('/deletions/:id/reject', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const req2 = db.get('SELECT * FROM account_deletion_requests WHERE id = ?', id);
  if (!req2 || req2.status !== 'pending') {
    req.flash('error', '该申请不存在或已处理。');
    return res.redirect('/admin/deletions');
  }
  const user = db.get('SELECT * FROM users WHERE id = ?', req2.user_id);
  if (!user) {
    req.flash('error', '申请人不存在。');
    return res.redirect('/admin/deletions');
  }
  if (user.role === 'admin' && !req.user.isSuperAdmin) {
    req.flash('error', '只有超级管理员能审核管理员的销号申请。');
    return res.redirect('/admin/deletions');
  }
  accountDeletion.reject(id, req.user.id);
  logModeration(req.user, 'reject_deletion', 'user', user.id, `驳回 ${user.nickname} 的销号申请`);
  req.flash('success', `已驳回 ${user.nickname} 的销号申请。`);
  res.redirect('/admin/deletions');
});

/**
 * 删除用户：
 * - 超级管理员：直接软删除成员/管理员（不能删超管）。
 * - 普通管理员：只能对成员提交删除申请（不能动管理员）。
 */
router.post('/users/:id/delete', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const target = db.get('SELECT * FROM users WHERE id = ?', id);
  if (!target) {
    req.flash('error', '用户不存在。');
    return res.redirect('/admin/users');
  }
  if (target.role === 'superadmin') {
    req.flash('error', '不能删除超级管理员账号。');
    return res.redirect('/admin/users');
  }
  if (target.role === 'admin' && !req.user.isSuperAdmin) {
    req.flash('error', '普通管理员不能删除管理员账号。');
    return res.redirect('/admin/users');
  }

  if (req.user.isSuperAdmin) {
    // 超级管理员直接软删除
    accountDeletion.softDelete(target.id);
    db.run("DELETE FROM account_deletion_requests WHERE user_id = ?", target.id);
    logModeration(req.user, 'delete_user', 'user', target.id, `超级管理员删除账号 ${target.nickname}`);
    req.flash('success', `已删除账号 ${target.nickname}。`);
  } else {
    // 普通管理员删除成员 → 走申请
    const reason = String(req.body.reason || '').trim() || '管理员申请删除';
    accountDeletion.submit(target.id, req.user.id, reason);
    logModeration(req.user, 'request_deletion', 'user', target.id, `申请删除 ${target.nickname}：${reason}`);
    req.flash('success', `已为 ${target.nickname} 提交删除申请，等待超级管理员审核。`);
  }
  res.redirect('/admin/users');
});

/** 用户管理：封号、解封、禁言、解除禁言 */
router.get('/users', (req, res) => {
  const keyword = String(req.query.q || '').trim();
  const status = ['pending', 'approved', 'rejected', 'banned', 'deleted'].includes(req.query.status) ? req.query.status : '';
  const conditions = ['1 = 1'];
  const params = [];
  if (keyword) {
    conditions.push('(username LIKE ? OR nickname LIKE ? OR real_name LIKE ? OR class_name LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  } else {
    // 「全部」默认排除已注销账号，已注销账号在单独的「已注销」分类里
    conditions.push("status <> 'deleted'");
  }
  const users = db.all(
    `SELECT u.*,
            (SELECT COUNT(*) FROM posts WHERE user_id = u.id AND status = 'approved') AS post_count,
            (SELECT COUNT(*) FROM comments WHERE user_id = u.id AND status = 'visible') AS comment_count
       FROM users u WHERE ${conditions.join(' AND ')}
      ORDER BY CASE u.role WHEN 'admin' THEN 0 ELSE 1 END, u.created_at DESC LIMIT 200`,
    ...params
  );
  res.render('admin/users', { title: '用户管理', users, keyword, status });
});

router.post('/users/:id/mute', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const target = db.get('SELECT * FROM users WHERE id = ?', id);
  if (!target) {
    req.flash('error', '用户不存在。');
    return res.redirect('/admin/users');
  }
  // 谁都不能处罚超级管理员；普通管理员不能处罚管理员；超级管理员可处罚普通管理员
  if (target.role === 'superadmin' || (target.role === 'admin' && !req.user.isSuperAdmin)) {
    req.flash('error', '你没有权限对该账号执行禁言。');
    return res.redirect('/admin/users');
  }

  const mode = String(req.body.mode || 'hours');
  const durationMap = { hours: 1 / 24, days: 1, week: 7, month: 30, forever: 3650 };
  const days = durationMap[mode] ?? 1;
  const reason = String(req.body.reason || '').trim().slice(0, 200) || '发布不当内容';
  const muteUntil = mode === 'lift' ? null : daysFromNow(days);

  if (mode === 'lift') {
    db.run('UPDATE users SET mute_until = NULL WHERE id = ?', id);
    logModeration(req.user, 'unmute_user', 'user', id, '解除禁言');
    req.flash('success', `已解除 ${target.nickname} 的禁言。`);
  } else {
    db.run('UPDATE users SET mute_until = ? WHERE id = ?', muteUntil, id);
    logModeration(req.user, 'mute_user', 'user', id, `禁言至 ${muteUntil.slice(0, 16).replace('T', ' ')}：${reason}`);
    req.flash('success', `已禁言 ${target.nickname} 至 ${muteUntil.slice(0, 16).replace('T', ' ')}。`);
  }
  res.redirect('/admin/users');
});

router.post('/users/:id/ban', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const target = db.get('SELECT * FROM users WHERE id = ?', id);
  if (!target) {
    req.flash('error', '用户不存在。');
    return res.redirect('/admin/users');
  }
  if (target.role === 'superadmin' || (target.role === 'admin' && !req.user.isSuperAdmin)) {
    req.flash('error', '你没有权限封禁该账号。');
    return res.redirect('/admin/users');
  }
  if (target.id === req.user.id) {
    req.flash('error', '不能封禁自己。');
    return res.redirect('/admin/users');
  }

  const reason = String(req.body.reason || '').trim().slice(0, 200) || '严重违反班级论坛规范';
  db.run("UPDATE users SET status = 'banned', ban_reason = ? WHERE id = ?", reason, id);
  logModeration(req.user, 'ban_user', 'user', id, `封禁账号：${reason}`);
  req.flash('success', `已封禁 ${target.nickname}。`);
  res.redirect('/admin/users');
});

router.post('/users/:id/unban', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const target = db.get('SELECT * FROM users WHERE id = ?', id);
  if (!target) {
    req.flash('error', '用户不存在。');
    return res.redirect('/admin/users');
  }
  db.run("UPDATE users SET status = 'approved', ban_reason = NULL, mute_until = NULL WHERE id = ?", id);
  logModeration(req.user, 'unban_user', 'user', id, '解除封禁');
  req.flash('success', `已解除 ${target.nickname} 的封禁。`);
  res.redirect('/admin/users');
});

/** 提升为管理员（仅超级管理员） */
router.post('/users/:id/promote', requireSuperAdmin, (req, res) => {
  const id = safeInt(req.params.id, 0);
  const target = db.get('SELECT * FROM users WHERE id = ?', id);
  if (!target) {
    req.flash('error', '用户不存在。');
    return res.redirect('/admin/users');
  }
  if (target.role === 'superadmin') {
    req.flash('error', '该账号已是超级管理员。');
    return res.redirect('/admin/users');
  }
  db.run("UPDATE users SET role = 'admin' WHERE id = ?", id);
  logModeration(req.user, 'promote_admin', 'user', id, `将 ${target.nickname} 提升为管理员`);
  req.flash('success', `已将 ${target.nickname} 提升为管理员。`);
  res.redirect('/admin/users');
});

/** 移除管理员（降级为普通同学，仅超级管理员） */
router.post('/users/:id/demote', requireSuperAdmin, (req, res) => {
  const id = safeInt(req.params.id, 0);
  const target = db.get('SELECT * FROM users WHERE id = ?', id);
  if (!target) {
    req.flash('error', '用户不存在。');
    return res.redirect('/admin/users');
  }
  if (target.role !== 'admin') {
    req.flash('error', '该账号不是管理员。');
    return res.redirect('/admin/users');
  }
  if (target.id === req.user.id) {
    req.flash('error', '不能移除自己。');
    return res.redirect('/admin/users');
  }
  db.run("UPDATE users SET role = 'student' WHERE id = ?", id);
  logModeration(req.user, 'demote_admin', 'user', id, `将 ${target.nickname} 移除管理员身份`);
  req.flash('success', `已移除 ${target.nickname} 的管理员身份。`);
  res.redirect('/admin/users');
});

/**
 * 管理员帮成员改真实姓名：同样走「申请-审核」，不直接改。
 * 权限：普通管理员只能为成员（student）提交改名申请；超级管理员可为所有人（含普通管理员）提交。
 * 任何人都不能为超级管理员提交改名申请。
 */
router.post('/users/:id/name', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const target = db.get('SELECT * FROM users WHERE id = ?', id);
  const realName = String(req.body.real_name || '').trim().slice(0, 20);

  if (!target) {
    req.flash('error', '用户不存在。');
    return res.redirect('/admin/users');
  }
  if (!realName) {
    req.flash('error', '真实姓名不能为空。');
    return res.redirect('/admin/users');
  }
  if (target.role === 'superadmin') {
    req.flash('error', '不能修改超级管理员的真实姓名。');
    return res.redirect('/admin/users');
  }
  if (target.role === 'admin' && !req.user.isSuperAdmin) {
    req.flash('error', '只有超级管理员能提交管理员的改名申请。');
    return res.redirect('/admin/users');
  }
  if (target.real_name === realName) {
    req.flash('info', '新姓名与当前一致，无需修改。');
    return res.redirect('/admin/users');
  }

  const now = new Date().toISOString();
  const existing = db.get("SELECT id FROM rename_requests WHERE user_id = ? AND status = 'pending'", target.id);
  if (existing) {
    db.run('UPDATE rename_requests SET new_name = ?, created_at = ? WHERE id = ?', realName, now, existing.id);
  } else {
    db.run(
      "INSERT INTO rename_requests (user_id, old_name, new_name, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
      target.id, target.real_name, realName, now
    );
  }
  logModeration(req.user, 'rename_user', 'user', id, `为 ${target.nickname} 提交改名申请「${target.real_name}」→「${realName}」`);
  req.flash('success', `已为 ${target.nickname} 提交改名申请（「${target.real_name}」→「${realName}」），等待审核。`);
  res.redirect('/admin/users');
});

/** 帖子审核队列 */
router.get('/posts', (req, res) => {
  const tab = ['pending', 'flagged', 'approved', 'rejected', 'deleted', 'all'].includes(req.query.tab) ? req.query.tab : 'pending';
  const conditions = [];
  const params = [];
  if (tab === 'pending') conditions.push("p.status = 'pending'");
  else if (tab === 'all') conditions.push("p.status <> 'approved'");
  else {
    conditions.push('p.status = ?');
    params.push(tab);
  }

  const posts = db.all(
    `SELECT p.*, u.nickname, u.real_name, u.class_name, u.status AS author_status
       FROM posts p JOIN users u ON u.id = p.user_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.ai_risk DESC, p.created_at DESC LIMIT 200`,
    ...params
  );

  const counts = {
    pending: db.get("SELECT COUNT(*) AS c FROM posts WHERE status = 'pending'").c,
    flagged: db.get("SELECT COUNT(*) AS c FROM posts WHERE status = 'flagged'").c,
    approved: db.get("SELECT COUNT(*) AS c FROM posts WHERE status = 'approved'").c,
    rejected: db.get("SELECT COUNT(*) AS c FROM posts WHERE status = 'rejected'").c,
    deleted: db.get("SELECT COUNT(*) AS c FROM posts WHERE status = 'deleted'").c
  };

  res.render('admin/posts', { title: '帖子审核', posts, tab, counts });
});

router.post('/posts/:id/approve', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const post = db.get('SELECT * FROM posts WHERE id = ?', id);
  if (!post) {
    req.flash('error', '帖子不存在。');
    return res.redirect('/admin/posts');
  }
  db.run(
    "UPDATE posts SET status = 'approved', reviewed_by = ?, reviewed_at = ?, reject_reason = NULL, updated_at = ? WHERE id = ?",
    req.user.id, new Date().toISOString(), new Date().toISOString(), id
  );
  logModeration(req.user, 'approve_post', 'post', id, `通过帖子《${post.title}》`);
  req.flash('success', '已通过该帖，现在公开展示。');
  res.redirect(req.get('Referer') || '/admin/posts');
});

router.post('/posts/:id/reject', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const post = db.get('SELECT * FROM posts WHERE id = ?', id);
  if (!post) {
    req.flash('error', '帖子不存在。');
    return res.redirect('/admin/posts');
  }
  const reason = String(req.body.reason || '').trim().slice(0, 200) || '内容不符合班级论坛规范';
  db.run(
    "UPDATE posts SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?",
    reason, req.user.id, new Date().toISOString(), new Date().toISOString(), id
  );
  logModeration(req.user, 'reject_post', 'post', id, `驳回帖子《${post.title}》：${reason}`);
  req.flash('success', '已驳回该帖，作者可以看到驳回原因。');
  res.redirect(req.get('Referer') || '/admin/posts');
});

router.post('/posts/:id/delete', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const post = db.get('SELECT * FROM posts WHERE id = ?', id);
  if (!post) {
    req.flash('error', '帖子不存在。');
    return res.redirect('/admin/posts');
  }
  const reason = String(req.body.reason || '').trim().slice(0, 200) || '管理员删除';
  db.run(
    "UPDATE posts SET status = 'deleted', reject_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?",
    reason, req.user.id, new Date().toISOString(), new Date().toISOString(), id
  );
  logModeration(req.user, 'delete_post', 'post', id, `删除帖子《${post.title}》：${reason}`);
  req.flash('success', '帖子已删除。');
  res.redirect(req.get('Referer') || '/admin/posts');
});

/** 管理员编辑帖子内容（纠错、脱敏） */
router.get('/posts/:id/edit', (req, res, next) => {
  const post = db.get('SELECT * FROM posts WHERE id = ?', safeInt(req.params.id, 0));
  if (!post) return next();
  res.render('post-edit', { title: '编辑帖子（管理员）', post, adminMode: true });
});

/** 置顶 / 取消置顶 / 设为公告 */
router.post('/posts/:id/pin', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const post = db.get('SELECT * FROM posts WHERE id = ?', id);
  if (!post) {
    req.flash('error', '帖子不存在。');
    return res.redirect('/admin/posts');
  }
  const pin = post.pinned ? 0 : 1;
  db.run('UPDATE posts SET pinned = ?, updated_at = ? WHERE id = ?', pin, new Date().toISOString(), id);
  logModeration(req.user, pin ? 'pin_post' : 'unpin_post', 'post', id, `${pin ? '置顶' : '取消置顶'}《${post.title}》`);
  req.flash('success', pin ? '已置顶该帖。' : '已取消置顶。');
  res.redirect(req.get('Referer') || '/admin/posts');
});

router.post('/posts/:id/notice', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const post = db.get('SELECT * FROM posts WHERE id = ?', id);
  if (!post) {
    req.flash('error', '帖子不存在。');
    return res.redirect('/admin/posts');
  }
  const isNotice = post.is_notice ? 0 : 1;
  db.run(
    "UPDATE posts SET is_notice = ?, section = CASE WHEN ? = 1 THEN 'notice' ELSE section END, status = 'approved', updated_at = ? WHERE id = ?",
    isNotice, isNotice, new Date().toISOString(), id
  );
  logModeration(req.user, isNotice ? 'mark_notice' : 'unmark_notice', 'post', id, `${isNotice ? '设为' : '取消'}公告《${post.title}》`);
  req.flash('success', isNotice ? '已设为公告帖。' : '已取消公告标记。');
  res.redirect(req.get('Referer') || '/admin/posts');
});

/** 警告帖子 / 撤销警告（用户会看到醒目的黄色提示条） */
router.post('/posts/:id/warn', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const post = db.get('SELECT * FROM posts WHERE id = ?', id);
  if (!post) {
    req.flash('error', '帖子不存在。');
    return res.redirect('/admin/posts');
  }
  const reason = String(req.body.reason || '').trim().slice(0, 200);
  if (!reason) {
    req.flash('error', '请填写警告原因。');
    return res.redirect(req.get('Referer') || '/admin/posts');
  }
  db.run(
    'UPDATE posts SET warning_reason = ?, warning_at = ?, updated_at = ? WHERE id = ?',
    reason, new Date().toISOString(), new Date().toISOString(), id
  );
  logModeration(req.user, 'warn_post', 'post', id, `警告《${post.title}》：${reason}`);
  req.flash('success', '已向该帖作者发出警告提示。');
  res.redirect(req.get('Referer') || '/admin/posts');
});

router.post('/posts/:id/unwarn', (req, res) => {
  const id = safeInt(req.params.id, 0);
  db.run('UPDATE posts SET warning_reason = NULL, warning_at = NULL WHERE id = ?', id);
  logModeration(req.user, 'unwarn_post', 'post', id, '撤销帖子警告');
  req.flash('success', '已撤销警告。');
  res.redirect(req.get('Referer') || '/admin/posts');
});

/** 重新跑一次 AI 审核 */
router.post('/posts/:id/recheck', async (req, res) => {
  const id = safeInt(req.params.id, 0);
  const post = db.get('SELECT * FROM posts WHERE id = ?', id);
  if (!post) {
    req.flash('error', '帖子不存在。');
    return res.redirect('/admin/posts');
  }
  const assessment = await ai.moderatePost(post.title, post.content);
  db.run(
    `UPDATE posts SET ai_verdict = ?, ai_risk = ?, ai_labels = ?, ai_summary = ?, ai_source = ?,
            status = CASE WHEN status IN ('pending','flagged') THEN ? ELSE status END
      WHERE id = ?`,
    assessment.verdict, assessment.risk, JSON.stringify(assessment.labels), assessment.summary,
    assessment.source, assessment.verdict === 'clean' ? 'pending' : 'flagged', id
  );
  logModeration(req.user, 'recheck_post', 'post', id, `重新 AI 审核：${assessment.verdict}（风险 ${assessment.risk}）`);
  req.flash('success', `重新检测完成：${assessment.summary}`);
  res.redirect(req.get('Referer') || '/admin/posts');
});

/** 评论管理 */
router.get('/comments', (req, res) => {
  const tab = ['hidden', 'visible', 'deleted', 'all'].includes(req.query.tab) ? req.query.tab : 'hidden';
  const conditions = [];
  const params = [];
  if (tab === 'all') conditions.push("c.status <> 'deleted'");
  else if (tab === 'visible') conditions.push("c.status = 'visible'");
  else if (tab === 'hidden') conditions.push("c.status = 'hidden'");
  else {
    conditions.push('c.status = ?');
    params.push(tab);
  }

  const comments = db.all(
    `SELECT c.*, u.nickname, u.real_name, u.status AS author_status,
            p.title AS post_title, p.id AS post_id
       FROM comments c
       JOIN users u ON u.id = c.user_id
       JOIN posts p ON p.id = c.post_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.ai_risk DESC, c.created_at DESC LIMIT 200`,
    ...params
  );

  const counts = {
    hidden: db.get("SELECT COUNT(*) AS c FROM comments WHERE status = 'hidden'").c,
    visible: db.get("SELECT COUNT(*) AS c FROM comments WHERE status = 'visible'").c
  };

  res.render('admin/comments', { title: '评论管理', comments, tab, counts });
});

router.post('/comments/:id/approve', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const comment = db.get('SELECT * FROM comments WHERE id = ?', id);
  if (!comment) {
    req.flash('error', '评论不存在。');
    return res.redirect('/admin/comments');
  }
  db.run("UPDATE comments SET status = 'visible' WHERE id = ?", id);
  db.run(
    "UPDATE posts SET comment_count = (SELECT COUNT(*) FROM comments WHERE post_id = ? AND status = 'visible') WHERE id = ?",
    comment.post_id, comment.post_id
  );
  logModeration(req.user, 'approve_comment', 'comment', id, '通过被 AI 隐藏的评论');
  req.flash('success', '评论已放行展示。');
  res.redirect('/admin/comments');
});

router.post('/comments/:id/delete', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const comment = db.get('SELECT * FROM comments WHERE id = ?', id);
  if (!comment) {
    req.flash('error', '评论不存在。');
    return res.redirect('/admin/comments');
  }
  db.run("UPDATE comments SET status = 'deleted' WHERE id = ?", id);
  db.run(
    "UPDATE posts SET comment_count = (SELECT COUNT(*) FROM comments WHERE post_id = ? AND status = 'visible') WHERE id = ?",
    comment.post_id, comment.post_id
  );
  logModeration(req.user, 'delete_comment', 'comment', id, '管理员删除评论');
  req.flash('success', '评论已删除。');
  res.redirect('/admin/comments');
});

/** 举报处理 */
router.get('/reports', (req, res) => {
  const reports = db.all(
    `SELECT r.*, u.nickname AS reporter_name, u.real_name AS reporter_real_name,
            p.title AS post_title, p.status AS post_status,
            c.content AS comment_content, c.status AS comment_status, c.post_id AS comment_post_id
       FROM reports r
       JOIN users u ON u.id = r.reporter_id
       LEFT JOIN posts p ON r.target_type = 'post' AND p.id = r.target_id
       LEFT JOIN comments c ON r.target_type = 'comment' AND c.id = r.target_id
      ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 200`
  );
  res.render('admin/reports', { title: '举报处理', reports });
});

router.post('/reports/:id/resolve', (req, res) => {
  const id = safeInt(req.params.id, 0);
  const result = String(req.body.result || 'handled');
  db.run(
    "UPDATE reports SET status = ?, handled_by = ?, handled_at = ? WHERE id = ?",
    result === 'ignored' ? 'ignored' : 'handled', req.user.id, new Date().toISOString(), id
  );
  logModeration(req.user, 'handle_report', 'report', id, result === 'ignored' ? '举报不成立' : '举报已处理');
  req.flash('success', '举报状态已更新。');
  res.redirect('/admin/reports');
});

/** 操作日志 */
router.get('/logs', (req, res) => {
  const logs = db.all('SELECT * FROM moderation_logs ORDER BY created_at DESC LIMIT 300');
  res.render('admin/logs', { title: '审核日志', logs });
});

// ---------------------------------------------------------------------------
// 站点设置：编辑配置文件里的可修改项（页脚版权、备案号、功能开关等）
// ---------------------------------------------------------------------------

function configFileStatus() {
  const files = [
    { name: 'site.jsonc', desc: '站点信息、页脚版权/备案号、功能开关', path: path.join(settings.CONFIG_DIR, 'site.jsonc') },
    { name: 'sections.jsonc', desc: '论坛分区（增删板块、改名、设管理员专属）', path: path.join(settings.CONFIG_DIR, 'sections.jsonc') },
    { name: 'moderation.jsonc', desc: 'AI 审核关键词、权重与阈值', path: path.join(settings.CONFIG_DIR, 'moderation.jsonc') }
  ];
  return files.map((file) => ({
    ...file,
    exists: fs.existsSync(file.path),
    writable: (() => {
      try {
        if (fs.existsSync(file.path)) fs.accessSync(file.path, fs.constants.W_OK);
        else fs.accessSync(settings.CONFIG_DIR, fs.constants.W_OK);
        return true;
      } catch (_) {
        return false;
      }
    })()
  }));
}

/** 把后台表单转换成站点设置补丁（保存与还原共用） */
function buildSitePatch(body) {
  const str = (value, max = 200) => String(value ?? '').trim().slice(0, max);
  const lines = (value) => String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20);

  const links = lines(body.footerLinks).map((line) => {
    const [rawLabel, rawHref] = line.split('|').map((part) => (part || '').trim());
    if (!rawHref) return null;
    const href = /^(https?:)?\/\//i.test(rawHref) || rawHref.startsWith('/') ? rawHref : `/${rawHref}`;
    return { label: rawLabel || rawHref, href };
  }).filter(Boolean);

  return {
    siteName: str(body.siteName, 60) || settings.DEFAULT_SITE.siteName,
    siteTagline: str(body.siteTagline, 80),
    siteDescription: str(body.siteDescription, 300),
    welcomeMessage: str(body.welcomeMessage, 200),
    adminContact: str(body.adminContact, 120),
    footer: {
      copyright: str(body.footerCopyright, 500),
      icp: str(body.footerIcp, 120),
      police: str(body.footerPolice, 120),
      customText: str(body.footerCustomText, 400),
      extraLines: lines(body.footerExtraLines),
      links,
      showPoweredBy: body.footerShowPoweredBy === 'on' || body.footerShowPoweredBy === 'true',
      poweredByText: str(body.footerPoweredByText, 160)
    },
    features: {
      aiModeration: body.featureAiModeration === 'on' || body.featureAiModeration === 'true',
      aiAutoApprove: body.approvalMode !== 'manual',
      allowRegister: body.featureAllowRegister === 'on' || body.featureAllowRegister === 'true'
    }
  };
}

router.get('/settings', requireSuperAdmin, (req, res) => {
  const site = settings.getSite();
  const dbValue = settings.readDbSite();
  res.render('admin/settings', {
    title: '站点设置',
    site,
    ai: settings.getAiConfig(),
    rulesText: settings.getRulesContent(),
    files: configFileStatus(),
    sectionsCount: settings.getSections().length,
    ruleCount: settings.getModerationRules().categories.length,
    overrideKeys: dbValue ? Object.keys(dbValue) : []
  });
});

router.post('/settings', requireSuperAdmin, /* #demo-start */ demo.blockWrite(), /* #demo-end */ (req, res) => {
  const patch = buildSitePatch(req.body);
  const merged = settings.saveSiteToDb(patch);
  const written = settings.saveSiteToFile(merged);

  // 大模型接入配置（单独存 DB，不写进 config 文件，避免密钥泄漏到源码包）
  const str = (value, max = 300) => String(value ?? '').trim().slice(0, max);
  settings.saveAiToDb({
    enabled: req.body.aiEnabled === 'on' || req.body.aiEnabled === 'true',
    baseUrl: str(req.body.aiBaseUrl, 200),
    apiKey: str(req.body.aiApiKey, 300),
    model: str(req.body.aiModel, 80) || 'deepseek-chat',
    timeoutMs: Math.min(60000, Math.max(1000, Number.parseInt(req.body.aiTimeoutMs, 10) || 8000))
  });

  // 论坛规范文本（超级管理员可编辑，存 DB）
  settings.saveRulesContent(String(req.body.rulesText || ''));

  logModeration(req.user, 'update_settings', 'settings', null,
    `更新站点设置（页脚备案号：${patch.footer.icp || '空'}${written ? '' : '，配置文件只读未能写回'}）`);

  req.flash('success', written
    ? '设置已保存并立即生效，同时已写回 config/site.jsonc。'
    : '设置已保存并立即生效（config/site.jsonc 不可写，未写回文件）。');
  res.redirect('/admin/settings');
});

/**
 * 读取 config/site.jsonc 原文（超级管理员专用，纯文本返回）。
 * 供自动化测试在改配置前备份原文，避免测试内容永久留在配置文件里。
 */
router.get('/settings/raw', requireSuperAdmin, /* #demo-start */ demo.requireMaster('配置文件原文仅站长可读。'), /* #demo-end */ (req, res) => {
  const file = path.join(settings.CONFIG_DIR, 'site.jsonc');
  try {
    res.type('text/plain; charset=utf-8').send(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    res.status(404).send('配置文件不存在');
  }
});

/**
 * 还原 config/site.jsonc 原文（超级管理员专用）。
 * 供自动化测试与「误改配置」场景使用，避免测试把内容永久写进配置文件。
 */
router.post('/settings/restore', requireSuperAdmin, /* #demo-start */ demo.blockWrite(), /* #demo-end */ (req, res) => {
  if (req.get('x-requested-with') !== 'config-restore') {
    req.flash('error', '该接口仅供配置还原使用。');
    return res.redirect('/admin/settings');
  }
  const content = String(req.body.config || '');
  if (!content.trim() || content.length > 20000) {
    req.flash('error', '配置内容为空或过大，已忽略。');
    return res.redirect('/admin/settings');
  }
  const file = path.join(settings.CONFIG_DIR, 'site.jsonc');
  try {
    fs.writeFileSync(file, content, 'utf8');
    logModeration(req.user, 'restore_config', 'settings', null, '还原 config/site.jsonc 原文');
    req.flash('success', '配置文件已还原。');
  } catch (err) {
    req.flash('error', `还原失败：${err.message}`);
  }
  res.redirect('/admin/settings');
});

/** 重新加载 config/*.jsonc（直接改文件后用这个生效，不必重启服务） */
router.post('/settings/reload', requireSuperAdmin, /* #demo-start */ demo.blockWrite(), /* #demo-end */ (req, res) => {
  const site = settings.getSite();
  const sections = settings.getSections();
  const rules = settings.getModerationRules();
  logModeration(req.user, 'reload_config', 'settings', null,
    `重新加载配置文件（分区 ${sections.length} 个，审核类别 ${rules.categories.length} 个）`);
  req.flash('success', `配置已重新加载：站点名「${site.siteName}」，分区 ${sections.length} 个，审核类别 ${rules.categories.length} 个。`);
  res.redirect('/admin/settings');
});

/** 恢复默认：清空数据库里的覆盖值，回到 config/site.jsonc + 内置默认 */
router.post('/settings/reset', requireSuperAdmin, /* #demo-start */ demo.blockWrite(), /* #demo-end */ (req, res) => {
  db.run("DELETE FROM settings WHERE key = 'site'");
  logModeration(req.user, 'reset_settings', 'settings', null, '恢复站点设置为配置文件默认值');
  req.flash('success', '已恢复为 config/site.jsonc 中的设置。');
  res.redirect('/admin/settings');
});

module.exports = router;
