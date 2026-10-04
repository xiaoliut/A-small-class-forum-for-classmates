'use strict';

/** 最终验收：检查服务存活与示例数据状态 */
const http = require('http');

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 3000, path, agent: false, headers: { Connection: 'close' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

(async () => {
  const health = await get('/healthz');
  console.log('健康检查:', health.status, health.text.trim());

  const home = await get('/');
  console.log('首页:', home.status, '长度', home.text.length);
  for (const needle of ['班级论坛', '【必读】班级论坛使用规范', '这周的数学周测', '运动会报名表', '班级数据']) {
    console.log(`  包含「${needle}」:`, home.text.includes(needle));
  }
  console.log('  未泄漏待审帖:', !home.text.includes('闲置教辅资料转让'));
  console.log('  未泄漏已删测试帖:', !home.text.includes('冒烟测试'));

  const db = require('../src/db');
  const stats = {
    用户: db.get('SELECT COUNT(*) AS c FROM users').c,
    待审申请: db.get("SELECT COUNT(*) AS c FROM users WHERE status='pending'").c,
    帖子: db.get('SELECT COUNT(*) AS c FROM posts').c,
    待审帖子: db.get("SELECT COUNT(*) AS c FROM posts WHERE status IN ('pending','flagged')").c,
    评论: db.get("SELECT COUNT(*) AS c FROM comments WHERE status='visible'").c,
    举报: db.get('SELECT COUNT(*) AS c FROM reports').c,
    日志: db.get('SELECT COUNT(*) AS c FROM moderation_logs').c
  };
  console.log('数据库状态:', JSON.stringify(stats, null, 0));
  db.close();
})();
