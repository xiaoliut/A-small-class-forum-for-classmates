/**
 * 配置加载层
 *
 * 设计目标：把「可以改的东西」和「尽量不要动的代码」分开。
 *   · config/*.jsonc —— 你（超级管理员）日常会改的：站点信息、页脚版权/备案号、分区、审核规则
 *   · .env           —— 部署相关的：端口、监听地址、会话密钥、AI 接口密钥
 *   · src/**.js      —— 程序逻辑，正常情况不需要动
 *
 * 生效顺序（后面的覆盖前面的）：
 *   1. 本文件里的 DEFAULT_* 兜底值
 *   2. config/site.jsonc、config/sections.jsonc、config/moderation.jsonc 里的用户配置
 *   3. 数据库 settings 表里的站点配置（后台「站点设置」页保存的结果，优先级最高）
 *
 * 好处：后台改完立即生效，不需要重启；把 config/site.jsonc 清空也能随时恢复默认。
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT_DIR, 'config');
const USER_CONFIG_DIR = path.join(CONFIG_DIR, 'user');

// ---------------------------------------------------------------------------
// 站点默认设置
// ---------------------------------------------------------------------------
const DEFAULT_SITE = {
  siteName: '班级论坛',
  siteTagline: '',
  siteDescription: '分享学习心得、记录班级活动、发布通知公告的班级论坛。',
  welcomeMessage: '欢迎来到班级论坛',
  adminContact: '',

  footer: {
    copyright: '杂鱼科技-杂鱼工作室|https://zayukeji.top',
    icp: '',
    police: '',
    customText: '',
    extraLines: [],
    links: [
      { label: '杂鱼科技', href: 'https://zayukeji.top' }
    ],
    showPoweredBy: false,
    poweredByText: ''
  },

  features: {
    aiModeration: false,
    aiAutoApprove: true,
    allowRegister: true
  }
};

const DEFAULT_SECTIONS = [
  { key: 'general', name: '综合讨论', desc: '什么都可以聊两句' },
  { key: 'study', name: '学习交流', desc: '作业、错题、考试互助' },
  { key: 'life', name: '班级生活', desc: '活动、通知、日常记录' },
  { key: 'notice', name: '公告通知', desc: '管理员发布的正式通知', adminOnly: true }
];

// 大模型审核接入默认配置：enabled=false 且 baseUrl/apiKey 为空时 = 离线规则库模式
const DEFAULT_AI = {
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: 'deepseek-chat',
  timeoutMs: 8000
};

// 论坛规范默认文本（超级管理员可在后台编辑；## 开头为标题，- 开头为列表项，空行分段）
const DEFAULT_RULES = [
  '## 一、谁能使用',
  '论坛只对本班同学与老师开放。注册需要提交学校和班级信息，由管理员审核通过后才能发帖评论。',
  '',
  '## 二、鼓励发什么',
  '- 学习问题求助、错题整理、笔记分享；',
  '- 班级活动、比赛、值日的记录与通知；',
  '- 对班级建设的合理建议。',
  '',
  '## 三、不允许的内容',
  '- 广告、拉人、外链推广、二手交易信息；',
  '- 辱骂、嘲讽、人身攻击，或针对某位同学的阴阳怪气；',
  '- 违法违禁、低俗色情、赌博类内容；',
  '- 暴露他人隐私（手机号、家庭住址、聊天记录截图等）；',
  '- 刷屏灌水、无意义重复发帖。',
  '',
  '## 四、审核流程',
  '1. AI 自动检测：发帖后系统会立刻检测标题与正文，正常内容自动公开。',
  '2. AI 建议复核：拿不准的内容会先进入待审核队列，只有作者和管理员可见。',
  '3. 人工复核：管理员通过、驳回或删除，并可以给帖子加上警告提示。',
  '',
  '## 五、处罚方式',
  '- 警告：帖子顶部会出现黄色提示，提醒作者注意措辞。',
  '- 禁言：一段时间内不能发帖和评论，可以正常浏览。',
  '- 封号：严重或多次违规时，账号将无法登录论坛功能。',
  '',
  '## 六、遇到问题',
  '看到不合适的内容，请点击帖子或评论下方的「举报」，管理员会在后台看到并处理。'
].join('\n');

const DEFAULT_MODERATION = {
  autoApprove: true,
  thresholds: { review: 20, violation: 60 },
  categories: {
    违法违禁: { weight: 60, words: ['毒品', '枪支', '赌博', '博彩', '代考', '作弊器', '刷单', '洗钱'] },
    色情低俗: { weight: 60, words: ['色情', '约炮', '裸聊', '黄色网站'] },
    人身攻击: { weight: 40, words: ['傻逼', '滚蛋', '废物', '脑残', '去死', '垃圾人', '白痴'] },
    广告推广: {
      weight: 30,
      words: ['加微信', '加vx', '加qq', '私聊购买', '代购', '兼职日结', '刷赞', '扫码进群', '包邮', '低价出售']
    },
    联系方式: { weight: 20, words: [], patterns: ['\\b1[3-9]\\d{9}\\b', '(?:wx|vx|qq)\\s*[:：]?\\s*[a-zA-Z0-9_-]{5,}'] },
    拉人外链: { weight: 25, patterns: ['(?:https?://|www\\.)\\S+', '\\S+\\.(?:com|cn|net|top|xyz)\\b'] },
    敏感话题: { weight: 35, words: ['涉政', '抗议', '上访', '邪教'] },
    灌水刷屏: { weight: 15, patterns: ['(.)\\1{6,}', '[!！?？]{5,}'] }
  },
  textRules: [
    { label: '广告推广', weight: 15, pattern: '(?:加|搜|联系)\\s*(?:我|本人)?\\s*(?:的)?\\s*(?:微信|vx|wx|qq)\\s*\\d*', keyword: '引导添加联系方式' },
    { label: '广告推广', weight: 20, pattern: '(二手|闲置).{0,20}(转让|出售|甩卖|低价|包邮|秒杀)', keyword: '疑似商品交易' },
    { label: '招生招聘', weight: 25, pattern: '(招|找)(?:人|兼职|代理|学徒)|日结|月入过万|轻松赚钱', keyword: '疑似招聘/兼职广告' }
  ],
  sectionKeywords: {
    study: ['题', '作业', '考试', '笔记', '复习', '课', '老师', '成绩', '错题', '学习'],
    life: ['运动会', '食堂', '宿舍', '春游', '活动', '班会', '生日', '同学', '操场', '社团'],
    notice: ['通知', '公告', '安排', '提醒', '必读', '规范']
  }
};

// 后台「站点设置」页允许编辑的字段（同时决定写回 config/site.jsonc 的内容）
const EDITABLE_SITE_KEYS = [
  'siteName',
  'siteTagline',
  'siteDescription',
  'welcomeMessage',
  'adminContact'
];

const EDITABLE_FOOTER_KEYS = [
  'copyright',
  'icp',
  'police',
  'customText',
  'poweredByText'
];

// ---------------------------------------------------------------------------
// JSONC 解析（支持 // 与 /* */ 注释、尾随逗号）
// ---------------------------------------------------------------------------
function stripComments(text) {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += char;
  }
  // 去掉尾随逗号
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function parseJsonc(text, file) {
  try {
    return JSON.parse(stripComments(text));
  } catch (err) {
    console.warn(`[config] 无法解析 ${path.basename(file)}：${err.message}（将使用默认值）`);
    return null;
  }
}

