'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { requireLogin, verifyCsrf } = require('../middleware/common');

const router = express.Router();

// ---------------------------------------------------------------------------
// 帖子/评论图片上传：只允许图片（含 GIF 动图），不支持文件、视频
// ---------------------------------------------------------------------------
const UPLOAD_DIR = path.join(config.dataDir, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      cb(null, name);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.includes(ext)) cb(null, true);
    else cb(new Error('只支持图片（jpg / png / gif / webp），不支持文件、视频。'));
  }
});

router.post('/', requireLogin, (req, res) => {
  upload.array('files', 9)(req, res, (err) => {
    if (err) {
      return res.status(400).json({ ok: false, error: err.message || '上传失败，请检查文件类型或大小。' });
    }
    // multipart 的 CSRF 由这里手动校验
    if (!verifyCsrf(req)) {
      (req.files || []).forEach((f) => fs.rmSync(f.path, { force: true }));
      return res.status(403).json({ ok: false, error: '表单已过期，请刷新页面后重试。' });
    }
    const files = (req.files || []).map((f) => ({
      url: `/uploads/${f.filename}`,
      name: f.originalname
    }));
    if (!files.length) return res.status(400).json({ ok: false, error: '没有收到图片文件。' });
    res.json({ ok: true, files });
  });
});

module.exports = router;
