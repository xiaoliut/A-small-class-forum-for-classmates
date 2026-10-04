'use strict';

/**
 * AI 辅助审核模块
 *
 * 规则来源：config/moderation.jsonc（可在管理员后台「站点设置」页点「重新加载配置」热生效）
 *
 * 两种工作模式：
 * 1. 本地规则引擎（默认，离线可用）：按可配置规则库计算风险分与标签。
 * 2. 大模型语义审核（可选）：在 .env 里配置 AI_ENABLED=1 + AI_BASE_URL + AI_API_KEY 后，
 *    调用任意 OpenAI 兼容的 /chat/completions 接口，与规则引擎结果融合。
 *
 * 输出结构（落库到 posts.ai_* / comments.ai_*）：
 * {
 *   verdict: 'clean' | 'review' | 'violation',
 *   risk: 0-100,
 *   labels: ['广告推广', ...],
 *   summary: '给管理员看的一句结论',
 *   source: 'rules' | 'rules+ai' | 'ai' | 'disabled',
 *   hits: [{ label, weight, keyword }],
 *   advice: '给发帖人的友好提示（没有违规时为 null）'
 * }
 */

const settings = require('./settings');

/** 规则已全部经过 settings 层校验与正则编译 */
function loadRules() {
  return settings.getModerationRules();
}

/** 兼容旧引用：当前生效的规则类别（只读快照） */
function currentCategories() {
  const map = {};
  for (const item of loadRules().categories) {
    map[item.label] = { weight: item.weight, words: item.words };
  }
  return map;
}

function uniq(list) {
  return Array.from(new Set(list));
}