function readConfigFile(name) {
  const file = path.join(CONFIG_DIR, name);
  if (!fs.existsSync(file)) return null;
  const parsed = parseJsonc(fs.readFileSync(file, 'utf8'), file);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

/** 深合并：对象递归合并，数组整体替换 */
function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  if (Array.isArray(patch)) return patch;
  const result = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = result[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)) {
      result[key] = deepMerge(current, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 站点设置：文件 + 数据库 合并
// ---------------------------------------------------------------------------
const SITE_DB_KEY = 'site';
const AI_DB_KEY = 'ai';
const RULES_DB_KEY = 'rules';

function getDb() {
  try {
    // 延迟 require，避免 config 目录被独立引用时也去连数据库
    // eslint-disable-next-line global-require
    return require('./db');
  } catch (_) {
    return null;
  }
}

/** 读取数据库里保存的站点设置（不存在则返回 null） */
function readDbSite() {
  const db = getDb();
  if (!db) return null;
  try {
    const row = db.get('SELECT value FROM settings WHERE key = ?', SITE_DB_KEY);
    if (!row || !row.value) return null;
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    // settings 表还不存在（首次启动建表前）时静默回退
    return null;
  }
}

/** 读取数据库里保存的大模型接入配置（不存在则返回 null） */
function readDbAi() {
  const db = getDb();
  if (!db) return null;
  try {
    const row = db.get('SELECT value FROM settings WHERE key = ?', AI_DB_KEY);
    if (!row || !row.value) return null;
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

/**
 * 最终生效的大模型接入配置。
 * 优先级：后台数据库配置 > .env 环境变量（config.ai）> DEFAULT_AI。
 */
function getAiConfig() {
  const fromDb = readDbAi() || {};
  const fromEnv = {
    enabled: config.ai.enabled,
    baseUrl: config.ai.baseUrl,
    apiKey: config.ai.apiKey,
    model: config.ai.model,
    timeoutMs: config.ai.timeoutMs
  };
  return { ...DEFAULT_AI, ...fromEnv, ...fromDb };
}

/** 保存大模型接入配置到数据库（仅 DB，不写进 config 文件，避免密钥进源码包） */
function saveAiToDb(ai) {
  const db = getDb();
  if (!db) throw new Error('数据库不可用，无法保存设置');
  const current = readDbAi() || {};
  const merged = { ...current, ...ai };
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    AI_DB_KEY, JSON.stringify(merged), new Date().toISOString()
  );
  return merged;
}

/** 论坛规范文本（数据库优先，未保存过则用默认） */
function getRulesContent() {
  const db = getDb();
  if (db) {
    try {
      const row = db.get('SELECT value FROM settings WHERE key = ?', RULES_DB_KEY);
      if (row && row.value) return row.value;
    } catch (_) {
      /* ignore */
    }
  }
  return DEFAULT_RULES;
}

/** 保存论坛规范文本到数据库 */
function saveRulesContent(text) {
  const db = getDb();
  if (!db) throw new Error('数据库不可用，无法保存规范');
  const value = String(text == null ? '' : text);
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    RULES_DB_KEY, value, new Date().toISOString()
  );
  return value;
}

/** 最终生效的站点设置 */
function getSite() {
  const fromFile = readConfigFile('site.jsonc') || {};
  const fromDb = readDbSite() || {};
  return deepMerge(deepMerge({ ...DEFAULT_SITE }, fromFile), fromDb);
}

/** 分区配置 */
function getSections() {
  const fromFile = readConfigFile('sections.jsonc');
  const list = Array.isArray(fromFile?.sections) ? fromFile.sections : fromFile;
  if (!Array.isArray(list) || list.length === 0) return DEFAULT_SECTIONS;
  return list
    .filter((item) => item && typeof item.key === 'string' && item.key.trim())
    .map((item) => ({
      key: item.key.trim(),
      name: item.name || item.key,
      icon: item.icon || '',
      desc: item.desc || '',
      adminOnly: Boolean(item.adminOnly)
    }));
}

/** 审核规则（含正则编译） */
function getModerationRules() {
  const fromFile = readConfigFile('moderation.jsonc') || {};
  const merged = deepMerge({ ...DEFAULT_MODERATION }, fromFile);

  const categories = [];
  for (const [label, rule] of Object.entries(merged.categories || {})) {
    categories.push({
      label,
      weight: Number(rule.weight) || 10,
      words: Array.isArray(rule.words) ? rule.words.filter(Boolean) : [],
      patterns: Array.isArray(rule.patterns) ? compileAll(rule.patterns, label) : []
    });
  }

  const textRules = (merged.textRules || [])
    .map((rule) => {
      const [pattern] = compileAll([rule.pattern], rule.label || 'textRule');
      return pattern ? { label: rule.label || '待确认', weight: Number(rule.weight) || 10, pattern, keyword: rule.keyword || '命中规则' } : null;
    })
    .filter(Boolean);

  return {
    autoApprove: merged.autoApprove !== false,
    thresholds: {
      review: Number(merged.thresholds?.review) || 20,
      violation: Number(merged.thresholds?.violation) || 60
    },
    categories,
    textRules,
    sectionKeywords: merged.sectionKeywords || DEFAULT_MODERATION.sectionKeywords
  };
}

function compileAll(list, label) {
  const out = [];
  for (const source of list || []) {
    try {
      out.push(new RegExp(source, 'i'));
    } catch (err) {
      console.warn(`[config] 规则「${label}」里的正则 ${JSON.stringify(source)} 无效：${err.message}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 写回：后台保存设置时，既写数据库（立即生效），也写配置文件（可版本管理）
// ---------------------------------------------------------------------------
function saveSiteToDb(patch) {
  const db = getDb();
  if (!db) throw new Error('数据库不可用，无法保存设置');
  const current = readDbSite() || {};
  const merged = deepMerge(current, patch);
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    SITE_DB_KEY, JSON.stringify(merged), new Date().toISOString()
  );
  return merged;
}

/** 把当前生效的设置写回 config/site.jsonc（失败不影响后台保存） */
function saveSiteToFile(site) {
  const file = path.join(CONFIG_DIR, 'site.jsonc');
  const payload = {
    siteName: site.siteName,
    siteTagline: site.siteTagline,
    siteDescription: site.siteDescription,
    welcomeMessage: site.welcomeMessage,
    adminContact: site.adminContact,
    footer: {
      copyright: site.footer.copyright,
      icp: site.footer.icp,
      police: site.footer.police,
      customText: site.footer.customText,
      extraLines: site.footer.extraLines,
      links: site.footer.links,
      showPoweredBy: site.footer.showPoweredBy,
      poweredByText: site.footer.poweredByText
    },
    features: site.features
  };
  try {
    const banner = [
      '// 站点配置文件 —— 改完保存后在后台点「重新加载」，或重启服务即可生效。',
      '// 也可以在后台「站点设置」页直接编辑，保存时会自动写回本文件。',
      '// 删除某个字段即恢复该字段的默认值；整个文件删掉也能正常运行。',
      ''
    ].join('\n');
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(file, banner + JSON.stringify(payload, null, 2) + '\n', 'utf8');
    return true;
  } catch (err) {
    console.warn('[config] 写回 config/site.jsonc 失败（不影响运行）：', err.message);
    return false;
  }
}

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
}

module.exports = {
  ROOT_DIR,
  CONFIG_DIR,
  USER_CONFIG_DIR,
  DEFAULT_SITE,
  DEFAULT_SECTIONS,
  DEFAULT_MODERATION,
  EDITABLE_SITE_KEYS,
  EDITABLE_FOOTER_KEYS,
  getSite,
  getSections,
  getModerationRules,
  getAiConfig,
  getRulesContent,
  saveSiteToDb,
  saveAiToDb,
  saveRulesContent,
  saveSiteToFile,
  readDbSite,
  readDbAi,
  readConfigFile,
  deepMerge,
  ensureConfigDir,
  stripComments,
  parseJsonc
};
