/**
 * 表达习惯与黑话学习（借鉴 MaiBot learners 思想，JS 重写）。
 *
 * 两条路径，均不阻塞回复：
 * - 挖掘（离线）：curate 之后异步跑，LLM 从最近消息里挑"这个群怎么说"的
 *   口头禅/常用句式 和 黑话新词，存表并嵌入
 * - 注入（在线）：回复时按当前消息取相似表达 3 条 + 全部黑话表，
 *   拼进 prompt 作为风格示例——"说什么"由模型决定，"怎么说"参考本群习惯
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { chatSync } from '../llm/client.js';
import { embedText } from './vector-client.js';
import { getDb } from './store.js';
import { selectRecentMessages } from './store.js';

const log = createLogger('expression');

const MINE_PROMPT = `下面是一个 QQ 群最近的聊天记录。请从中挖掘这个群的语言习惯，输出 JSON。

要求：
1. expressions：群里反复出现或很有本群特色的口头禅、常用句式、语气梗，3~6 条，每条是原文原样的短语或短句（15 字内），不要改写。
2. jargons：群里的黑话/缩写/新梗，格式 {"term":"词","meaning":"意思"}，没有就给空数组。只收确实在本群使用、含义不明显的。
3. 只输出 JSON 对象，不要代码块和解释：{"expressions":["..."],"jargons":[{"term":"...","meaning":"..."}]}

聊天记录：
{transcript}`;

/** 挖掘节流键前缀（app_meta）。 */
const MINE_THROTTLE_PREFIX = 'expression_mine:';

/**
 * 挖掘一次表达习惯与黑话（curate 后异步调用）。
 * 节流：同会话 12 小时一次；输入取最近 60 条消息前 4000 字。
 */
export async function mineExpressions(conversationId) {
  if (!config.expression?.enabled) return { mined: 0 };
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)`);
  const last = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(`${MINE_THROTTLE_PREFIX}${conversationId}`);
  if (last && Date.now() - Number(last.value) < 12 * 3600_000) return { mined: 0, skipped: 'throttled' };

  const rows = selectRecentMessages(conversationId, 60);
  const transcript = rows
    .map((r) => (r.role === 'assistant' ? `我: ${r.content}` : `${r.speaker_name || '某人'}: ${r.content}`))
    .join('\n')
    .slice(-4000);
  if (transcript.length < 200) return { mined: 0, skipped: 'too-little' };

  db.prepare(`INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(`${MINE_THROTTLE_PREFIX}${conversationId}`, String(Date.now()));

  try {
    const raw = await chatSync(
      [{ role: 'system', content: MINE_PROMPT.replace('{transcript}', transcript) }],
      { temperature: 0.3, maxTokens: 3000, timeoutMs: 90000, label: '表达挖掘' },
    );
    const parsed = safeParseJson(raw);
    if (!parsed) return { mined: 0, reason: '解析失败' };

    let saved = 0;
    for (const expr of (parsed.expressions || []).slice(0, 6)) {
      const text = String(expr || '').trim().slice(0, 30);
      if (!text) continue;
      saved += upsertExpression(conversationId, text);
    }
    for (const item of (parsed.jargons || []).slice(0, 5)) {
      const term = String(item?.term || '').trim().slice(0, 15);
      const meaning = String(item?.meaning || '').trim().slice(0, 60);
      if (!term || !meaning) continue;
      db.prepare(`INSERT INTO jargon_terms (conversation_id, term, meaning)
        VALUES (?, ?, ?)
        ON CONFLICT(conversation_id, term)
        DO UPDATE SET meaning = excluded.meaning, updated_at = CURRENT_TIMESTAMP`)
        .run(conversationId, term, meaning);
      saved += 1;
    }
    if (saved > 0) log.info(`表达挖掘: 新增/更新 ${saved} 条（${conversationId}）`);
    return { mined: saved };
  } catch (error) {
    log.debug('表达挖掘失败:', error.message);
    return { mined: 0, error: error.message };
  }
}

