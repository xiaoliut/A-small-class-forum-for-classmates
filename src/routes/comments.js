'use strict';

const express = require('express');
const db = require('../db');
const ai = require('../ai');
const {
  requireApproved,
  requireNotMuted,
  logModeration
} = require('../middleware/common');

const router = express.Router();

function isAdmin(user) {
  return user && (user.role === 'admin' || user.role === 'superadmin');
}

/** 解析并校验图片列表（只接受 /uploads/ 开头的地址，最多 9 张） */
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

/** 发表评论：AI 检测 + 违规内容先隐藏后复核 */
router.post('/posts/:id/comments', requireApproved, requireNotMuted, async (req, res, next) => {
  const postId = Number.parseInt(req.params.id, 10) || 0;
  const post = db.get('SELECT id, status FROM posts WHERE id = ?', postId);
  if (!post || (post.status !== 'approved' && !isAdmin(req.user))) {
    req.flash('error', '该帖子不存在或暂不可评论。');
    return res.redirect('/');
  }

  const content = String(req.body.content || '').trim();
  if (content.length < 2 || content.length > 1000) {
    req.flash('error', '评论长度需在 2-1000 字之间。');
    return res.redirect(`/posts/${postId}#comments`);
  }

  const assessment = await ai.moderateComment(content);
  const status = assessment.verdict === 'clean' ? 'visible' : 'hidden';
  const now = new Date().toISOString();
  const images = parseImages(req.body.images);

  const info = db.run(
    `INSERT INTO comments (post_id, user_id, content, images, status, ai_verdict, ai_risk, ai_labels,
                           ai_summary, ai_source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    postId, req.user.id, content, images, status, assessment.verdict, assessment.risk,
    JSON.stringify(assessment.labels), assessment.summary, assessment.source, now
  );

  db.run("UPDATE posts SET comment_count = comment_count + ? WHERE id = ?", status === 'visible' ? 1 : 0, postId);

  if (status === 'visible') {
    req.flash('success', '评论已发布。');
  } else {
    logModeration(null, 'auto_hide_comment', 'comment', info.lastInsertRowid,
      `AI 判定违规（${assessment.labels.join('、')}），自动隐藏待复核`);
    req.flash('info', assessment.advice || '这条评论被 AI 标记为可能违规，已先隐藏，等待管理员复核。');
  }

  res.redirect(`/posts/${postId}#comments`);
});

/** 删除自己的评论；管理员可删除任意评论 */
router.post('/comments/:id/delete', requireApproved, (req, res, next) => {
  const id = Number.parseInt(req.params.id, 10) || 0;
  const comment = db.get('SELECT * FROM comments WHERE id = ?', id);
  if (!comment) return next();

  const admin = isAdmin(req.user);
  if (comment.user_id !== req.user.id && !admin) {
    const err = new Error('只能删除自己的评论。');
    err.status = 403;
    err.expose = true;
    return next(err);
  }

  db.run("UPDATE comments SET status = 'deleted' WHERE id = ?", id);
  db.run(
    "UPDATE posts SET comment_count = (SELECT COUNT(*) FROM comments WHERE post_id = ? AND status = 'visible') WHERE id = ?",
    comment.post_id, comment.post_id
  );

  logModeration(req.user, admin ? 'delete_comment' : 'delete_own_comment', 'comment', id,
    `${admin ? '管理员' : '作者'}删除评论 #${id}`);

  req.flash('success', '评论已删除。');
  if (admin && req.body.from === 'admin') {
    return res.redirect('/admin/comments');
  }
  res.redirect(`/posts/${comment.post_id}#comments`);
});

/** 举报帖子或评论 */
router.post('/report', requireApproved, (req, res) => {
  const targetType = req.body.target_type === 'comment' ? 'comment' : 'post';
  const targetId = Number.parseInt(req.body.target_id, 10) || 0;
  const reason = String(req.body.reason || '').trim().slice(0, 40) || '其他';
  const detail = String(req.body.detail || '').trim().slice(0, 200);
  const back = String(req.body.back || '/');

  if (!targetId) {
    req.flash('error', '举报目标不存在。');
    return res.redirect(back);
  }

  const exists = targetType === 'post'
    ? db.get('SELECT id FROM posts WHERE id = ?', targetId)
    : db.get('SELECT id FROM comments WHERE id = ?', targetId);
  if (!exists) {
    req.flash('error', '举报目标不存在。');
    return res.redirect(back);
  }

  const duplicated = db.get(
    "SELECT id FROM reports WHERE target_type = ? AND target_id = ? AND reporter_id = ? AND status = 'open'",
    targetType, targetId, req.user.id
  );
  if (duplicated) {
    req.flash('info', '你已经举报过了，管理员会尽快处理。');
    return res.redirect(back);
  }

  db.run(
    `INSERT INTO reports (target_type, target_id, reporter_id, reason, detail, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    targetType, targetId, req.user.id, reason, detail || null, new Date().toISOString()
  );

  req.flash('success', '举报已提交，感谢你一起维护班级论坛的氛围。');
  res.redirect(back);
});

module.exports = router;
