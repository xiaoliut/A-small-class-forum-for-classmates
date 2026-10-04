'use strict';

const express = require('express');
const db = require('../db');
const ai = require('../ai');
const settings = require('../settings');
const viewHelpers = require('../utils/view-helpers');
const {
  requireApproved,
  requireNotMuted,
  logModeration
} = require('../middleware/common');

const router = express.Router();
const PAGE_SIZE = 8;

/** 解析并校验图片列表（只接受 /uploads/ 开头的地址，最多 9 张），返回可落库的 JSON 字符串或 null */
function parseImages(value) {
  try {
    const arr = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(arr)) return null;
    const list = arr
      .map((s) => String(s).trim())
      .filter((s) => s.startsWith('/uploads/'))
      .slice(0, 9);
    return list.length ? JSON.stringify(list) : null;
  } catch (_) {
    return null;
  }
}

/** 解析并校验封面图（单个 /uploads/ 开头的地址，图片或动图） */
function parseCover(value) {
  const s = String(value || '').trim();
  return s.startsWith('/uploads/') ? s : null;
}

/** 当前生效的分区列表（来自 config/sections.jsonc） */
function sections() {
  return viewHelpers.getSections();
}

function sectionKey(value) {
  return sections().some((item) => item.key === value) ? value : '';
}

/** 该分区是否只允许管理员发帖 */
function isAdminOnlySection(key) {
  const meta = sections().find((item) => item.key === key);
  return Boolean(meta && meta.adminOnly);
}

function safeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isAdmin(user) {
  return user && (user.role === 'admin' || user.role === 'superadmin');
}

/** 帖子列表（独立页面，支持分区与关键词筛选） */
router.get('/', (req, res) => {
  const section = sectionKey(req.query.section);
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

  const posts = db.all(
    `SELECT p.*, u.nickname, u.role AS author_role
       FROM posts p JOIN users u ON u.id = p.user_id
      WHERE ${where}
      ORDER BY p.pinned DESC, p.created_at DESC
      LIMIT ? OFFSET ?`,
    ...params, PAGE_SIZE, (currentPage - 1) * PAGE_SIZE
  );

  res.render('posts', {
    title: '全部帖子',
    posts,
    section,
    keyword,
    page: currentPage,
    totalPages,
    total,
    baseQuery: { section, q: keyword }
  });
});

/** 发帖页面 */
router.get('/new', requireApproved, requireNotMuted, (req, res) => {
  const requested = sectionKey(req.query.section);
  const noticeOnly = requested && isAdminOnlySection(requested) && !isAdmin(req.user);
  res.render('post-new', {
    title: '发帖',
    form: {
      title: '',
      content: '',
      section: requested && !(isAdminOnlySection(requested) && !isAdmin(req.user)) ? requested : (sections()[0]?.key || 'general')
    },
    noticeOnly
  });
});

