'use strict';

/**
 * 独立数据库初始化脚本：node init-db.js [--force]
 * （package.json 里的 npm run init-db / reset-db 都指向它）
 *
 * --force 会先删除 data/forum.db 再重建（干净状态，仅建账号，不灌演示帖子）。
 */

const db = require('./src/db');
const initDb = require('./src/init-db');

const force = process.argv.includes('--force');
const result = initDb.init({ force });

console.log(`✅ 数据库已就绪：${db.file}（驱动：${db.getDriverName()}）${force ? ' [已重置]' : ''}`);
if (result.seeded) {
  console.log('👤 超级管理员：admin / ' + result.adminPassword);
  console.log('ℹ️  管理员和同学账号请用超级管理员登录后，在后台「用户管理」里添加。');
} else {
  console.log('ℹ️  已存在超级管理员账号，跳过种子数据。加 --force 可重置为干净状态。');
}
db.close();
