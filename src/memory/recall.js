/**
 * 记忆召回：向量检索 + 关键词兜底 + 限时降级。
 *
 * 设计取舍：
 * - 限时 2.5s，超时降级到纯文本（按 importance 排序的近期记忆），
 *   不阻塞回复。宁可想起来得少，也不能让用户等。
 * - 向量服务不可达时不报错，静默降级并记录审计。
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { auditRecall, listActiveMemories, getDb } from './store.js';
import { vectorSearch } from './vector-client.js';
import { evaluateForgetGate, HALF_LIFE_BASE_DAYS } from './gate.js';

const log = createLogger('recall');

/**
 * 召回相关记忆。
 *
 * @param {string} query 查询文本（通常是当前用户消息）
 * @param {object} options
 * @param {string} options.conversationId 会话 ID，限定检索范围
 * @param {number} options.topK 返回条数
 * @param {number} options.timeoutMs 限时
 * @returns {Promise<{memories: {judgment: string, memoryType: string, score: number}[], source: string}>}
 */
export async function recallMemories(query, {
  conversationId,
  topK = config.vector.topK,
  timeoutMs = config.vector.recallTimeoutMs,
} = {}) {
  const startedAt = Date.now();
  const trimmed = String(query || '').trim();
  if (!trimmed) {
    return { memories: [], source: 'empty-query' };
  }

  const searchTask = (async () => {
    const results = await vectorSearch(trimmed, {
      topK,
      // 全局作用域（借鉴 KiraraAI GlobalScope）：__global__ 存 bot 跨群阅历，
      // 与本会话记忆一起检索
      conversationId: [conversationId, '__global__'],
      timeoutMs,
    });
    return results.map((item) => ({
      judgment: item.document || item.metadata?.judgment || '',
      memoryType: item.metadata?.memory_type || 'knowledge',
      score: item.score ?? 0,
    })).filter((item) => item.judgment);
  })();

  const timeoutTask = new Promise((resolve) => {
    setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    const results = await Promise.race([searchTask, timeoutTask]);
    const elapsedMs = Date.now() - startedAt;

    if (results === null) {
      const fallback = fallbackRecall(conversationId, topK);
      auditRecall({ conversationId, query: trimmed, hitCount: fallback.length, source: 'timeout', elapsedMs });
      log.warn(`向量召回超时 ${elapsedMs}ms，降级到近期记忆`);
      return { memories: fallback, source: 'timeout' };
    }

    auditRecall({ conversationId, query: trimmed, hitCount: results.length, source: 'vector', elapsedMs });
    markMemoriesRecalled(results);
    return { memories: results, source: 'vector' };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const fallback = fallbackRecall(conversationId, topK);
    auditRecall({ conversationId, query: trimmed, hitCount: fallback.length, source: 'error', elapsedMs });
    log.warn('向量召回失败，降级到近期记忆:', error.message);
    return { memories: fallback, source: 'error' };
  }
}

/** 降级召回：按重要度和时间取近期活跃记忆。 */
function fallbackRecall(conversationId, topK) {
  try {
    return listActiveMemories(conversationId, topK).map((row) => ({
      judgment: row.judgment,
      memoryType: row.memory_type,
      score: 0,
    }));
  } catch (error) {
    log.warn('降级召回失败:', error.message);
    return [];
  }
}

/**
 * 召回命中时更新 last_recalled_at / recalled_count，供记忆衰减判定。
 * 召回结果按 judgment 匹配（向量返回不含 memory_id），命中不了就算了——
 * 衰减是尽力而为的统计，不追求精确。
 */
function markMemoriesRecalled(results) {
  try {
    const db = getDb();
    const stmt = db.prepare(`UPDATE memory_fragments
      SET last_recalled_at = CURRENT_TIMESTAMP, recalled_count = COALESCE(recalled_count, 0) + 1
      WHERE judgment = ? AND status = 'active'`);
    const tx = db.transaction((items) => {
      for (const item of items) {
        if (item.judgment) stmt.run(item.judgment);
      }
    });
    tx(results || []);
  } catch (error) {
    log.debug('更新召回时间失败:', error.message);
  }
}

/**
 * 记忆衰减（借鉴 A-Memorix maintain 思想）：
 * 超过 decayDays 未被召回的活跃记忆 importance 降 1，降到 0 以下标记 decayed。
 * 每次最多处理 200 条；同一会话 24h 节流一次。
 */
const DECAY_THROTTLE_KEY = 'memory_decay_last_run';

export function decayMemories({ conversationId, decayDays = 90, limit = 200 } = {}) {
  // 兼容旧签名：decayDays 不再作为硬阈值，实际由遗忘门的半衰期模型决定。
  // 保留参数是为了不破坏既有调用点与配置。
  void decayDays;
  const db = getDb();
  try {
    // 节流：24h 一次
    db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)`);
    const last = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(`${DECAY_THROTTLE_KEY}:${conversationId}`);
    const lastTs = last ? Number(last.value) : 0;
    if (Date.now() - lastTs < 86_400_000) return { decayed: 0, skipped: 'throttled' };

    const run = db.transaction(() => {
      // 取候选：超过半衰期一个周期的活跃记忆才进入遗忘门，
      // 太新的不参与（避免刚写进来就被砍）
      const rows = db.prepare(`
        SELECT memory_id, importance, recalled_count,
               CAST(julianday('now') - julianday(COALESCE(last_recalled_at, created_at)) AS INTEGER) AS age_days
        FROM memory_fragments
        WHERE status = 'active'
          AND COALESCE(last_recalled_at, created_at) < datetime('now', ?)
        LIMIT ?`).all(`-${HALF_LIFE_BASE_DAYS} days`, limit);

      const { retire, demote } = evaluateForgetGate(rows);
      const demoteStmt = db.prepare(`UPDATE memory_fragments SET importance = importance - 1 WHERE memory_id = ?`);
      const retireStmt = db.prepare(`UPDATE memory_fragments SET status = 'decayed' WHERE memory_id = ?`);
      for (const id of demote) demoteStmt.run(id);
      for (const id of retire) retireStmt.run(id);

      db.prepare(`INSERT INTO app_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(`${DECAY_THROTTLE_KEY}:${conversationId}`, String(Date.now()));
      return { demoted: demote.length, retired: retire.length };
    });
    const result = run();
    if (result.demoted + result.retired > 0) {
      log.info(`遗忘门: 降权 ${result.demoted} 条，退役 ${result.retired} 条（${conversationId}）`);
    }
    return { decayed: result.demoted + result.retired };
  } catch (error) {
    log.debug('记忆衰减失败:', error.message);
    return { decayed: 0, error: error.message };
  }
}

/** 把召回结果格式化成可注入 prompt 的文本块。 */
export function formatMemoryBlock(memories) {
  if (!memories || memories.length === 0) return '';
  const lines = memories.map((item) => `- [${item.memoryType}] ${item.judgment}`);
  return `<memory>\n${lines.join('\n')}\n</memory>`;
}
