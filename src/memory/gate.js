/**
 * 记忆门控（借鉴 MemTensor MemT-1.0 的写入门 / 遗忘门思想，自行实现）。
 *
 * MemT 的核心洞察：记忆不是"只写不改"的仓库，而是要有门决定
 * 「写进来值多少分」「什么时候该忘」。我们没有它的模型，但可以把这个
 * 机制搬进现有的 SQLite 记忆库：
 *
 *   写入门 estimateWriteValue()  —— 入库时按内容特征给 importance（1~5）
 *   遗忘门 memoryRetention()     —— 定期算保留度，低于阈值降权直至退役
 *
 * 与旧实现（纯 90 天硬阈值）的区别：
 * - 旧：不看价值，一律等 90 天，重要和不重要一个待遇
 * - 新：写入就分档；遗忘用「价值 × 时间半衰 × 召回强化」连续打分，
 *       重要且常被想起的记忆能活很久，琐碎的一次性信息自然早退
 */
import { createLogger } from '../logger.js';

const log = createLogger('memory-gate');

/** 遗忘半衰期基准（天）。召回会延长它。 */
export const HALF_LIFE_BASE_DAYS = 30;
/** 保留度低于此值：直接退役（绝对值） */
export const RETIRE_THRESHOLD = 0.35;
/** 保留度跌破初始值的这个比例：降一档（相对值，避免低分记忆被立刻误伤） */
export const DEMOTE_RATIO = 0.5;
/** importance 上限 */
export const MAX_IMPORTANCE = 5;

/** 有具体事实特征的词：人名、时间、数字、偏好。这类记忆更值得留。 */
const FACT_PATTERNS = [
  /\d/,                                            // 数字（年龄、日期、数量）
  /(喜欢|讨厌|爱吃|不爱|擅长|害怕|想要|打算)/,        // 偏好与意图
  /(总是|从不|一直|每次|经常)/,                      // 习惯
  /(叫|名字是|住在|来自|在.{1,6}(工作|上学|念书))/,  // 身份信息
];

/**
 * 写入门：按内容特征估算这条记忆值多少分。
 *
 * 不用 LLM——入库是高频路径，多一次调用就多一份延迟和成本。
 * 用可解释的特征打分，宁可粗糙也好过所有记忆一律 1 分。
 *
 * @param {object} params
 * @param {string} params.judgment 记忆判断句
 * @param {string} [params.memoryType] knowledge/emotion/skill/event
 * @returns {number} 1~5 的整数
 */
export function estimateWriteValue({ judgment = '', memoryType = 'knowledge' } = {}) {
  const text = String(judgment || '');
  let score = 1;

  // 具体事实：命中任何一类加 1
  if (FACT_PATTERNS.some((re) => re.test(text))) score += 1;

  // 信息量：判断句写得太短通常是废话（"他们聊了游戏"）
  if (text.length >= 20) score += 1;
  if (text.length >= 45) score += 1;

  // 类型权重：情绪记忆对拟人陪伴最有价值，客观常识最低
  if (memoryType === 'emotion') score += 1;
  else if (memoryType === 'skill') score += 1;

  return Math.max(1, Math.min(MAX_IMPORTANCE, score));
}

/**
 * 遗忘门：计算一条记忆的保留度。
 *
 * retention = importance × 0.5^(年龄/半衰期) × (1 + 0.15×召回次数)
 *
 * 半衰期同时受两个因素拉长：
 * - importance：越重要的记忆衰减越慢（核心记忆不该因为没人提就消失）
 * - 召回次数（log2）：被想起过 3 次，半衰期再翻一倍多
 *
 * 这样「重要但少提」和「琐碎但常提」都能留住，而「琐碎又没人提」自然退场。
 *
 * @param {object} params
 * @param {number} params.importance
 * @param {number} [params.recallCount=0]
 * @param {number} params.ageDays 距上次召回（或创建）的天数
 * @returns {number} 保留度
 */
export function memoryRetention({ importance, recallCount = 0, ageDays }) {
  const imp = Math.max(0, Number(importance) || 0);
  const recalls = Math.max(0, Number(recallCount) || 0);
  const age = Math.max(0, Number(ageDays) || 0);
  // importance 3 视为中性基准，5 分记忆半衰期约 2.2 倍，1 分约 0.6 倍
  const valueFactor = 0.5 + imp / 3;
  const halfLife = HALF_LIFE_BASE_DAYS * valueFactor * (1 + Math.log2(1 + recalls));
  const timeFactor = 0.5 ** (age / halfLife);
  const recallBonus = 1 + 0.15 * recalls;
  return imp * timeFactor * recallBonus;
}

/**
 * 保留度 → 处置动作。
 *
 * 降权用相对阈值（跌破重要度的一半），退役用绝对阈值：
 * 否则 importance=1 的记忆 5 天就被降权，太粗暴。
 */
export function gateAction(retention, importance = 1) {
  if (retention < RETIRE_THRESHOLD) return 'retire';
  if (retention < Math.max(0, Number(importance) || 1) * DEMOTE_RATIO) return 'demote';
  return 'keep';
}

/**
 * 对一批记忆行执行遗忘门，返回决策（纯函数，不碰数据库，便于单测）。
 *
 * @param {object[]} rows 每行需含 importance / recalled_count / age_days
 * @returns {{retire: string[], demote: string[], keep: number}} memory_id 列表
 */
export function evaluateForgetGate(rows = []) {
  const retire = [];
  const demote = [];
  let keep = 0;
  for (const row of rows) {
    const retention = memoryRetention({
      importance: row.importance,
      recallCount: row.recalled_count,
      ageDays: row.age_days,
    });
    const action = gateAction(retention, row.importance);
    if (action === 'retire') retire.push(row.memory_id);
    else if (action === 'demote') demote.push(row.memory_id);
    else keep += 1;
  }
  if (retire.length + demote.length > 0) {
    log.debug(`遗忘门: 退役 ${retire.length} 降权 ${demote.length} 保留 ${keep}`);
  }
  return { retire, demote, keep };
}
