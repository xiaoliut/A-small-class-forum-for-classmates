'use strict';

/**
 * 构建脚本（npm run build）
 *
 * 本项目是服务端渲染的 Node 应用，没有前端编译/打包步骤。
 * 所以「构建」= 初始化数据库（建表 + 建初始管理员，幂等，可重复执行）。
 * 依赖安装由 `npm install` 完成，之后 `npm start` 即可启动。
 */

const db = require('./src/db');
const { init } = require('./src/init-db');

console.log('\n🔨 开始构建 班级论坛（无编译步骤，仅做数据库准备）\n');

const result = init({ force: false });

console.log(`✅ 构建完成：数据库已就绪 → ${db.file}（驱动 ${db.getDriverName()}）`);
if (result.seeded) {
  console.log('👤 已创建初始管理员：admin / admin123');
  console.log('ℹ️  管理员和同学账号由超级管理员登录后在后台「用户管理」里添加');
} else {
  console.log('ℹ️  数据库已存在，跳过种子数据（需要重置请运行 npm run reset-db）');
}
console.log('🚀 下一步：npm start 启动服务（默认 http://127.0.0.1:3000）\n');
db.close();