/** 发帖：先过 AI 辅助审核，再决定是否需要人工复核 */
router.post('/', requireApproved, requireNotMuted, async (req, res) => {
  const title = String(req.body.title || '').trim();
  const content = String(req.body.content || '').trim();
  let section = sectionKey(req.body.section) || (sections()[0]?.key || 'general');

  if (isAdminOnlySection(section) && !isAdmin(req.user)) {
    const fallback = sections().find((item) => !item.adminOnly);
    req.flash('error', `「${viewHelpers.sectionMeta(section).name}」分区仅管理员可以发布，已自动改为${fallback ? `「${fallback.name}」` : '默认分区'}。`);
    section = fallback ? fallback.key : section;
  }

  const errors = [];
  if (title.length < 4 || title.length > 80) errors.push('标题长度需为 4-80 个字符。');
  if (content.length < 5) errors.push('正文至少 5 个字符。');
  if (content.length > 5000) errors.push('正文请控制在 5000 字以内。');

  if (errors.length) {
    req.flash('error', errors.join(' '));
    return res.status(400).render('post-new', {
      title: '发帖',
      form: { title, content, section },
      noticeOnly: false
    });
  }

  let assessment;
  let status;
  if (settings.getSite().features.aiModeration === false) {
    // AI 审核关闭 = 纯人工审核，所有帖子直接转待审队列
    assessment = {
      verdict: 'unchecked', risk: 0, labels: ['待人工审核'],
      summary: 'AI 审核已关闭，帖子转人工审核。', source: 'disabled', advice: null
    };
    status = 'pending';
  } else {
    assessment = await ai.moderatePost(title, content);
    // AI 判定正常且站点开启了自动通过时才直接公开，否则一律转人工复核
    const autoApprove = ai.shouldAutoApprove();
    status = assessment.verdict === 'clean'
      ? (autoApprove ? 'approved' : 'pending')
      : assessment.verdict === 'violation' ? 'flagged' : 'pending';
  }
  const now = new Date().toISOString();
  const images = parseImages(req.body.images);
  const cover = parseCover(req.body.cover);

  const info = db.run(
    `INSERT INTO posts (user_id, section, title, content, images, cover, status, ai_verdict, ai_risk, ai_labels,
                        ai_summary, ai_source, author_class, warning_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    req.user.id, section, title, content, images, cover, status,
    assessment.verdict, assessment.risk, JSON.stringify(assessment.labels),
    assessment.summary, assessment.source, req.user.class_name,
    assessment.advice, now, now
  );

  const postId = info.lastInsertRowid;

  // 分区建议（不改动用户选择，只给提示）
  const suggestion = ai.suggestSection(title, content, section);

  if (status === 'approved') {
    if (suggestion) {
      req.flash('success', `发布成功，已通过 AI 审核。小提示：这篇内容看起来更适合「${viewHelpers.sectionMeta(suggestion).name}」分区。`);
    } else {
      req.flash('success', '发布成功，已通过 AI 审核并公开展示。');
    }
    return res.redirect(`/posts/${postId}`);
  }

  if (assessment.verdict === 'clean') {
    req.flash('info', '帖子已提交，本站开启了「先审后发」，管理员确认后即可公开展示。');
    return res.redirect(`/posts/${postId}/review`);
  }

  req.flash('info', '帖子已提交，需要管理员确认后才会公开展示。');
  return res.redirect(`/posts/${postId}/review`);
});

/** 待审核结果页：告诉发帖人 AI 检测到什么 */
router.get('/:id/review', requireApproved, (req, res, next) => {
  const post = db.get(
    `SELECT p.*, u.nickname FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
    safeInt(req.params.id, 0)
  );
  if (!post) return next();
  if (post.user_id !== req.user.id && !isAdmin(req.user)) {
    const err = new Error('只有作者本人或管理员可以查看该帖的审核详情。');
    err.status = 403;
    err.expose = true;
    return next(err);
  }
  let labels = [];
  try {
    labels = JSON.parse(post.ai_labels || '[]');
  } catch (_) {
    labels = [];
  }
  res.render('post-review', { title: '审核结果', post, labels });
});

/** 帖子详情 */
router.get('/:id', (req, res, next) => {
  const id = safeInt(req.params.id, 0);
  const post = db.get(
    `SELECT p.*, u.nickname, u.real_name, u.school, u.class_name, u.avatar,
            u.role AS author_role, u.status AS author_status, u.mute_until
       FROM posts p JOIN users u ON u.id = p.user_id
      WHERE p.id = ?`,
    id
  );
  if (!post) return next();

  const canSeeHidden = isAdmin(req.user) || (req.user && req.user.id === post.user_id);
  if (post.status !== 'approved' && !canSeeHidden) {
    req.flash('info', '该帖还在审核中，暂时无法查看。');
    return res.redirect('/');
  }

  db.run('UPDATE posts SET view_count = view_count + 1 WHERE id = ?', id);
  post.view_count += 1;

  const comments = db.all(
    `SELECT c.*, u.nickname, u.real_name, u.avatar, u.role AS author_role,
            u.status AS author_status
       FROM comments c JOIN users u ON u.id = c.user_id
      WHERE c.post_id = ? AND (c.status = 'visible' OR ? = 1 OR c.user_id = ?)
      ORDER BY c.created_at ASC`,
    id,
    (req.user && (isAdmin(req.user) || req.user.id === post.user_id)) ? 1 : 0,
    req.user ? req.user.id : -1
  );

  let labels = [];
  try {
    labels = JSON.parse(post.ai_labels || '[]');
  } catch (_) {
    labels = [];
  }

  // 同分区相关帖子
  const related = db.all(
    `SELECT id, title, created_at, comment_count FROM posts
      WHERE status = 'approved' AND section = ? AND id <> ?
      ORDER BY created_at DESC LIMIT 5`,
    post.section, id
  );

  // 上一篇 / 下一篇（按时间）
  const prev = db.get(
    "SELECT id, title FROM posts WHERE status = 'approved' AND created_at < ? ORDER BY created_at DESC LIMIT 1",
    post.created_at
  );
  const nextPost = db.get(
    "SELECT id, title FROM posts WHERE status = 'approved' AND created_at > ? ORDER BY created_at ASC LIMIT 1",
    post.created_at
  );

  res.render('post-detail', {
    title: post.title,
    post,
    labels,
    comments,
    related,
    prev,
    nextPost,
    isAuthor: Boolean(req.user && req.user.id === post.user_id),
    canModerate: isAdmin(req.user)
  });
});

