/**
 * 启发式记忆拉起：按节流条件主动检索长期记忆。
 *
 * 借鉴 MaiBot v1.3.14 的 src/maisaka/memory/heuristic_injector.py。
 *
 * 解决的问题：向量召回是「每轮都按当前消息查一次」。群里消息密集时，
 * 相邻两轮消息语义高度相似，查出来的记忆也差不多——重复查询纯属浪费。
 *
 * 三重节流：
 * 1. 最小间隔：距上次召回不足 N 秒不查
 * 2. 最少新增消息：新增消息不足 M 条不查
 * 3. 缓存有效期：结果缓存 T 秒，期间直接复用
 *
 * 注意这是「省」不是「费」：缓存命中时零开销。
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { formatMemoryBlock, recallMemories } from './recall.js';
import { getMessageCount } from './store.js';

const log = createLogger('heuristic');

/** 每个会话的召回状态。 */
const stateByConversation = new Map();

/**
 * 判断是否应当触发一次召回。
 *
 * @param {object} state 会话状态
 * @param {object} params
 * @param {number} params.totalMessageCount 当前消息总数
 * @param {number} params.now 当前时间戳（秒）
 * @param {number} params.minIntervalSeconds 最小间隔
 * @param {number} params.minNewMessages 最少新增消息数
 * @returns {boolean}
 */
export function shouldRecall(state, { totalMessageCount, now, minIntervalSeconds, minNewMessages }) {
  // 消息太少不触发
  if (totalMessageCount < minNewMessages) return false;

  // 最小间隔节流
  if (minIntervalSeconds > 0 && now - state.lastRecallAt < minIntervalSeconds) return false;

  // 新增消息不足不触发
  if (totalMessageCount - state.lastMessageCount < minNewMessages) return false;

  return true;
}

/**
 * 取缓存，未过期则返回。
 *
 * @param {object} state 会话状态
 * @param {number} now 当前时间戳（秒）
 * @param {number} cacheTtl 缓存有效期（秒）
 * @returns {string|null}
 */
export function getCached(state, now, cacheTtl) {
  if (!state.cachedBlock) return null;
  if (cacheTtl <= 0) return null;
  if (now >= state.cacheExpiresAt) return null;
  return state.cachedBlock;
}

/** 清理某个会话的状态。 */
export function clearConversationState(conversationId) {
  stateByConversation.delete(conversationId);
}

/**
 * 获取或创建会话状态。
 *
 * @param {string} conversationId 会话 ID
 * @returns {object}
 */
export function getState(conversationId) {
  if (!stateByConversation.has(conversationId)) {
    stateByConversation.set(conversationId, {
      lastRecallAt: 0,
      lastMessageCount: 0,
      cachedBlock: '',
      cacheExpiresAt: 0,
    });
  }
  return stateByConversation.get(conversationId);
}

/**
 * 按节流条件拉取启发式记忆块。
 *
 * @param {object} params
 * @param {string} params.conversationId 会话 ID
 * @param {string} params.queryText 当前对话文本（用于检索）
 * @param {number} [params.now] 当前时间戳（秒）
 * @returns {Promise<string>} 可直接注入的记忆块，空串表示无内容
 */
export async function pullHeuristicMemory({ conversationId, queryText, now = Date.now() / 1000 }) {
  const cfg = config.memory.heuristic;
  if (!cfg.enabled) return '';

  const state = getState(conversationId);

  // 缓存优先
  const cached = getCached(state, now, cfg.cacheTtlSec);
  if (cached !== null) return cached;

  let totalMessageCount = 0;
  try {
    totalMessageCount = getMessageCount(conversationId);
  } catch (error) {
    log.debug('取消息数失败:', error.message);
    return '';
  }

  if (!shouldRecall(state, {
    totalMessageCount,
    now,
    minIntervalSeconds: cfg.minIntervalSec,
    minNewMessages: cfg.minNewMessages,
  })) {
    return '';
  }

  const text = String(queryText || '').trim();
  if (!text) return '';

  try {
    const recall = await recallMemories(text, { conversationId });
    const block = formatMemoryBlock(recall.memories);

    state.lastRecallAt = now;
    state.lastMessageCount = totalMessageCount;
    state.cachedBlock = block;
    state.cacheExpiresAt = cfg.cacheTtlSec > 0 ? now + cfg.cacheTtlSec : 0;

    if (block) {
      log.debug(`启发式记忆拉起 conversation=${conversationId} 命中=${recall.memories.length}`);
    }
    return block;
  } catch (error) {
    log.warn('启发式记忆拉起失败:', error.message);
    return '';
  }
}
