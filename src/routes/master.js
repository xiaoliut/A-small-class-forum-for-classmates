'use strict';

/**
 * 站长控制台（演示模式专用）。
 *
 * 路径由 .env 的 MASTER_PATH 决定（默认 /master），进入还需要 MASTER_KEY 口令。
 * 演示模式下所有请求都会被自动登录接管，只有这个入口例外 ——
 * 站长在这里可以正常输账号密码登录，登录后仍是超管身份。
 */

const express = require('express');
const config = require('../config');
const demo = require('../demo');
const { safeEqual } = require('../middleware/common');

const router = express.Router();
const BASE = '/' + config.demo.masterPath;

if (config.demo.enabled && config.demo.masterPath) {
  /** 是否已通过口令校验（没配口令时视为已通过，只靠路径隐蔽） */
  function unlocked(req) {
    if (!config.demo.masterKey) return true;
    return demo.isMaster(req);
  }

  router.use((req, res, next) => {
    res.locals.masterBase = BASE;
    next();
  });

  /**
   * 站长路径下挂载整套后台：/master/admin/xxx
   * 需要先通过口令解锁，之后就是完整的后台（含站点设置，可正常保存）。
   */
  router.use(
    BASE + '/admin',
    (req, res, next) => {
      if (!unlocked(req)) {
        req.flash('error', '请先输入口令解锁。');
        return res.redirect(BASE);
      }
      return next();
    },
    require('./admin')
  );

  /** 站长面板：未解锁看口令页，已解锁未登录看登录页，已登录超管看控制台 */
  router.get(BASE, (req, res) => {
    if (!unlocked(req)) {
      return res.render('master', { title: '站长入口', status: null, locked: true, loginHint: '' });
    }
    const isMaster = req.user && req.user.isSuperAdmin;
    res.render('master', {
      title: isMaster ? '站长控制台' : '站长入口',
      status: isMaster ? demo.getStatus() : null,
      locked: false,
      loginHint: config.demo.loginHint,
      masterKeyConfigured: Boolean(config.demo.masterKey)
    });
  });

  /** 提交口令 */
  router.post(BASE + '/unlock', (req, res) => {
    if (!config.demo.masterKey) return res.redirect(BASE);
    if (safeEqual(config.demo.masterKey, String(req.body.key || ''))) {
      demo.grantMaster(req, res);
      req.flash('success', '已解锁站长控制台（这台设备 7 天内不用再输口令）。');
    } else {
      req.flash('error', '口令不正确。');
    }
    res.redirect(BASE);
  });

  /** 重新锁定 */
  router.post(BASE + '/lock', (req, res) => {
    demo.revokeMaster(req, res);
    req.flash('info', '已锁定站长控制台。');
    res.redirect(BASE);
  });

  /** 立即清场 */
  router.post(BASE + '/clean', (req, res) => {
    if (!req.user || !req.user.isSuperAdmin) {
      req.flash('error', '请先以站长身份登录。');
      return res.redirect(BASE);
    }
    if (!unlocked(req)) {
      req.flash('error', '请先输入口令解锁。');
      return res.redirect(BASE);
    }
    const stat = demo.cleanup();
    req.flash(
      'success',
      stat
        ? `已清场：帖子 ${stat.posts} 条、评论 ${stat.comments} 条、账号 ${stat.users} 个（保留公告 ${stat.kept} 条）。`
        : '清场失败：没找到超级管理员账号。'
    );
    res.redirect(BASE);
  });
}

module.exports = router;
