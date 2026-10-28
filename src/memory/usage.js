/**
 * 用量统计：记录 LLM 消耗的 token 与费用。
 *
 * 为什么需要：上游返回的 usage 里，reasoning_tokens 常常占大头——
 * 一次 90 token 的调用里 56 个是模型内部思考。不记下来就看不出钱花在哪，
 * 也解释不了为什么 maxTokens 给小了会返回空内容。
 *
 * 按天累计存在 usage_daily 表里，重启不丢。
 */
import { getDb } from './store.js';
import { createLogger } from '../logger.js';

const log = createLogger('usage');

/** 表是否已确认存在。 */
let tableReady = false;
function ensureTable() {
  if (tableReady) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS usage_daily (
      day TEXT PRIMARY KEY,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      credit REAL DEFAULT 0,
      calls INTEGER DEFAULT 0
    );
  `);
  tableReady = true;
}

/** 本地日期键，按机器时区算，跨天自动分桶。 */
function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 记录一次 LLM 调用的用量。
 *
 * 上游没返回 usage 时静默跳过——统计不该影响正常调用。
 *
 * @param {object} usage 上游的 usage 对象
 */
export function recordUsage(usage) {
  if (!usage || typeof usage !== 'object') return;

  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens) || 0;
  const total = Number(usage.total_tokens) || prompt + completion;

  if (total === 0) return;

  try {
    ensureTable();
    getDb()
      .prepare(`INSERT INTO usage_daily (day, prompt_tokens, completion_tokens, reasoning_tokens, total_tokens, calls)
                VALUES (?, ?, ?, ?, ?, 1)
                ON CONFLICT(day) DO UPDATE SET
                  prompt_tokens = prompt_tokens + excluded.prompt_tokens,
                  completion_tokens = completion_tokens + excluded.completion_tokens,
                  reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
                  total_tokens = total_tokens + excluded.total_tokens,
                  calls = calls + 1`)
      .run(today(), prompt, completion, reasoning, total);
  } catch (error) {
    log.debug('记录用量失败:', error.message);
  }
}

/**
 * 汇总用量。
 *
 * @returns {{today: object, total: object, days: number}}
 */
export function getUsageSummary() {
  ensureTable();

  const empty = {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    calls: 0,
  };

  const rowToObj = (row) => (row
    ? {
      promptTokens: row.prompt_tokens || 0,
      completionTokens: row.completion_tokens || 0,
      reasoningTokens: row.reasoning_tokens || 0,
      totalTokens: row.total_tokens || 0,
      calls: row.calls || 0,
    }
    : { ...empty });

  try {
    const day = getDb().prepare('SELECT * FROM usage_daily WHERE day = ?').get(today());
    const all = getDb()
      .prepare(`SELECT SUM(prompt_tokens) p, SUM(completion_tokens) c, SUM(reasoning_tokens) r,
                       SUM(total_tokens) t, SUM(calls) n, COUNT(*) days
                FROM usage_daily`)
      .get();

    return {
      today: rowToObj(day),
      total: rowToObj({ prompt_tokens: all?.p, completion_tokens: all?.c, reasoning_tokens: all?.r, total_tokens: all?.t, calls: all?.n }),
      days: all?.days || 0,
    };
  } catch (error) {
    log.debug('读取用量失败:', error.message);
    return { today: { ...empty }, total: { ...empty }, days: 0 };
  }
}
