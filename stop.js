'use strict';

/**
 * 停止后台服务：node stop.js
 * 依据 data/server.pid 记录的进程号关闭服务。
 */

const fs = require('fs');
const path = require('path');

const config = require('./src/config');

const PID_FILE = path.join(config.dataDir, 'server.pid');

function readPid() {
  if (!fs.existsSync(PID_FILE)) return null;
  const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  return Number.isFinite(pid) ? pid : null;
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function main() {
  const pid = readPid();

  // 没有 PID 文件时，尝试通过健康检查提示用户
  try {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: AbortSignal.timeout(1200) });
    if (response.ok && !pid) {
      console.log(`⚠️  检测到 http://${config.host}:${config.port} 仍有服务在响应，但没有找到 ${PID_FILE}。`);
      console.log('   请手动结束对应的 node 进程。');
      return;
    }
  } catch (_) {
    if (!pid) {
      console.log('ℹ️  服务当前没有在运行。');
      return;
    }
  }

  if (!pid || !isRunning(pid)) {
    console.log('ℹ️  服务当前没有在运行。');
    fs.rmSync(PID_FILE, { force: true });
    return;
  }

  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!isRunning(pid)) break;
  }
  if (isRunning(pid)) {
    process.kill(pid, 'SIGKILL');
    console.log(`⚠️  进程 ${pid} 未正常退出，已强制结束。`);
  } else {
    console.log(`✅ 服务已停止（PID ${pid}）。`);
  }
  fs.rmSync(PID_FILE, { force: true });
}

main().catch((err) => {
  console.error('停止服务失败：', err);
  process.exit(1);
});
