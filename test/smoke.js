'use strict';

/**
 * 端到端冒烟测试：用真实 HTTP 请求走一遍核心流程。
 * 用法：node test/smoke.js [baseUrl]
 *
 * 说明：这里用 Node 原生 http 模块（agent: false，不复用连接）而不是 fetch，
 * 因为测试过程中的连接复用会污染 Cookie 处理，导致误报。
 */

const http = require('http');

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const TARGET = new URL(BASE);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, extra) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

/** 极简 cookie jar（按名字覆盖，避免同名 Cookie 重复发送） */
function createJar() {
  const store = new Map();
  return {
    header() {
      return Array.from(store.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    },
    absorb(setCookieList) {
      for (const line of setCookieList || []) {
        const [pair] = line.split(';');
        const idx = pair.indexOf('=');
        if (idx === -1) continue;
        const key = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) store.delete(key);
        else store.set(key, value);
      }
    }
  };
}

function rawRequest(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: TARGET.hostname,
        port: TARGET.port || 80,
        method,
        path,
        headers,
        agent: false // 每次新建连接，避免连接复用导致的响应串扰
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            location: res.headers.location || '',
            setCookie: res.headers['set-cookie'] || [],
            text: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function request(jar, method, path, { form, json, follow = false, headers: extraHeaders = {} } = {}) {
  const headers = { Connection: 'close', ...extraHeaders };
  let body = null;

  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
    headers['Content-Length'] = Buffer.byteLength(body);
  } else if (json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  if (jar) headers.Cookie = jar.header();

  let result = await rawRequest(method, path, headers, body);
  if (jar) jar.absorb(result.setCookie);

  // 只在明确要求时跟随重定向（测试里主要观察 302 与 Location）
  let hops = 0;
  while (follow && result.status >= 300 && result.status < 400 && result.location && hops < 5) {
    hops += 1;
    const nextHeaders = { Connection: 'close' };
    if (jar) nextHeaders.Cookie = jar.header();
    result = await rawRequest('GET', result.location, nextHeaders, null);
    if (jar) jar.absorb(result.setCookie);
  }

  if (process.env.SMOKE_DEBUG) {
    const sent = String(headers.Cookie || '');
    const sidMatch = sent.match(/forum\.sid=s%3A([^.;]+)/);
    const tokenMatch = String(body || '').match(/_csrf=([^&]+)/);
    console.log(
      `    · ${method} ${path} -> ${result.status} ${result.location} len=${result.text.length}`
      + ` sid=${sidMatch ? sidMatch[1].slice(0, 12) : '-'} sent=${tokenMatch ? decodeURIComponent(tokenMatch[1]).slice(0, 8) : '-'}`
    );
  }

  return result;
}

function extractCsrf(html) {
  if (typeof html !== 'string') {
    if (process.env.SMOKE_DEBUG) console.log('    !! extractCsrf 收到非字符串：', typeof html);
    return null;
  }
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (!match && process.env.SMOKE_DEBUG) {
    console.log('    !! 页面中没有匹配到 csrf 隐藏域，长度', html.length, '头部：', JSON.stringify(html.slice(0, 160)));
  }
  return match ? match[1] : null;
}

function has(html, needle) {
  if (typeof html !== 'string') throw new TypeError('has() 需要传入 HTML 字符串，收到：' + typeof html);
  return html.includes(needle);
}

async function main() {
  console.log(`\n🔎 冒烟测试目标：${BASE}\n`);

  // 默认种子只留超级管理员，测试需要的「普通管理员/同学」账号在这里临时创建
  setupAccounts();
  // 测试要验证 AI 审核逻辑，显式开启（测试结束 cleanup 会清掉，回到默认「关闭 AI」）
  setupAiEnabled();

  // ---------------------------------------------------------------- 公开页面
  console.log('【公开页面】');
  const health = await request(null, 'GET', '/healthz');
  check('GET /healthz 返回 200', health.status === 200, `status=${health.status}`);
  check('/healthz 返回 ok:true', has(health.text, '"ok":true'));

  const home = await request(null, 'GET', '/');
  check('GET / 返回 200', home.status === 200, `status=${home.status}`);
  check('首页渲染站点名', has(home.text, '班级论坛'));
  check('首页渲染欢迎语句', has(home.text, '欢迎来到班级论坛'));
  check('干净状态首页无示例帖子', !has(home.text, '【必读】班级论坛使用规范') && !has(home.text, '闲置教辅资料转让'));

  const sections = await request(null, 'GET', '/sections');
  check('GET /sections 返回 200', sections.status === 200);

  const rules = await request(null, 'GET', '/rules');
  check('GET /rules 返回 200', rules.status === 200);

  const detail = await request(null, 'GET', '/posts/1');
  check('干净状态下 /posts/1 无示例帖子（404）', detail.status === 404, `status=${detail.status}`);

  const missing = await request(null, 'GET', '/posts/999999');
  check('不存在的帖子返回 404', missing.status === 404, `status=${missing.status}`);

  const blockedAdmin = await request(null, 'GET', '/admin');
  check('未登录访问 /admin 被重定向', blockedAdmin.status === 302 && blockedAdmin.location.includes('/login'), `status=${blockedAdmin.status}`);

  // ---------------------------------------------------------------- 登录
  console.log('\n【登录与权限】');
  const adminJar = createJar();
  const loginPage = await request(adminJar, 'GET', '/login');
  const adminCsrf = extractCsrf(loginPage.text);
  check('登录页包含 CSRF token', Boolean(adminCsrf));

  const badLogin = await request(adminJar, 'POST', '/login', {
    form: { _csrf: adminCsrf, username: 'admin', password: 'wrong-password' }
  });
  check('错误密码登录失败并返回 401', badLogin.status === 401, `status=${badLogin.status}`);
  check('错误密码提示不暴露账号存在性', has(badLogin.text, '用户名或密码不正确'));

  const noCsrf = await request(adminJar, 'POST', '/login', {
    form: { username: 'admin', password: 'admin123' }
  });
  check('缺少 CSRF token 的提交被拒绝', noCsrf.status === 403, `status=${noCsrf.status}`);

  const loginAgain = await request(adminJar, 'GET', '/login');
  const csrf2 = extractCsrf(loginAgain.text);
  const adminLogin = await request(adminJar, 'POST', '/login', {
    form: { _csrf: csrf2, username: 'admin', password: 'admin123' }
  });
  check('管理员登录成功并跳转后台', adminLogin.status === 302 && adminLogin.location === '/admin', `status=${adminLogin.status} loc=${adminLogin.location}`);

  // ---------------------------------------------------------------- 后台页面
  console.log('\n【管理后台】');
  const adminPages = [
    ['/admin', '管理后台'],
    ['/admin/applications', '入班申请'],
    ['/admin/posts', '帖子审核'],
    ['/admin/comments', '评论管理'],
    ['/admin/reports', '举报处理'],
    ['/admin/users', '用户管理'],
    ['/admin/logs', '审核日志']
  ];
  const adminJar2 = createJar();
  const lp = await request(adminJar2, 'GET', '/login');
  await request(adminJar2, 'POST', '/login', { form: { _csrf: extractCsrf(lp.text), username: 'admin', password: 'admin123' } });
  for (const [path, needle] of adminPages) {
    const page = await request(adminJar2, 'GET', path);
    check(`GET ${path} 渲染正常`, page.status === 200 && has(page.text, needle), `status=${page.status}`);
  }

  const flagged = await request(adminJar2, 'GET', '/admin/posts?tab=flagged');
  check('干净状态下后台 AI 违规队列为空', !has(flagged.text, '闲置教辅资料转让'));

  const pendingApps = await request(adminJar2, 'GET', '/admin/applications');
  check('干净状态下后台无待审申请', !has(pendingApps.text, '新同学'));

  // ---------------------------------------------------------------- 普通同学
  console.log('\n【普通同学权限】');
  const stuJar = createJar();
  const stuLoginPage = await request(stuJar, 'GET', '/login');
  const stuLogin = await request(stuJar, 'POST', '/login', {
    form: { _csrf: extractCsrf(stuLoginPage.text), username: 'xiaoming', password: 'student123' }
  });
  check('普通同学登录成功', stuLogin.status === 302 && stuLogin.location === '/', `loc=${stuLogin.location}`);

  const stuAdmin = await request(stuJar, 'GET', '/admin');
  check('普通同学访问后台被拒绝(403)', stuAdmin.status === 403, `status=${stuAdmin.status}`);

  const mePage = await request(stuJar, 'GET', '/me');
  check('普通同学可访问个人中心', mePage.status === 200 && has(mePage.text, '个人中心'));

  // 发帖（正常内容 → 自动通过）
  const newPostPage = await request(stuJar, 'GET', '/posts/new');
  const postCsrf = extractCsrf(newPostPage.text);
  const cleanPost = await request(stuJar, 'POST', '/posts', {
    form: {
      _csrf: postCsrf,
      title: '冒烟测试：请教一道化学配平题',
      content: '这道氧化还原反应的配平我总是算错，有没有同学愿意讲讲思路？明天课后一起讨论一下。',
      section: 'study'
    }
  });
  check('正常内容发帖被自动通过并跳转详情', cleanPost.status === 302 && /^\/posts\/\d+$/.test(cleanPost.location), `status=${cleanPost.status} loc=${cleanPost.location}`);
  const cleanId = cleanPost.location.split('/').pop();
  const cleanDetail = await request(stuJar, 'GET', `/posts/${cleanId}`);
  check('新帖立即可见（AI 判定正常）', cleanDetail.status === 200 && has(cleanDetail.text, 'AI 判定正常'));

  // 发帖（疑似违规 → 进入待审）
  const newPostPage2 = await request(stuJar, 'GET', '/posts/new');
  const postCsrf2 = extractCsrf(newPostPage2.text);
  check('再次打开发帖页仍能取到 token', Boolean(postCsrf2), `status=${newPostPage2.status} len=${newPostPage2.text.length} csrfCount=${newPostPage2.text.split('name="_csrf"').length - 1}`);
  const badPost = await request(stuJar, 'POST', '/posts', {
    form: {
      _csrf: postCsrf2,
      title: '冒烟测试：低价出闲置教辅',
      content: '加我vx：study2026详聊，绝对超低价，还包邮！需要的抓紧联系！！！',
      section: 'general'
    }
  });
  check('疑似违规内容进入审核流程', badPost.status === 302 && /\/review$/.test(badPost.location), `loc=${badPost.location}`);
  const badId = badPost.location.split('/')[2];
  const badReview = await request(stuJar, 'GET', `/posts/${badId}/review`);
  check('作者能看到 AI 审核详情', badReview.status === 200 && has(badReview.text, 'AI 审核结果'));
  check('审核详情给出命中原因', has(badReview.text, '广告推广') || has(badReview.text, '联系方式'));
  check('作者看到友好提示而非处罚', has(badReview.text, '这不是处罚'));

  const outsider = await request(null, 'GET', `/posts/${badId}`);
  check('未公开帖子对游客不可见', outsider.status === 302, `status=${outsider.status}`);

  // 评论
  const commentDetail = await request(stuJar, 'GET', `/posts/${cleanId}`);
  const commentCsrf = extractCsrf(commentDetail.text);
  const comment = await request(stuJar, 'POST', `/posts/${cleanId}/comments`, {
    form: { _csrf: commentCsrf, content: '我知道这道题，明天早读前我给你讲一遍。' }
  });
  check('正常评论发布成功', comment.status === 302, `status=${comment.status}`);
  const afterComment = await request(stuJar, 'GET', `/posts/${cleanId}`);
  check('评论显示在详情页', has(afterComment.text, '明天早读前我给你讲一遍'));
  check('评论显示昵称与时间', has(afterComment.text, '小明') && has(afterComment.text, '评论（'));

  const badCommentPage = await request(stuJar, 'GET', `/posts/${cleanId}`);
  const badCommentCsrf = extractCsrf(badCommentPage.text);
  check('评论框页面能取到 token', Boolean(badCommentCsrf), `status=${badCommentPage.status} len=${badCommentPage.text.length} count=${badCommentPage.text.split('name="_csrf"').length - 1}`);
  const badComment = await request(stuJar, 'POST', `/posts/${cleanId}/comments`, {
    form: { _csrf: badCommentCsrf || '', content: '加微信 buy2026 低价出售答案，包邮！' }
  });
  check('违规评论被接受但自动隐藏', badComment.status === 302, `status=${badComment.status}`);
  const hiddenView = await request(adminJar2, 'GET', '/admin/comments');
  check('管理员后台出现被隐藏的评论', has(hiddenView.text, '待复核') && has(hiddenView.text, 'buy2026'));

  // 删除自己的帖子
  const myPostsPage = await request(stuJar, 'GET', '/me/posts');
  const delCsrf = extractCsrf(myPostsPage.text);
  check('我的帖子页包含删除表单 token', Boolean(delCsrf), `status=${myPostsPage.status} len=${myPostsPage.text.length}`);
  const delPost = await request(stuJar, 'POST', `/posts/${cleanId}/delete`, { form: { _csrf: delCsrf || '' } });
  check('作者可以删除自己的帖子', delPost.status === 302, `status=${delPost.status}`);

  // ---------------------------------------------------------------- 注册与待审
  console.log('\n【注册与待审核】');
  const anonJar = createJar();
  const regPage = await request(anonJar, 'GET', '/register');
  const regCsrf = extractCsrf(regPage.text);
  check('注册页渲染正常', regPage.status === 200 && has(regPage.text, '申请加入班级论坛'));

  const badReg = await request(anonJar, 'POST', '/register', {
    form: { _csrf: regCsrf, username: 'ab', password: '123', password2: '456', nickname: '', real_name: '', school: '', class_name: '' }
  });
  check('注册表单校验生效（400）', badReg.status === 400, `status=${badReg.status}`);

  const username = `smoke${Date.now().toString().slice(-6)}`;
  const goodReg = await request(anonJar, 'POST', '/register', {
    form: {
      _csrf: regCsrf,
      username,
      password: 'student123',
      password2: 'student123',
      nickname: '冒烟同学',
      real_name: '测试同学',
      school: 'XX中学',
      class_name: '高一(3)班',
      student_no: '20239999',
      email: `${username}@test.com`,
      phone: '13800001111',
      apply_reason: '自动化测试注册'
    }
  });
  check('有效申请提交成功', goodReg.status === 302 && goodReg.location.startsWith('/register/done'), `loc=${goodReg.location}`);

  const pendingJar = createJar();
  const pLoginPage = await request(pendingJar, 'GET', '/login');
  const pLogin = await request(pendingJar, 'POST', '/login', { form: { _csrf: extractCsrf(pLoginPage.text), username, password: 'student123' } });
  check('待审核用户登录后被引导到 /pending', pLogin.status === 302 && pLogin.location === '/pending', `loc=${pLogin.location}`);

  const pendingPage = await request(pendingJar, 'GET', '/pending');
  check('待审核页显示审核中提示', pendingPage.status === 200 && has(pendingPage.text, '申请正在审核中'));
  const pendingHome = await request(pendingJar, 'GET', '/');
  check('待审核用户仍可浏览论坛', pendingHome.status === 200, `status=${pendingHome.status}`);

  const pendingCsrfPage = await request(pendingJar, 'GET', '/');
  const pendingPost = await request(pendingJar, 'POST', '/posts', {
    form: { _csrf: extractCsrf(pendingCsrfPage.text) || '', title: '冒烟测试：待审核用户发帖', content: '这段内容不应该被写入数据库。' }
  });
  check('待审核用户无法发帖（被重定向）', pendingPost.status === 302 && pendingPost.location === '/pending', `status=${pendingPost.status} loc=${pendingPost.location}`);
  check('待审核用户的帖子没有入库', !has((await request(pendingJar, 'GET', '/me/posts')).text, '待审核用户发帖'));

  // 管理员通过该申请
  const appsPage = await request(adminJar2, 'GET', '/admin/applications');
  const approveCsrf = extractCsrf(appsPage.text);
  // 待审申请按提交时间倒序，最新一条就在最前面
  const newUserId = (appsPage.text.match(/\/admin\/users\/(\d+)\/approve/) || [])[1] || null;
  check('后台能看到新提交的申请', has(appsPage.text, username), `username=${username}`);
  if (newUserId) {
    const approve = await request(adminJar2, 'POST', `/admin/users/${newUserId}/approve`, { form: { _csrf: approveCsrf } });
    check('管理员通过申请', approve.status === 302, `status=${approve.status}`);
    const nowApproved = await request(pendingJar, 'GET', '/me');
    check('通过后用户可正常使用论坛', nowApproved.status === 200 && has(nowApproved.text, '个人中心'), `status=${nowApproved.status}`);
  } else {
    check('解析新用户 ID 用于审核', false, '未能从后台页面提取用户 ID');
  }

  // ---------------------------------------------------------------- 管理员处罚
  console.log('\n【管理员处罚与置顶】');
  const usersPage = await request(adminJar2, 'GET', '/admin/users');
  const userCsrf = extractCsrf(usersPage.text);
  const muteTargetId = (usersPage.text.match(/\/admin\/users\/(\d+)\/mute/) || [])[1];
  if (muteTargetId) {
    const mute = await request(adminJar2, 'POST', `/admin/users/${muteTargetId}/mute`, {
      form: { _csrf: userCsrf, mode: 'days', reason: '冒烟测试禁言' }
    });
    check('管理员可以禁言用户', mute.status === 302, `status=${mute.status}`);
    const afterMute = await request(adminJar2, 'GET', '/admin/users');
    check('用户列表显示禁言状态', has(afterMute.text, '禁言至'));
  } else {
    check('解析可处罚用户', false, '未找到禁言目标');
  }

  // 干净种子下无帖子，先由管理员发一个正常帖，再测试置顶
  const adminPostPage = await request(adminJar2, 'GET', '/posts/new');
  const adminPostCsrf = extractCsrf(adminPostPage.text);
  const adminPost = await request(adminJar2, 'POST', '/posts', {
    form: { _csrf: adminPostCsrf || '', title: '冒烟测试：置顶用公告', content: '用于测试置顶功能的临时公告，测试结束后清理。', section: 'notice' }
  });
  const pinTargetId = (adminPost.location.match(/\/posts\/(\d+)/) || [])[1];
  if (pinTargetId) {
    const postsAdmin = await request(adminJar2, 'GET', '/admin/posts?tab=approved');
    const pinCsrf = extractCsrf(postsAdmin.text);
    const pin = await request(adminJar2, 'POST', `/admin/posts/${pinTargetId}/pin`, { form: { _csrf: pinCsrf } });
    check('管理员可以置顶帖子', pin.status === 302, `status=${pin.status}`);
  } else {
    check('解析可置顶帖子', false, '发帖后未取到帖子 ID');
  }

  // 举报
  const reportPage = await request(stuJar, 'GET', '/posts/2');
  const reportCsrf = extractCsrf(reportPage.text);
  const report = await request(stuJar, 'POST', '/report', {
    form: { _csrf: reportCsrf || '', target_type: 'post', target_id: '2', reason: '其他', detail: '冒烟测试举报' }
  });
  check('用户可以提交举报', report.status === 302, `status=${report.status}`);
  const reportsPage = await request(adminJar2, 'GET', '/admin/reports');
  check('后台能看到举报记录', has(reportsPage.text, '冒烟测试举报'));

  // ---------------------------------------------------------------- 超级管理员 vs 普通管理员
  console.log('\n【超级管理员与普通管理员权限】');
  const admin2Jar = createJar();
  const a2LoginPage = await request(admin2Jar, 'GET', '/login');
  const a2Login = await request(admin2Jar, 'POST', '/login', {
    form: { _csrf: extractCsrf(a2LoginPage.text), username: 'admin2', password: 'admin123' }
  });
  check('普通管理员可登录', a2Login.status === 302, `status=${a2Login.status}`);
  const a2Admin = await request(admin2Jar, 'GET', '/admin');
  check('普通管理员可进入管理后台', a2Admin.status === 200 && has(a2Admin.text, '管理后台'));
  const a2Settings = await request(admin2Jar, 'GET', '/admin/settings');
  check('普通管理员不能改站点设置（403）', a2Settings.status === 403, `status=${a2Settings.status}`);
  const a2Tabs = await request(admin2Jar, 'GET', '/admin');
  check('普通管理员看不到「站点设置」入口', !has(a2Tabs.text, '站点设置'));

  // ---------------------------------------------------------------- 页脚与站点设置
  console.log('\n【页脚版权与站点设置】');
  // 本地模式才能直接读写服务器的 config 文件；远程模式通过管理员接口备份/还原
  const isLocalTarget = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(BASE);
  const filePath = getConfigPath('site.jsonc');
  const originalConfigText = readConfigFileText();
  cleanupSiteSettings();

  const footerPage = await request(adminJar2, 'GET', '/admin/applications');
  check('页脚显示版权年份', has(footerPage.text, '© ' + new Date().getFullYear()));
  check('页脚显示站点名', has(footerPage.text, '班级论坛'));
  check('页脚显示论坛规范链接', has(footerPage.text, '论坛规范'));

  const settingsPage = await request(adminJar2, 'GET', '/admin/settings');
  check('后台站点设置页可打开', settingsPage.status === 200 && has(settingsPage.text, '站点设置'));
  check('设置页列出可修改的配置文件', has(settingsPage.text, 'site.jsonc') && has(settingsPage.text, 'moderation.jsonc'));

  // 远程模式：保存前先从服务器读一份原文，便于测试结束后还原
  let remoteOriginalConfig = '';
  if (!isLocalTarget) {
    const rawPage = await request(adminJar2, 'GET', '/admin/settings/raw');
    remoteOriginalConfig = typeof rawPage.text === 'string' && rawPage.status === 200 ? rawPage.text : '';
    check('可以读取服务器配置原文', Boolean(remoteOriginalConfig.trim()), `status=${rawPage.status}`);
  }

  const stuSettings = await request(stuJar, 'GET', '/admin/settings');
  check('普通同学无法访问站点设置', stuSettings.status === 403, `status=${stuSettings.status}`);

  // 保存设置 → 前台页脚立即生效
  const saveCsrf = extractCsrf(settingsPage.text);
  const testIcp = '测试ICP备' + Date.now().toString().slice(-6) + '号-1';
  const testCustom = '测试自定义底部文字：仅供班级内部使用';
  const saveSettings = await request(adminJar2, 'POST', '/admin/settings', {
    form: {
      _csrf: saveCsrf || '',
      siteName: '班级论坛',
      siteTagline: '杂鱼科技 · 杂鱼工作室',
      siteDescription: '分享学习心得、记录班级活动、发布通知公告的班级论坛。',
      welcomeMessage: '欢迎来到班级论坛',
      adminContact: '高一(3)班 李老师',
      footerCopyright: '',
      footerIcp: testIcp,
      footerPolice: '',
      footerCustomText: testCustom,
      footerExtraLines: '测试额外文字行一',
      footerLinks: '班级公约|/rules',
      footerPoweredByText: '由 Node.js + Express + SQLite 驱动',
      footerShowPoweredBy: 'on',
      featureAiModeration: 'on',
      featureAiAutoApprove: 'on',
      featureAllowRegister: 'on'
    }
  });
  check('管理员可以保存站点设置', saveSettings.status === 302, `status=${saveSettings.status}`);

  const homeAfterSave = await request(null, 'GET', '/');
  check('备案号立即显示在页脚', has(homeAfterSave.text, testIcp));
  check('自定义底部文字立即显示', has(homeAfterSave.text, testCustom));
  check('额外文字行立即显示', has(homeAfterSave.text, '测试额外文字行一'));
  check('页脚额外链接立即显示', has(homeAfterSave.text, '班级公约'));
  check('管理员联系方式显示在页脚', has(homeAfterSave.text, '高一(3)班 李老师'));
  if (isLocalTarget) {
    check('设置已写回 config/site.jsonc', readConfigFileText().includes(testIcp), '文件里没有找到测试备案号');
  } else {
    console.log('  ℹ️  远程模式：跳过「写回 config 文件」校验（文件在服务器上，本机看不到）');
  }

  // 改配置文件 → 重新加载后生效（本地模式可验证；远程模式仅验证重载接口）
  cleanupSiteSettings();
  if (isLocalTarget) {
    const beforePatch = readConfigFileText();
    const patched = beforePatch.replace(/"siteTagline":\s*"[^"]*"/, '"siteTagline": "配置文件热更新测试"');
    require('fs').writeFileSync(filePath, patched, 'utf8');
    check('配置文件已写入新副标题', readConfigFileText().includes('配置文件热更新测试'));
  }

  let hotReloadSeen = false;
  for (let attempt = 0; attempt < 3 && !hotReloadSeen; attempt += 1) {
    const reloadPage = await request(adminJar2, 'GET', '/admin/settings');
    const reload = await request(adminJar2, 'POST', '/admin/settings/reload', { form: { _csrf: extractCsrf(reloadPage.text) || '' } });
    if (attempt === 0) check('可以重新加载配置文件', reload.status === 302, `status=${reload.status}`);
    const homeAfterFileEdit = await request(null, 'GET', '/');
    // 重载后站点配置应可正常渲染（本地模式还能看到新副标题）
    hotReloadSeen = has(homeAfterFileEdit.text, '班级论坛')
      && (!isLocalTarget || has(homeAfterFileEdit.text, '配置文件热更新测试'));
    if (!hotReloadSeen) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  check(isLocalTarget ? '改配置文件后重新加载即生效' : '重载配置后站点渲染正常',
    hotReloadSeen, isLocalTarget ? '页面未出现新副标题' : '重载后首页异常');

  // 恢复现场：本地模式直接还原文件；远程模式通过后台接口恢复默认
  if (isLocalTarget) {
    require('fs').writeFileSync(filePath, originalConfigText, 'utf8');
    check('测试后配置文件已还原', !readConfigFileText().includes(testIcp));
    cleanupSiteSettings();
    const restored = await request(null, 'GET', '/');
    check('测试后页脚已恢复（不残留测试备案号）', !has(restored.text, testIcp));
  } else {
    const resetPage = await request(adminJar2, 'GET', '/admin/settings');
    const resetCsrf = extractCsrf(resetPage.text) || '';
    const resetRes = await request(adminJar2, 'POST', '/admin/settings/reset', { form: { _csrf: resetCsrf } });
    check('可以恢复为配置文件默认值', resetRes.status === 302, `status=${resetRes.status}`);

    // 用管理员专用还原接口把服务器上的配置原文写回去，保证不留测试数据
    if (remoteOriginalConfig.trim()) {
      const restoreRes = await request(adminJar2, 'POST', '/admin/settings/restore', {
        form: { _csrf: resetCsrf, config: remoteOriginalConfig },
        headers: { 'x-requested-with': 'config-restore' }
      });
      check('可以还原配置文件原文', restoreRes.status === 302, `status=${restoreRes.status}`);
    } else {
      console.log('  ℹ️  未取到远端配置原文，跳过还原（可执行 node tools/push-config.mjs 复位）');
    }

    const restored = await request(null, 'GET', '/');
    check('测试后页脚已恢复（不残留测试备案号）', !has(restored.text, testIcp));
  }

  // 退出登录
  const mePage2 = await request(stuJar, 'GET', '/me');
  const logoutCsrf = extractCsrf(mePage2.text);
  const logout = await request(stuJar, 'POST', '/logout', { form: { _csrf: logoutCsrf || '' } });
  check('退出登录成功', logout.status === 302, `status=${logout.status}`);

  // ---------------------------------------------------------------- 清理测试数据
  console.log('\n【清理测试数据】');
  cleanup();

  // ---------------------------------------------------------------- 汇总
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach((item) => console.log(`  • ${item}`));
  }
  console.log(`${'─'.repeat(52)}\n`);
  process.exit(failed ? 1 : 0);
}

/** 读取 config/site.jsonc 原文 */
function getConfigPath(name) {
  const path = require('path');
  return path.resolve(__dirname, '..', 'config', name);
}

/**
 * 取配置文件的原始文本。
 * 本地模式读本机文件；远程模式直接读服务器上的文件（测试与服务器在同一台机器上时）。
 */
function readConfigFileText() {
  const fs = require('fs');
  const candidates = [getConfigPath('site.jsonc')];
  const dir = process.env.REMOTE_CONFIG_DIR;
  if (dir) candidates.push(require('path').posix.join(dir, 'site.jsonc'));
  for (const file of candidates) {
    try {
      // 必须显式指定 utf8，否则 Node 返回 Buffer，写回时会损坏中文
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    } catch (_) {
      /* 继续尝试下一个 */
    }
  }
  return '';
}

/** 清掉数据库里的站点设置覆盖，恢复到「配置文件 + 内置默认」 */
function cleanupSiteSettings() {
  const db = require('../src/db');
  db.run("DELETE FROM settings WHERE key = 'site'");
}

/** 测试开始前，临时创建测试账号（默认种子只留超级管理员） */
function setupAccounts() {
  let db;
  try {
    db = require('../src/db');
  } catch (_) {
    return;
  }
  const bcrypt = require('bcryptjs');
  const now = new Date().toISOString();
  const ensure = (username, nickname, realName, role, password) => {
    if (!db.get('SELECT id FROM users WHERE username = ?', username)) {
      db.run(
        `INSERT INTO users (username, password_hash, nickname, real_name, school, class_name, email, role, status, created_at)
         VALUES (?, ?, ?, ?, 'XX中学', 'XX班', ?, ?, 'approved', ?)`,
        username, bcrypt.hashSync(password, 10), nickname, realName, `${username}@test.com`, role, now
      );
    }
  };
  ensure('admin2', '管理员', '管理员', 'admin', 'admin123');
  ensure('xiaoming', '小明', '王小明', 'student', 'student123');
}

/** 测试期间开启 AI 审核（验证 AI 逻辑），结束由 cleanupSiteSettings 清除覆盖回到默认 */
function setupAiEnabled() {
  try {
    const settings = require('../src/settings');
    settings.saveSiteToDb({ features: { aiModeration: true, aiAutoApprove: true } });
  } catch (_) {
    /* ignore */
  }
}

/** 清掉本次冒烟测试产生的数据，保持测试库干净 */
function cleanup() {
  let db;
  try {
    db = require('../src/db');
  } catch (err) {
    console.log('  ⚠️  跳过清理（无法加载数据库模块，服务可能占用了库文件）：', err.message);
    return;
  }
  try {
    // 测试注册的账号与临时测试账号（admin2/xiaoming）硬删除；帖子/评论保留软删除痕迹但清关联
    const users = db.all("SELECT id FROM users WHERE username LIKE 'smoke%' OR username IN ('admin2','xiaoming')");
    for (const user of users) {
      db.run('DELETE FROM comments WHERE user_id = ?', user.id);
      db.run('DELETE FROM posts WHERE user_id = ?', user.id);
      db.run('DELETE FROM reports WHERE reporter_id = ?', user.id);
      db.run(
        `DELETE FROM moderation_logs
          WHERE target_type = 'user'
             OR action IN ('submit_application','approve_user','reject_user','mute_user','unmute_user','ban_user','unban_user','handle_report')`
      );
      db.run('DELETE FROM sessions WHERE data LIKE ?', `%\"userId\":${user.id}%`);
      db.run('DELETE FROM users WHERE id = ?', user.id);
    }
    db.run("DELETE FROM posts WHERE title LIKE '冒烟测试%'");
    db.run("DELETE FROM comments WHERE content LIKE '%buy2026%' OR content LIKE '%早读前我给你讲一遍%'");
    db.run("DELETE FROM reports WHERE detail LIKE '%冒烟测试%'");
    db.run("DELETE FROM moderation_logs WHERE detail LIKE '%冒烟测试%'");
    db.exec("UPDATE posts SET comment_count = (SELECT COUNT(*) FROM comments c WHERE c.post_id = posts.id AND c.status = 'visible');");
    console.log('  🧹 已清理冒烟测试产生的临时数据');
  } catch (err) {
    console.log('  ⚠️  清理时出错：', err.message);
  } finally {
    try {
      db.close();
    } catch (_) {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error('冒烟测试运行异常：', err);
  process.exit(2);
});