/** 编辑自己的帖子（管理员可编辑任意帖子） */
router.get('/:id/edit', requireApproved, (req, res, next) => {
  const post = db.get('SELECT * FROM posts WHERE id = ?', safeInt(req.params.id, 0));
  if (!post) return next();
  if (post.user_id !== req.user.id && !isAdmin(req.user)) {
    const err = new Error('只能编辑自己发布的帖子。');
    err.status = 403;
    err.expose = true;
    return next(err);
  }
  res.render('post-edit', { title: '编辑帖子', post, adminMode: isAdmin(req.user) });
});

router.post('/:id/edit', requireApproved, requireNotMuted, async (req, res, next) => {
  const id = safeInt(req.params.id, 0);
  const post = db.get('SELECT * FROM posts WHERE id = ?', id);
  if (!post) return next();
  const admin = isAdmin(req.user);
  if (post.user_id !== req.user.id && !admin) {
    const err = new Error('只能编辑自己发布的帖子。');
    err.status = 403;
    err.expose = true;
    return next(err);
  }

  const title = String(req.body.title || '').trim();
  const content = String(req.body.content || '').trim();
  const section = sectionKey(req.body.section) || post.section;

  if (title.length < 4 || title.length > 80 || content.length < 5) {
    req.flash('error', '标题需 4-80 字，正文至少 5 字。');
    return res.status(400).render('post-edit', { title: '编辑帖子', post: { ...post, title, content, section }, adminMode: admin });
  }

  const assessment = await ai.moderatePost(title, content);
  const now = new Date().toISOString();
  // 普通成员编辑后重新进入审核；管理员编辑直接通过
  let status = post.status;
  if (admin) {
    status = 'approved';
  } else if (post.status === 'rejected' || assessment.verdict !== 'clean') {
    status = assessment.verdict === 'violation' ? 'flagged' : 'pending';
  }

  db.run(
    `UPDATE posts SET title = ?, content = ?, section = ?, status = ?, ai_verdict = ?, ai_risk = ?,
            ai_labels = ?, ai_summary = ?, ai_source = ?, warning_reason = ?,
            admin_edited = ?, edited_at = ?, updated_at = ?
      WHERE id = ?`,
    title, content, section, status, assessment.verdict, assessment.risk,
    JSON.stringify(assessment.labels), assessment.summary, assessment.source, assessment.advice,
    admin ? 1 : post.admin_edited, now, now, id
  );

  if (admin) {
    logModeration(req.user, 'edit_post', 'post', id, '管理员编辑帖子内容');
    req.flash('success', '已保存修改（管理员编辑直接生效并记为已通过）。');
  } else {
    req.flash('success', '已保存修改，正在重新审核。');
  }
  res.redirect(`/posts/${id}`);
});

/** 删除自己的帖子；管理员可删除任意帖子（软删除，保留审计痕迹） */
router.post('/:id/delete', requireApproved, (req, res, next) => {
  const id = safeInt(req.params.id, 0);
  const post = db.get('SELECT * FROM posts WHERE id = ?', id);
  if (!post) return next();

  const admin = isAdmin(req.user);
  if (post.user_id !== req.user.id && !admin) {
    const err = new Error('只能删除自己发布的帖子。');
    err.status = 403;
    err.expose = true;
    return next(err);
  }

  const reason = String(req.body.reason || '').trim().slice(0, 200);
  if (admin) {
    db.run(
      "UPDATE posts SET status = 'deleted', reject_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?",
      reason || '管理员删除', req.user.id, new Date().toISOString(), new Date().toISOString(), id
    );
    logModeration(req.user, 'delete_post', 'post', id, `删除帖子：${post.title}${reason ? `（${reason}）` : ''}`);
    req.flash('success', `已删除帖子《${post.title}》。`);
    return res.redirect('/admin/posts');
  }

  db.run("UPDATE posts SET status = 'deleted', reject_reason = '作者自行删除', updated_at = ? WHERE id = ?", new Date().toISOString(), id);
  logModeration(req.user, 'delete_own_post', 'post', id, `作者删除自己的帖子：${post.title}`);
  req.flash('success', '帖子已删除。');
  res.redirect('/me/posts');
});

module.exports = router;
