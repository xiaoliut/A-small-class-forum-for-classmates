# 班级论坛

面向班级内部使用的轻量论坛，基于 Node.js 构建。

适用于需要长期留存通知、讨论与资料的班级场景。注册需管理员审核，内容默认先审后发。

后端使用 Express，数据存储于 SQLite，页面由 EJS 服务端渲染。无需额外安装数据库或缓存服务，具备 Node.js 环境即可运行。

在线演示：<https://class-forum-demo.zayukeji.top/>
（注册时学校、班级可随意填写，邮箱或手机号任填一项即可）

## 功能特点

### 账号

- 注册需提交入班申请，填写学校、班级、真实姓名，邮箱与手机号至少填写一项；管理员审核通过后方可发言
- 三种角色：超级管理员、管理员、同学。管理员可管理内容，但无法操作其他管理员账号
- 会话持久化到数据库，服务重启不会导致登录失效
- 密码使用 bcrypt 哈希存储

### 帖子与评论

- 按板块发帖，支持搜索、翻页、置顶、设为公告
- 帖子与评论均支持图片上传（PNG / JPG / GIF / WebP），GIF 动图可正常播放
- 帖子可单独设置封面图，列表页显示缩略图；未设置则不显示
- 内置表情面板，点击即可插入输入框
- 帖子列表支持整卡点击进入详情
- 图片支持点击全屏查看

### 内容审核

- 默认采用全人工审核，帖子先审后发
- 可选启用 AI 审核，支持两种模式：
  - 本地规则库：基于关键词与正则打分，离线可用
  - 大模型 API：兼容 OpenAI 接口，在后台配置地址、密钥与模型名
- 启用 AI 后，判定为正常的内容可自动放行，存疑与违规内容转人工处理
- 违规评论自动隐藏，等待管理员复核

### 个人功能

- 支持自定义头像，在弹窗中拖拽裁剪为圆形
- 修改真实姓名需审核：同学的申请由管理员审批，管理员的申请仅超级管理员可审批
- 注销账号需审核，通过后进入一周冷静期，期满后执行注销（账号信息脱敏，已发布帖子保留）

### 管理后台

- 包含概览、入班申请、帖子、评论、举报、用户管理、操作日志等页面
- 站点名称、欢迎语、页脚版权、备案号等可直接在后台修改，无需改动代码
- 论坛规范页面内容支持后台在线编辑
- 管理员可查看各用户的邮箱与手机号
- 所有管理操作记录日志，删除均为软删除

## 安装

要求 Node.js 18 及以上，推荐 22 或更高版本。Node 22.5 起内置 SQLite 驱动，无需编译原生模块；低版本会自动回退到 better-sqlite3，需要机器预先安装编译工具链。

```bash
git clone https://github.com/xiaoliut/A-small-class-forum-for-classmates.git
cd A-small-class-forum-for-classmates
npm install --omit=dev
node init-db.js
npm start
```

启动后访问 http://127.0.0.1:3000

`node init-db.js` 会建立数据表并创建初始管理员账号 `admin` / `admin123`，首次登录后请立即修改密码。

### 配置

日常需要调整的内容集中在 `config/` 目录：

- `site.jsonc` —— 站点名称、欢迎语、副标题、页脚版权、备案号、页脚链接、功能开关
- `sections.jsonc` —— 论坛板块，支持增删改，可设置某板块仅管理员可发帖
- `moderation.jsonc` —— 审核关键词、权重与风险分阈值

修改后可在后台点击「重新加载配置」使其生效，无需重启服务；也可直接在后台页面填写，保存时会写回配置文件。

环境变量参考 `.env.example`，各项均有默认值。通常只需修改 `SESSION_SECRET`（上线时更换为随机字符串）与 `PORT`。

### 部署到服务器

推荐使用 systemd 托管，异常退出后自动重启：

```ini
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
```

```bash
systemctl daemon-reload
systemctl enable --now class-forum
```

随后用 Nginx 将 80 端口反向代理到 3000。完整步骤（含 HTTPS 与宝塔面板注意事项）见 [DEPLOY.md](DEPLOY.md)。

<!-- #demo-start -->
### 演示模式

对外提供演示时，可在 `.env` 中设置 `DEMO_MODE=1`：

