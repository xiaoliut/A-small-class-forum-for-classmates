'use strict';

/**
 * 账号删除 / 销号生命周期
 *
 * 流程：
 *   提交申请（填理由）→ 审核通过 → 进入 7 天冷静期 → 到期软删除账号。
 *   超级管理员删除成员则直接软删除，不走申请。
 */

const db = require('./db');

const COOLING_DAYS = 7;

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/** 提交删除申请（返回申请 id；已有 pending/cooling 申请则复用） */
function submit(userId, requesterId, reason) {
  const existing = db.get(
    "SELECT id FROM account_deletion_requests WHERE user_id = ? AND status IN ('pending','cooling')",
    userId
  );
  if (existing) return existing.id;
  const now = new Date().toISOString();
  const info = db.run(
    "INSERT INTO account_deletion_requests (user_id, requester_id, reason, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
    userId, requesterId, String(reason || '').trim().slice(0, 200), now
  );
  return info.lastInsertRowid;
}

/** 审核通过 → 进入冷静期 */
function approve(requestId, reviewerId) {
  db.run(
    "UPDATE account_deletion_requests SET status = 'cooling', cooling_until = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?",
    daysFromNow(COOLING_DAYS), reviewerId, new Date().toISOString(), requestId
  );
}

/** 审核驳回 */
function reject(requestId, reviewerId) {
  db.run(
    "UPDATE account_deletion_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?",
    reviewerId, new Date().toISOString(), requestId
  );
}

/** 软删除账号：状态置 deleted，昵称改为「已注销」，清空敏感信息 */
function softDelete(userId) {
  db.run(
    "UPDATE users SET status = 'deleted', password_hash = '', nickname = '已注销', real_name = '已注销', email = NULL, phone = NULL, avatar = NULL, mute_until = NULL, ban_reason = NULL WHERE id = ?",
    userId
  );
}

/** 懒删除：冷静期到期则软删除账号，返回是否删除了 */
function processCooling(userId) {
  const row = db.get("SELECT * FROM account_deletion_requests WHERE user_id = ? AND status = 'cooling'", userId);
  if (!row || !row.cooling_until) return false;
  if (new Date(row.cooling_until).getTime() <= Date.now()) {
    softDelete(userId);
    db.run("UPDATE account_deletion_requests SET status = 'done' WHERE id = ?", row.id);
    return true;
  }
  return false;
}

module.exports = { COOLING_DAYS, submit, approve, reject, softDelete, processCooling };
