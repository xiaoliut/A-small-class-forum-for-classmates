'use strict';

const express = require('express');
const db = require('../db');
const viewHelpers = require('../utils/view-helpers');
const settings = require('../settings');

const router = express.Router();
const PAGE_SIZE = 8;

function safeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 首页：公告 + 帖子列表（时间倒序，置顶优先）+ 统计 */
router.get('/', (req, res) => {
  const validSections = viewHelpers.getSections().map((item) => item.key);
  const section = validSections.includes(req.query.section) ? req.query.section : '';
  const keyword = String(req.query.q || '').trim().slice(0, 40);
  const page = Math.max(1, safeInt(req.query.page, 1));

  const conditions = ["p.status = 'approved'"];
  const params = [];
  if (section) {
    conditions.push('p.section = ?');
    params.push(section);
  }
  if (keyword) {
    conditions.push('(p.title LIKE ? OR p.content LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  const where = conditions.join(' AND ');

  const total = db.get(`SELECT COUNT(*) AS c FROM posts p WHERE ${where}`, ...params).c;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const posts = db.all(
    `SELECT p.*, u.nickname, u.class_name, u.school, u.avatar, u.role AS author_role,
            u.status AS author_status
       FROM posts p
       JOIN users u ON u.id = p.user_id
      WHERE ${where}
      ORDER BY p.pinned DESC, p.created_at DESC
      LIMIT ? OFFSET ?`,
    ...params, PAGE_SIZE, offset
  );

  const pinnedNotices = db.all(
    `SELECT p.*, u.nickname FROM posts p JOIN users u ON u.id = p.user_id
      WHERE p.status = 'approved' AND p.is_notice = 1
      ORDER BY p.created_at DESC LIMIT 3`
  );

  const stats = {
    members: db.get("SELECT COUNT(*) AS c FROM users WHERE status = 'approved'").c,
    posts: db.get("SELECT COUNT(*) AS c FROM posts WHERE status = 'approved'").c,
    comments: db.get("SELECT COUNT(*) AS c FROM comments WHERE status = 'visible'").c,
    today: db.get(
      "SELECT COUNT(*) AS c FROM posts WHERE status = 'approved' AND created_at >= ?",
      new Date(Date.now() - 86400000).toISOString()
    ).c
  };

  const activeMembers = db.all(
    `SELECT id, nickname, class_name, role, avatar,
            (SELECT COUNT(*) FROM posts WHERE user_id = users.id AND status = 'approved') AS post_count
       FROM users
      WHERE status = 'approved'
      ORDER BY post_count DESC, id ASC
      LIMIT 6`
  );

  res.render('index', {
    title: '首页',
    posts,
    pinnedNotices,
    stats,
    activeMembers,
    section,
    keyword,
    page: currentPage,
    totalPages,
    total,
    baseQuery: { section, q: keyword }
  });
});

/** 分区总览 */
router.get('/sections', (req, res) => {
  const rows = db.all(
    `SELECT section, COUNT(*) AS c FROM posts WHERE status = 'approved' GROUP BY section`
  );
  const counts = Object.fromEntries(rows.map((r) => [r.section, r.c]));
  res.render('sections', { title: '分区导航', counts });
});

/** 论坛规范 */
router.get('/rules', (req, res) => {
  res.render('rules', { title: '论坛规范', rulesText: settings.getRulesContent() });
});

/** 申请待审核提示页 */
router.get('/pending', (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (req.user.status === 'approved') return res.redirect('/');
  res.render('pending', { title: '等待管理员审核' });
});

/** 被封禁提示页 */
router.get('/banned', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.render('banned', { title: '账号已被封禁' });
});

/** 健康检查，方便部署后确认服务存活 */
router.get('/healthz', (req, res) => {
  const row = db.get('SELECT 1 AS ok');
  res.json({ ok: row?.ok === 1, time: new Date().toISOString() });
});

module.exports = router;