- 访客访问时自动以共用的超级管理员身份登录，无需输入密码
- 站点设置对访客只读，保存会被拒绝并提示「演示网站禁止修改」；站长解锁后可正常修改
- 如需测试普通同学视角，点击导航栏「退出（换普通身份）」后走正常注册流程；点击「以管理员身份演示」可切回
- 每隔一小时执行一次清理：评论、除超管外的所有账号，以及非公告类的帖子
- 站长发布的置顶帖与公告帖会保留，站点不会被清空

相关配置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEMO_MODE` | `0` | 设为 `1` 开启演示模式 |
| `DEMO_CLEAN_INTERVAL` | `3600000` | 清理间隔（毫秒） |
| `MASTER_PATH` | `master` | 站长入口路径 |
| `MASTER_KEY` | 空 | 进入站长控制台的口令，留空则仅依赖路径隐蔽 |
| `MASTER_LOGIN_HINT` | 空 | 登录页显示的账号提示，留空则不显示 |

**站长控制台**：演示模式下访客请求会被自动登录接管，因此保留了一个不受接管的入口（默认 `/master`），进入需先通过口令。

- 第一步：输入 `MASTER_KEY` 口令（未配置则跳过）
- 第二步：使用超管账号密码登录（不会被自动登录覆盖）
- 登录后展示：演示站状态（帖子 / 评论 / 账号数）、上次与下次清理时间、「立即清理」按钮，以及前台 / 后台 / 发帖 / 个人中心的快捷入口
- 登录后可正常发帖评论，身份仍显示为超管

站长发布的置顶帖与公告帖不会被清理，可用于撰写演示规则说明。
<!-- #demo-end -->

## 使用

初始化后站点为空白状态，建议按以下顺序完成配置：

1. 使用 `admin` 登录，前往个人中心修改密码
2. 进入「站点设置」，将站点名称、欢迎语、页脚版权改为本班信息
3. 添加成员账号：由同学在注册页提交入班申请，管理员在「入班申请」中审核通过
4. 如需设置班干部，可在「用户管理」中将其设为管理员

完成后即可正常发帖回帖。如需调整板块或审核规则，修改 `config/` 目录或后台设置即可。

## 开发

```bash
npm run dev      # 启动并监听文件变化
npm test         # 端到端测试，需服务已启动
npm run reset-db # 清空数据库重建
```

测试覆盖真实业务链路，包括注册审核、登录权限、发帖、AI 审核、评论、图片上传、改名、注销、页脚设置等，共 83 项断言，执行完毕后会自动清理测试数据。

其他命令：

| 命令 | 作用 |
| --- | --- |
| `npm start` | 前台启动 |
| `npm run serve` | 后台常驻启动，日志写入 `data/server.log` |
| `npm run stop` | 停止后台服务 |
| `npm run init-db` | 建表并写入初始数据，可重复执行 |
| `npm run build` | 等同于 init-db（本项目无前端编译步骤） |

### 项目结构

```
class-forum/
├── app.js          应用入口：中间件、安全头、路由
├── init-db.js      建库脚本（--force 重置）
├── start.js/stop.js  后台常驻的启动和停止
├── config/         站点信息、板块、审核规则（日常修改此处）
├── data/           运行时生成：数据库、上传图片、日志
├── public/         CSS 与前端脚本
├── src/            后端代码（路由、中间件、数据库、审核）
├── views/          EJS 模板
└── test/           端到端测试
```

## 安全

- 所有表单均带 CSRF token 校验
- SQL 全部使用参数化查询，模板输出经 EJS 转义，防止注入与 XSS
- 内置 CSP、HSTS、X-Frame-Options、nosniff 等安全响应头
- 密码使用 bcrypt 哈希存储，管理员亦无法查看明文
- 登录失败统一提示，不暴露账号是否存在
- 管理操作全部写入日志，删除均为软删除

## 贡献

发现问题或有功能建议，可提交 [Issue](https://github.com/xiaoliut/A-small-class-forum-for-classmates/issues) 或 [Pull Request](https://github.com/xiaoliut/A-small-class-forum-for-classmates/pulls)。

提交代码前建议先执行 `npm test`，确认未影响既有功能。

## 许可证

[MIT](LICENSE)

## 致谢

- [Express](https://expressjs.com)
- [EJS](https://ejs.co)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)，以及 Node 内置的 `node:sqlite`
- [bcryptjs](https://github.com/dcodeIO/bcrypt.js)
- [multer](https://github.com/expressjs/multer)