/** 只对规则引擎：逐条规则扫描 */
function runRules(title, content) {
  const rules = loadRules();
  const titleText = String(title || '');
  const bodyText = String(content || '');
  const text = `${titleText}\n${bodyText}`;
  const hits = [];

  for (const category of rules.categories) {
    let matched = false;
    for (const word of category.words) {
      if (word && text.includes(word)) {
        hits.push({ label: category.label, weight: category.weight, keyword: word });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    for (const pattern of category.patterns) {
      const match = text.match(pattern);
      if (match) {
        hits.push({ label: category.label, weight: category.weight, keyword: String(match[0]).slice(0, 24) });
        break;
      }
    }
  }

  for (const rule of rules.textRules) {
    const match = text.match(rule.pattern);
    if (match) {
      hits.push({ label: rule.label, weight: rule.weight, keyword: rule.keyword });
    }
  }

  const labels = uniq(hits.map((h) => h.label));
  let risk = hits.reduce((sum, h) => sum + h.weight, 0);

  // 标题全部大写 / 超过 4 个感叹号，判为情绪化或刷屏
  if (/[!！?？]{4,}/.test(titleText) || (titleText.length > 12 && titleText === titleText.toUpperCase() && /[A-Z]/.test(titleText))) {
    risk += 10;
    labels.push('标题夸张');
  }

  // 正文过短，缺少有效信息
  const meaningful = bodyText.replace(/\s+/g, '').length;
  if (meaningful > 0 && meaningful < 8) {
    risk += 5;
    labels.push('内容过短');
  }

  risk = Math.max(0, Math.min(100, risk));
  if (labels.length === 0) labels.push('正常');

  return { hits, labels: uniq(labels), risk, thresholds: rules.thresholds };
}

function verdictFromRisk(risk, thresholds) {
  if (risk >= thresholds.violation) return 'violation';
  if (risk >= thresholds.review) return 'review';
  return 'clean';
}

function buildAdvice(verdict, labels, hits) {
  if (verdict === 'clean') return null;
  const reasons = uniq(hits.map((h) => h.keyword)).slice(0, 3).join('、');
  const labelText = labels.filter((l) => l !== '正常' && l !== '内容过短').join('、') || '待人工确认';
  if (verdict === 'violation') {
    return `系统检测到这段内容可能涉及「${labelText}」${reasons ? `（命中：${reasons}）` : ''}，已提交管理员复核，通过后会正常展示。如果这是误判，可以在帖子里追加说明或联系管理员。`;
  }
  return `系统检测到「${labelText}」特征，需要管理员人工确认后才能公开展示。这不是处罚，只是多一道确认流程。`;
}

/** AI 审核总开关关闭时的直通结果 */
function disabledResult() {
  return {
    verdict: 'clean',
    risk: 0,
    labels: ['正常'],
    hits: [],
    source: 'disabled',
    summary: 'AI 审核已在站点配置中关闭，内容直接公开。',
    advice: null
  };
}

/** 是否需要人工复核（受站点与规则两处开关共同控制） */
function shouldAutoApprove() {
  const site = settings.getSite();
  const rules = loadRules();
  return site.features.aiAutoApprove !== false && rules.autoApprove !== false;
}

/** 用远程大模型做一次语义判定（失败或未配置时返回 null，自动回退离线规则库） */
async function runRemoteModel(title, content) {
  const ai = settings.getAiConfig();
  if (!ai.enabled || !ai.baseUrl || !ai.apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ai.timeoutMs);
  try {
    const response = await fetch(`${ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ai.apiKey}`
      },
      body: JSON.stringify({
        model: ai.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              '你是中学班级论坛的内容审核助手。请判断帖子是否适合在同班同学之间公开显示。' +
              '只输出 JSON，格式：{"verdict":"clean|review|violation","risk":0-100,"labels":["..."],"reason":"一句话中文说明"}。' +
              '正常的学习交流、生活分享、活动通知算 clean；含广告、联系方式、外链、辱骂、违法低俗内容的判 violation；拿不准的判 review。'
          },
          {
            role: 'user',
            content: `标题：${String(title || '').slice(0, 200)}\n正文：${String(content || '').slice(0, 2000)}`
          }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    if (!jsonText) throw new Error('模型未返回 JSON');
    const parsed = JSON.parse(jsonText);
    const verdict = ['clean', 'review', 'violation'].includes(parsed.verdict) ? parsed.verdict : 'review';
    const risk = Math.max(0, Math.min(100, Number.parseInt(parsed.risk, 10) || 0));
    const labels = Array.isArray(parsed.labels) ? parsed.labels.map(String).slice(0, 5) : [];
    return { verdict, risk, labels, reason: String(parsed.reason || '').slice(0, 200) };
  } catch (err) {
    console.warn('[ai] 远程模型审核失败，回退本地规则：', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 审核一条帖子（标题 + 正文）
 * @returns {Promise<object>} 审核结果
 */
async function moderatePost(title, content) {
  const site = settings.getSite();
  if (site.features.aiModeration === false) return disabledResult();

  const rules = runRules(title, content);
  const remote = await runRemoteModel(title, content);

  if (!remote) {
    const verdict = verdictFromRisk(rules.risk, rules.thresholds);
    return {
      verdict,
      risk: rules.risk,
      labels: rules.labels,
      hits: rules.hits,
      source: 'rules',
      summary:
        verdict === 'clean'
          ? '本地规则引擎：未发现明显违规特征，已自动通过审核。'
          : `本地规则引擎：风险分 ${rules.risk}，命中「${rules.labels.filter((l) => l !== '正常').join('、')}」，建议人工复核。`,
      advice: buildAdvice(verdict, rules.labels, rules.hits)
    };
  }

  // 双引擎融合：取更严格的一方
  const severity = { clean: 0, review: 1, violation: 2 };
  const ruleVerdict = verdictFromRisk(rules.risk, rules.thresholds);
  const verdict = severity[remote.verdict] >= severity[ruleVerdict] ? remote.verdict : ruleVerdict;
  const risk = Math.max(remote.risk, rules.risk);
  const labels = uniq([...rules.labels.filter((l) => l !== '正常'), ...remote.labels]);
  if (labels.length === 0) labels.push('正常');

  return {
    verdict,
    risk,
    labels,
    hits: rules.hits,
    source: 'rules+ai',
    summary: `规则引擎 + ${settings.getAiConfig().model} 联合判定：${remote.reason || '无补充说明'}`,
    advice: buildAdvice(verdict, labels, rules.hits)
  };
}

/** 审核一条评论（只有正文） */
async function moderateComment(content) {
  return moderatePost('', content);
}

/** 给普通成员看的「分区建议」小提示 */
function suggestSection(title, content, current) {
  const rules = loadRules();
  const text = `${title || ''}${content || ''}`;
  let best = null;
  let bestScore = 0;
  for (const [section, words] of Object.entries(rules.sectionKeywords || {})) {
    let score = 0;
    for (const word of words) if (text.includes(word)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = section;
    }
  }
  if (best && best !== current && bestScore >= 2) return best;
  return null;
}

module.exports = {
  moderatePost,
  moderateComment,
  runRules,
  suggestSection,
  shouldAutoApprove,
  currentCategories
};
