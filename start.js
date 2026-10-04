'use strict';

/**
 * 后台启动脚本：node start.js
 *
 * 为什么需要它：某些受限的运行环境（例如本机的文件沙箱）不允许通过管道捕获
 * 子进程输出。这里把服务的 stdout/stderr 重定向到文件，并以 detached 方式启动，
 * 启动成功后父进程立即退出，服务继续独立运行。
 *
 * 日志：data/server.log（访问日志）、data/server.err.log（错误日志）
 * 停止：node stop.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const config = require('./src/config');

const OUT_LOG = path.join(config.dataDir, 'server.log');
const ERR_LOG = path.join(config.dataDir, 'server.err.log');
const PID_FILE = path.join(config.dataDir, 'server.pid');
const START_TIMEOUT_MS = 20000;

fs.mkdirSync(config.dataDir, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ping() {
  try {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function main() {
  const alive = await ping();
  if (alive?.ok) {
    console.log(`ℹ️  服务已经在运行：http://${config.host}:${config.port}`);
    return;
  }

  const out = fs.openSync(OUT_LOG, 'a');
  const err = fs.openSync(ERR_LOG, 'a');

  const child = spawn(process.execPath, [path.join(__dirname, 'app.js')], {
    cwd: __dirname,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
    env: process.env
  });
  child.unref();

  fs.writeFileSync(PID_FILE, String(child.pid));

  const deadline = Date.now() + START_TIMEOUT_MS;
  let ok = null;
  while (Date.now() < deadline) {
    await sleep(400);
    ok = await ping();
    if (ok?.ok) break;
  }

  if (ok?.ok) {
    console.log('');
    console.log('  🌿 班级论坛已启动');
    console.log(`  🔗 访问地址: http://${config.host}:${config.port}`);
    console.log(`  📄 进程 PID: ${child.pid}（记录在 ${PID_FILE}）`);
    console.log(`  🪵 日志文件: ${OUT_LOG}`);
    console.log('  ⏹  停止服务: node stop.js');
    console.log('');
  } else {
    console.error('❌ 启动超时，未能通过 /healthz 自检。请查看日志：');
    console.error(`   ${ERR_LOG}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
