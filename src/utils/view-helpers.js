'use strict';

/** 视图辅助：时间格式化、分区/状态徽章、页脚信息、查询串拼装 */

const config = require('../config');
const db = require('../db');
const settings = require('../settings');
/* #demo-start */
const demo = require('../demo');
/* #demo-end */

/** 当前生效的分区列表（来自 config/sections.jsonc） */
function getSections() {
  return settings.getSections();
}

const POST_STATUS = {
  pending: { name: '待审核', cls: 'badge--warn' },
  approved: { name: '已通过', cls: 'badge--ok' },
  flagged: { name: 'AI 风险待复核', cls: 'badge--danger' },
  rejected: { name: '已驳回', cls: 'badge--muted' },
  deleted: { name: '已删除', cls: 'badge--muted' },
  hidden: { name: '已隐藏', cls: 'badge--muted' }
};

const USER_STATUS = {
  pending: { name: '待审核', cls: 'badge--warn' },
  approved: { name: '正常', cls: 'badge--ok' },
  rejected: { name: '已驳回', cls: 'badge--muted' },
  banned: { name: '已封禁', cls: 'badge--danger' },
  disabled: { name: '已停用', cls: 'badge--muted' }
};

function parseTime(value) {
  if (!value) return null;
  const text = String(value);
  // SQLite 里存的是 ISO 串；兼容 "YYYY-MM-DD HH:MM:SS"
  const normalized = text.includes('T') ? text : text.replace(' ', 'T') + 'Z';
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? new Date(text) : date;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatTime(value) {
  const date = parseTime(value);
  if (!date || Number.isNaN(date.getTime())) return '—';
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return sameYear ? `${ymd.slice(5)} ${hm}` : `${ymd} ${hm}`;
}

function fromNow(value) {
  const date = parseTime(value);
  if (!date || Number.isNaN(date.getTime())) return '—';
  const diff = Date.now() - date.getTime();
  if (diff < 0) return '刚刚';
  const minute = 60000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return formatTime(value);
}

function sectionMeta(key) {
  return getSections().find((s) => s.key === key) || { key, name: key || '其他', icon: '', desc: '' };
}

function statusBadge(status) {
  return POST_STATUS[status] || { name: status, cls: 'badge--muted' };
}

function userStatusBadge(status) {
  return USER_STATUS[status] || { name: status, cls: 'badge--muted' };
}

function riskBadge(risk) {
  const value = Number(risk) || 0;
  if (value >= 60) return { name: `高风险 ${value}`, cls: 'badge--danger' };
  if (value >= 20) return { name: `需关注 ${value}`, cls: 'badge--warn' };
  return { name: `风险低 ${value}`, cls: 'badge--ok' };
}

function aiBadge(verdict) {
  const map = {
    clean: { name: 'AI 判定正常', cls: 'badge--ok' },
    review: { name: 'AI 建议复核', cls: 'badge--warn' },
    violation: { name: 'AI 判定违规', cls: 'badge--danger' },
    unchecked: { name: '未检测', cls: 'badge--muted' }
  };
  return map[verdict] || map.unchecked;
}

/** 保留当前筛选参数，生成分页/排序链接 */
function buildQuery(base, overrides = {}) {
  const params = new URLSearchParams();
  const merged = { ...(base || {}), ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * 组装页脚数据：版权、备案号、自定义底部文字、链接等
 * 全部来自 config/site.jsonc 或后台「站点设置」，改完立即生效。
 */
function buildFooter(site) {
  const footer = site.footer || {};
  const currentYear = new Date().getFullYear();

  // 版权支持多条，每行一条，都自动加「© 年份」前缀；
  // 每行格式：文字 或 文字|链接（链接可选，填了文字就可点击）。
  // 留空则默认一条「© 年份 站点名」。
  const rawCopyright = String(footer.copyright || '').trim();
  const copyrightLines = rawCopyright
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const copyrights = (copyrightLines.length ? copyrightLines : [site.siteName])
    .map((line) => {
      const sep = line.indexOf('|');
      const text = (sep >= 0 ? line.slice(0, sep) : line).trim() || line;
      const link = (sep >= 0 ? line.slice(sep + 1) : '').trim();
      return {
        prefix: `© ${currentYear} `,
        text,
        link: /^https?:\/\//i.test(link) ? link : null
      };
    });

  return {
    copyrights,
    icp: String(footer.icp || '').trim(),
    police: String(footer.police || '').trim(),
    customText: String(footer.customText || '').trim(),
    extraLines: (Array.isArray(footer.extraLines) ? footer.extraLines : [])
      .map((line) => String(line || '').trim())
      .filter(Boolean),
    links: (Array.isArray(footer.links) ? footer.links : [])
      .filter((link) => link && link.href)
      .map((link) => ({
        label: String(link.label || link.href),
        href: String(link.href),
        icon: link.icon ? String(link.icon) : ''
      })),
    showPoweredBy: footer.showPoweredBy !== false,
    poweredByText: String(footer.poweredByText || '').trim(),
    adminContact: String(site.adminContact || '').trim()
  };
}

/** 头像地址：有自定义头像返回图片 URL，否则返回空（模板回退到昵称首字） */
function avatarUrl(user) {
  if (user && user.avatar) return `/avatars/${user.avatar}`;
  return '';
}

/** 头像 HTML：有自定义头像输出 <img>，否则输出昵称首字的 <span> */
function avatarHtml(user, cls = '') {
  const name = (user && user.nickname) || '?';
  const url = avatarUrl(user);
  const classAttr = cls ? ` ${cls}` : '';
  if (url) {
    return `<img class="avatar${classAttr}" src="${url}" alt="" loading="lazy" width="26" height="26">`;
  }
  return `<span class="avatar${classAttr}">${name.slice(0, 1)}</span>`;
}

/** 解析帖子/评论的图片 JSON 字段为 URL 数组 */
function imageList(json) {
  try {
    const arr = typeof json === 'string' ? JSON.parse(json) : json;
    if (!Array.isArray(arr)) return [];
    return arr.map(String).filter((s) => s.startsWith('/uploads/'));
  } catch (_) {
    return [];
  }
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 论坛规范文本 → HTML（安全：全文转义）。
 * 规则：## 开头=标题；- 开头=无序列表项；数字. 开头=有序列表项；空行分段；其余=段落。
 */
function rulesToHtml(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const out = [];
  let list = null; // 'ul' | 'ol' | null

  function closeList() {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }
    if (line.startsWith('## ')) {
      closeList();
      out.push(`<h2>${escapeHtml(line.slice(3).trim())}</h2>`);
    } else if (line.startsWith('- ')) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${escapeHtml(line.slice(2).trim())}</li>`);
    } else if (/^\d+\.\s/.test(line)) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${escapeHtml(line.replace(/^\d+\.\s*/, ''))}</li>`);
    } else {
      closeList();
      out.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  closeList();
  return out.join('\n');
}

/** 每个页面都需要的公共变量 */
function commonLocals(req, res, next) {
  const site = settings.getSite();
  const sections = getSections();

  res.locals.site = site;
  res.locals.siteName = site.siteName;
  res.locals.footer = buildFooter(site);
  res.locals.sections = sections;
  res.locals.featureFlags = site.features;
/* #demo-start */
  res.locals.demoMode = config.demo.enabled;
  // 演示模式下：通过站长口令解锁过的会话才算「站长」，可以改站点设置
  res.locals.isMasterUser = demo.isMaster(req);
  res.locals.masterBase = '/' + config.demo.masterPath;
  // 登录页上显示的演示账号提示（留空则不显示）
  res.locals.loginHint = config.demo.loginHint;
  // 演示模式下，超管账号的资料/密码是锁定的（访客共用同一个账号）
  res.locals.masterProfileLocked = Boolean(
    config.demo.enabled && req.user && req.user.isSuperAdmin
  );
/* #demo-end */
  res.locals.userStatusBadge = userStatusBadge;
  res.locals.avatarUrl = avatarUrl;
  res.locals.avatarHtml = avatarHtml;
  res.locals.imageList = imageList;
  res.locals.rulesToHtml = rulesToHtml;
  res.locals.currentPath = req.path;
  res.locals.query = req.query || {};
  res.locals.activeSection = req.query?.section || '';
  res.locals.csrfInput = `<input type="hidden" name="_csrf" value="${res.locals.csrfToken || ''}">`;
  if (!Array.isArray(res.locals.flash)) res.locals.flash = [];

  // 顶栏所需的默认值（各视图可按需覆盖）
  res.locals.activeNav = '';
  res.locals.pendingBadge = 0;
  res.locals.hidePendingBanner = false;
  res.locals.title = site.siteName;

  // 管理员在导航上看到待办数量红点
  const user = res.locals.currentUser;
  if (user && user.isAdmin) {
    let renameCount = 0;
    let deletionCount = 0;
    try {
      const renameWhere = user.isSuperAdmin
        ? "r.status = 'pending'"
        : "r.status = 'pending' AND u.role = 'student'";
      renameCount = db.get(
        `SELECT COUNT(*) AS c FROM rename_requests r JOIN users u ON u.id = r.user_id WHERE ${renameWhere}`
      ).c;
      const delWhere = user.isSuperAdmin
        ? "d.status = 'pending'"
        : "d.status = 'pending' AND u.role = 'student'";
      deletionCount = db.get(
        `SELECT COUNT(*) AS c FROM account_deletion_requests d JOIN users u ON u.id = d.user_id WHERE ${delWhere}`
      ).c;
    } catch (_) {
      /* 表可能尚未创建 */
    }
    res.locals.pendingBadge =
      db.get("SELECT COUNT(*) AS c FROM users WHERE status = 'pending'").c +
      db.get("SELECT COUNT(*) AS c FROM posts WHERE status IN ('pending','flagged')").c +
      renameCount +
      deletionCount;
  }
  next();
}

module.exports = {
  POST_STATUS,
  USER_STATUS,
  getSections,
  formatTime,
  fromNow,
  parseTime,
  sectionMeta,
  statusBadge,
  userStatusBadge,
  riskBadge,
  aiBadge,
  buildQuery,
  buildFooter,
  avatarUrl,
  avatarHtml,
  imageList,
  rulesToHtml,
  escapeHtml,
  commonLocals
};