/** 表达入库（同文去重：命中则 use_count+1），返回是否新增。 */
function upsertExpression(conversationId, text) {
  const db = getDb();
  const existing = db.prepare(
    `SELECT id FROM expression_habits WHERE conversation_id = ? AND expression = ?`,
  ).get(conversationId, text);
  if (existing) {
    db.prepare(`UPDATE expression_habits SET use_count = use_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(existing.id);
    return 0;
  }
  db.prepare(`INSERT INTO expression_habits (conversation_id, expression, kind) VALUES (?, ?, 'phrase')`)
    .run(conversationId, text);
  // 嵌入异步补，失败不影响使用（检索时降级按 use_count 取）
  embedText(text)
    .then((vec) => {
      if (Array.isArray(vec) && vec.length > 0) {
        db.prepare('UPDATE expression_habits SET embedding = ? WHERE conversation_id = ? AND expression = ?')
          .run(JSON.stringify(vec), conversationId, text);
      }
    })
    .catch(() => {});
  return 1;
}

/** 宽松 JSON 解析（容忍代码块包裹与前后杂文）。 */
function safeParseJson(raw) {
  const text = String(raw || '').replace(/```(?:json)?/g, '');
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * 取注入用的风格块：相似表达 3 条（向量命中，无嵌入则按热度）+ 黑话表。
 * 在线路径，全部本地查询，<10ms。
 */
export function buildStyleBlock(conversationId, queryText = '') {
  if (!config.expression?.enabled) return '';
  const db = getDb();

  const jargons = db.prepare(
    `SELECT term, meaning FROM jargon_terms WHERE conversation_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 8`,
  ).all(conversationId);

  let expressions = [];
  try {
    // 同步路径：无法 await 嵌入查询，退化为按热度取——
    // 嵌入版本留给 load-context 的并行召回（见 recallExpressionsAsync）
    expressions = db.prepare(
      `SELECT expression, use_count FROM expression_habits
       WHERE conversation_id = ? AND status = 'active'
       ORDER BY use_count DESC, updated_at DESC LIMIT 3`,
    ).all(conversationId);
  } catch {
    return '';
  }
  if (expressions.length === 0 && jargons.length === 0) return '';

  const lines = [];
  if (expressions.length > 0) {
    lines.push('这个群里常这么说（参考语气，别硬套）：');
    for (const item of expressions) lines.push(`- ${item.expression}`);
  }
  if (jargons.length > 0) {
    lines.push('群里的黑话（看不懂时参考含义）：');
    for (const item of jargons) lines.push(`- ${item.term}：${item.meaning}`);
  }
  return lines.join('\n');
}

/**
 * 异步版表达召回（带向量相似度），供 load-context 并行调用。
 * @returns {Promise<string>} 风格块（空串表示无内容）
 */
export async function recallStyleBlock(conversationId, queryText) {
  if (!config.expression?.enabled) return '';
  const db = getDb();
  const rows = db.prepare(
    `SELECT expression, embedding FROM expression_habits
     WHERE conversation_id = ? AND status = 'active'
     ORDER BY updated_at DESC LIMIT 30`,
  ).all(conversationId);
  if (rows.length === 0) return buildStyleBlock(conversationId, queryText);

  const text = String(queryText || '').trim();
  if (text) {
    try {
      const queryVec = await embedText(text);
      if (Array.isArray(queryVec) && queryVec.length > 0) {
        const scored = rows
          .map((row) => {
            const vec = row.embedding ? JSON.parse(row.embedding) : null;
            return { expression: row.expression, score: vec ? cosine(queryVec, vec) : -1 };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map((item) => item.expression);
        if (scored.length > 0) return buildStyleBlockWith(conversationId, scored);
      }
    } catch {
      // 嵌入失败退回热度版
    }
  }
  return buildStyleBlock(conversationId, queryText);
}

function cosine(a, b) {
  if (!Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 用指定表达列表渲染风格块（黑话部分复用 buildStyleBlock 的查询）。 */
function buildStyleBlockWith(conversationId, expressions) {
  const base = buildStyleBlock(conversationId, '');
  if (!base) return '';
  // 替换表达段：简单做法是重拼
  const db = getDb();
  const jargons = db.prepare(
    `SELECT term, meaning FROM jargon_terms WHERE conversation_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 8`,
  ).all(conversationId);
  const lines = ['这个群里常这么说（参考语气，别硬套）：'];
  for (const e of expressions) lines.push(`- ${e}`);
  if (jargons.length > 0) {
    lines.push('群里的黑话（看不懂时参考含义）：');
    for (const item of jargons) lines.push(`- ${item.term}：${item.meaning}`);
  }
  return lines.join('\n');
}
