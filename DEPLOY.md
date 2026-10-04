# 部署指南

班级论坛是一个 **Node.js + Express + SQLite + EJS** 的轻量应用，几乎没有外部服务依赖，部署很简单。本文覆盖本地开发、Linux 服务器生产部署（systemd + Nginx）两种方式。

---

## 一、环境要求

- **Node.js ≥ 18**（推荐 **Node 22+**，内置 SQLite 驱动，零编译更省事）
- 可选：Nginx（域名反代 / HTTPS）、系统工具 `python3 make g++`（仅当用老版本 Node 需要编译 `better-sqlite3` 时才要）

> 数据库驱动说明：程序**优先用 Node 22.5+ 内置的 `node:sqlite`**（无需任何编译），只有在老版本 Node 上才回退到 `better-sqlite3`（需要编译）。所以强烈建议直接用 Node 22+。

---

## 二、本地快速启动（开发 / 试运行）

```bash
# 1. 进入项目目录
cd class-forum

# 2. 安装依赖（--omit=dev 跳过部署工具，生产也这样装）
npm install --omit=dev

# 3.（可选）复制配置模板，按需修改
cp .env.example .env

# 4. 初始化数据库（建表 + 创建初始超级管理员账号）
node init-db.js

# 5. 启动服务
npm start          # 前台运行，Ctrl+C 停止
# 或
node start.js      # 后台运行，日志写 data/server.log，停止用 node stop.js
```

启动后访问：<http://127.0.0.1:3000>

初始超级管理员：`admin / admin123`（登录后**务必先改密码**）。

---

## 三、Linux 服务器部署（推荐，生产环境）

以 Debian / Ubuntu 为例，假设项目放在 `/www/wwwroot/class-forum`，服务端口 3000。

### 1. 安装 Node.js 22

```bash
# 用 NodeSource 装 Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node -v   # 确认 ≥ 22
```

### 2. 上传代码

```bash
# 本地把源码上传到服务器（scp 或宝塔面板文件上传均可）
scp -r class-forum root@你的服务器IP:/www/wwwroot/
cd /www/wwwroot/class-forum
```

### 3. 安装依赖 + 初始化

```bash
cd /www/wwwroot/class-forum
npm install --omit=dev
node init-db.js          # 建表 + 初始管理员
```

### 4. 配置 .env

```bash
cp .env.example .env
nano .env
```

必改项：

```
HOST=127.0.0.1            # 只监听本机，由 Nginx 转发（不要直接暴露 0.0.0.0）
PORT=3000
SITE_NAME=班级论坛        # 改成你的论坛名
SESSION_SECRET=改成一段很长的随机字符串
```

> 生成随机密钥：`openssl rand -hex 32`

### 5. 用 systemd 守护进程（开机自启、崩溃自动拉起）

创建服务文件：

```bash
cat > /etc/systemd/system/class-forum.service <<'EOF'
[Unit]
Description=Class Forum
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/www/wwwroot/class-forum
ExecStart=/usr/bin/node app.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
```

> 把 `User=` 换成实际运行用户（如 `www` 或 `www-data`），并确保该用户对项目目录和 `data/` 有读写权限。

启动：

```bash
systemctl daemon-reload
systemctl enable --now class-forum
systemctl status class-forum     # 看是否 active (running)
```

### 6. Nginx 反向代理 + 域名

```bash
nano /etc/nginx/conf.d/class-forum.conf
```

写入：

```nginx
server {
    listen 80;
    server_name 你的域名;    # 例如 forum.example.com

    client_max_body_size 20m;   # 头像/图片上传，放宽一点

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
nginx -t && systemctl reload nginx
```

### 7.（可选）HTTPS

- **宝塔面板**：网站 → 设置 → SSL → Let's Encrypt 一键申请。
- **certbot 命令行**：

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d 你的域名
```

---

## 四、登录后要做的几件事

1. **改密码**：`admin` 登录 → 个人中心 → 修改密码。
2. **站点设置**：管理后台 →「站点设置」：
   - 站点名、欢迎语、副标题
   - 页脚版权（默认「杂鱼科技-杂鱼工作室」+ zayukeji.top，可换成你自己的）
   - 审批模式（AI 自动审批 / 全人工审批）
   - 论坛规范（/rules 页面的内容）
3. **添加管理员 / 同学**：后台「用户管理」→ 设为管理员；同学在注册页申请后你在「入班申请」通过。

---

## 五、更新代码

```bash
cd /www/wwwroot/class-forum
# 覆盖新代码后
npm install --omit=dev     # 如果依赖有变化
systemctl restart class-forum
```

数据库结构会自动迁移（启动时自动补新字段），不需要手动操作。

---

## 六、常用命令

| 操作 | 命令 |
| --- | --- |
| 初始化数据库（幂等） | `node init-db.js` |
| 重置数据库（清空重来） | `node init-db.js --force` |
| 前台启动 | `npm start` |
| 后台启动 / 停止 | `node start.js` / `node stop.js` |
| 查看服务日志 | `journalctl -u class-forum -f` |
| 跑测试 | `npm test` |

---

## 七、常见问题

**1. `better-sqlite3` 编译失败？**
用 Node 22+ 即可，程序会直接用内置 `node:sqlite`，不依赖编译。或装编译工具：`apt-get install -y python3 make g++` 后重装。

**2. 端口被占用？**
改 `.env` 里的 `PORT`，并同步改 Nginx 的 `proxy_pass`。

**3. 图片/头像上传失败？**
检查 `data/` 目录的写入权限：`chown -R www-data:www-data data/`。

**4. 改了配置不生效？**
后台「站点设置」保存即生效；改的是 `config/*.jsonc` 文件的话，点「重新加载配置」或重启服务。

**5. 想完全重置？**
`node init-db.js --force` 会删库重建（只留一个超级管理员）。
