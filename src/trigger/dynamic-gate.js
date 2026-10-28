/**
 * 动态回复门控：按回复频率闭环控制主动回复次数。
 *
 * 移植自 MaiBot v1.3.14 的 src/maisaka/turn_trigger/dynamic_gate.py，
 * 有一处刻意改动：@ 强制触发不计入回复额度（见 recordForcedTurn 注释）。
 *
 * 核心思路不是「该不该说话」，而是「这个小时的说话额度还剩多少」：
 * - 每个虚拟轮次（40 秒内的消息归一批）计一次预计回复概率
 * - 窗口内累计「不设门控时预计会说几次」，乘以回复频率得到目标次数
 * - 实际说了几次单独统计，超了就收紧阈值，且只收紧不放宽
 */

/** 统计预计回复数与实际回复数的滑动窗口长度（秒）。 */
export const REPLY_WINDOW_SECONDS = 3600;

/** 一次 @ 强制触发预计产生的回复次数（拟合数据中的实测均值）。 */
export const FORCED_TURN_EXPECTED_REPLIES = 0.91;

/** 窗口内已评分的批次少于该值时，改用离线统计的静态阈值表。 */
export const MIN_WINDOW_SCORE_COUNT = 20;

/** 估算「不设门控时会判定几次」所用的轮次时长（秒）。 */
export const VIRTUAL_ROUND_SECONDS = 40;

/** 已计入预计回复数的消息 ID 最多保留多少个。 */
export const MAX_COUNTED_MESSAGE_IDS = 2000;

/**
 * 保留比例下限。额度用尽时若不设下限，阈值会被推到 1.00，
 * 机器人将在一整个窗口（1 小时）内完全不说话——彻底沉默比少说更难接受。
 * 0.15 对应阈值约 0.5：普通闲聊仍然不接，但内容足够有意思时还能开口。
 */
export const KEEP_RATIO_FLOOR = 0.15;

/**
 * 阈值校准系数。
 *
 * 下面那张 STATIC_KEEP_RATIO_THRESHOLDS 表来自另一个 bot 的离线统计，
 * 概率分布与这里不同：实测我们群的概率中位数只有 0.04、峰值 0.38，
 * 而表里「保留 50%」就要 0.336 的门槛，导致主动插话率恒为 0。
 * 统一乘一个系数把门槛拉到本项目的实际分布上。
 *
 * 调参口径：想让机器人更爱插话就调小，更沉默就调大。
 */
export const DEFAULT_THRESHOLD_SCALE = 0.55;

/**
 * 离线统计：保留多少比例的主动回复时对应的概率阈值，窗口数据不足时使用。
 * 例如保留 30% 时阈值为 0.430。
 */
const STATIC_KEEP_RATIO_THRESHOLDS = [
  [0.0, 1.0],
  [0.1, 0.605],
  [0.2, 0.482],
  [0.3, 0.43],
  [0.4, 0.376],
  [0.5, 0.336],
  [0.6, 0.313],
  [0.7, 0.29],
  [0.8, 0.25],
  [0.9, 0.206],
  [1.0, 0.0],
];

/** 按离线统计表线性插值出保留比例对应的概率阈值。 */
function staticThreshold(keepRatio) {
  for (let i = 0; i < STATIC_KEEP_RATIO_THRESHOLDS.length - 1; i += 1) {
    const [lowRatio, lowThreshold] = STATIC_KEEP_RATIO_THRESHOLDS[i];
    const [highRatio, highThreshold] = STATIC_KEEP_RATIO_THRESHOLDS[i + 1];
    if (keepRatio <= highRatio) {
      const progress = (keepRatio - lowRatio) / (highRatio - lowRatio);
      return lowThreshold + (highThreshold - lowThreshold) * progress;
    }
  }
  return 0;
}

export class DynamicReplyGate {
  constructor({ windowSeconds = REPLY_WINDOW_SECONDS, countForcedTurns = false, thresholdScale = DEFAULT_THRESHOLD_SCALE } = {}) {
    this.thresholdScale = thresholdScale;
    this.windowSeconds = windowSeconds;
    /**
     * 是否把 @ 强制触发计入额度。
     *
     * 麦麦默认计入（record_forced_turn），副作用是被 @ 多次后额度耗尽、
     * 主动回复归零且一小时内不恢复。QQ 群 @ 密度远高于麦麦的使用场景，
     * 这里默认改为不计入，让 @ 与主动回复互不挤占。
     */
    this.countForcedTurns = countForcedTurns;

    this._proactiveScores = []; // [{ at, probability }]
    this._forcedExpectations = []; // [{ at, value }]
    this._replyTimes = []; // [number]
    this._countedMessageIds = new Set();
    this._countedMessageOrder = [];
    this._openRoundStartedAt = null;
  }

  /** 返回尚未计入预计回复数的消息 ID，并把它们标记为已计入。 */
  takeUncountedMessageIds(messageIds) {
    const fresh = [];
    for (const messageId of messageIds || []) {
      if (!messageId || this._countedMessageIds.has(messageId)) continue;
      fresh.push(messageId);
      this._countedMessageIds.add(messageId);
      this._countedMessageOrder.push(messageId);
    }
    while (this._countedMessageOrder.length > MAX_COUNTED_MESSAGE_IDS) {
      this._countedMessageIds.delete(this._countedMessageOrder.shift());
    }
    return fresh;
  }

  /** 当前是否仍处在一个尚未结束的虚拟轮次内。 */
  isRoundOpen(now) {
    return this._openRoundStartedAt !== null && now - this._openRoundStartedAt < VIRTUAL_ROUND_SECONDS;
  }

  /** 记录当前虚拟轮次预计带来的回复次数；轮次未结束时覆盖该轮次已记录的概率。 */
  recordProactiveDemand(probability, now) {
    if (this.isRoundOpen(now) && this._proactiveScores.length > 0) {
      const last = this._proactiveScores[this._proactiveScores.length - 1];
      last.probability = probability;
      return;
    }
    this._openRoundStartedAt = now;
    this._proactiveScores.push({ at: now, probability });
  }

  /** 对话流程已实际运行，结束当前虚拟轮次。 */
  closeRound() {
    this._openRoundStartedAt = null;
  }

  /** 记录一次 @ 强制触发；对话流程随即运行，当前虚拟轮次同时结束。 */
  recordForcedTurn(now) {
    this.closeRound();
    if (this.countForcedTurns) {
      this._forcedExpectations.push({ at: now, value: FORCED_TURN_EXPECTED_REPLIES });
    }
  }

  /** 记录对话流程实际发出了一次回复。 */
  recordReply(now) {
    this._replyTimes.push(now);
  }

  _prune(now) {
    const expireBefore = now - this.windowSeconds;
    this._proactiveScores = this._proactiveScores.filter((item) => item.at >= expireBefore);
    this._forcedExpectations = this._forcedExpectations.filter((item) => item.at >= expireBefore);
    this._replyTimes = this._replyTimes.filter((at) => at >= expireBefore);
  }

  /**
   * 判断当前这批待处理消息是否放行。
   *
   * @param {number} probability 本批消息的回复概率
   * @param {number} frequency 回复频率 0~1
   * @param {number} now 当前时间戳（秒）
   * @returns {{shouldTrigger: boolean, probability: number, threshold: number,
   *   expectedReplies: number, targetReplies: number, actualReplies: number, keepRatio: number}}
   */
  evaluate(probability, frequency, now) {
    this._prune(now);

    const proactiveScores = this._proactiveScores.map((item) => item.probability);
    const expectedProactive = proactiveScores.reduce((sum, value) => sum + value, 0);
    const expectedForced = this._forcedExpectations.reduce((sum, item) => sum + item.value, 0);
    const expectedTotal = expectedProactive + expectedForced;
    const actualReplies = this._replyTimes.length;
    const normalizedFrequency = Math.min(1, Math.max(0, Number(frequency) || 0));
    const targetReplies = normalizedFrequency * expectedTotal;

    let keepRatio;
    if (normalizedFrequency >= 1) {
      keepRatio = 1;
    } else if (expectedProactive <= 0) {
      keepRatio = normalizedFrequency;
    } else {
      const feedforwardRatio = (targetReplies - expectedForced) / expectedProactive;
      // 反馈项只在超出目标时收紧，不因「还没说够」而放宽：
      // 一波消息刚到时预计数先涨、实际回复还没跟上，此时放宽会导致系统性偏多。
      const feedbackFactor = Math.min(1, Math.max(0, 1 + (targetReplies - actualReplies) / Math.max(1, targetReplies)));
      keepRatio = Math.min(1, Math.max(0, feedforwardRatio * feedbackFactor));
    }

    // 保底：超出额度时阈值会被推到 1.00，等于彻底哑火一小时。
    // 留一个下限，让它仍能对「特别值得说」的内容开口（阈值约 0.5），
    // 而不是完全沉默——彻底不回复比少说几句更不像人。
    // 频率为 0 是「静默消费」的专用语义，不受保底影响。
    if (normalizedFrequency > 0) {
      keepRatio = Math.max(KEEP_RATIO_FLOOR, keepRatio);
    }

    // 硬性额度：目标次数就是上限，超出后直接闭嘴等窗口滑过。
    // 只靠阈值做不到这一点——保留比例有下限、阈值又随观测分布浮动，
    // 实测出现过「目标 1.8 条，实际说了 31 条」的情况。
    // 最小额度保 1：目标不足 1 时也给一次机会。
    const replyBudget = Math.max(1, Math.ceil(targetReplies));
    if (actualReplies >= replyBudget) {
      return {
        shouldTrigger: false,
        probability,
        threshold: 1,
        expectedReplies: expectedTotal,
        targetReplies,
        actualReplies,
        keepRatio,
        blockedByBudget: true,
      };
    }

    const rawThreshold = this._resolveThreshold(proactiveScores, expectedProactive, keepRatio);
    // 频率为 0 是「静默消费」：阈值保持 1.0，不做校准缩放
    const threshold = normalizedFrequency > 0 ? rawThreshold * this.thresholdScale : rawThreshold;

    return {
      shouldTrigger: probability >= threshold,
      probability,
      threshold,
      expectedReplies: expectedTotal,
      targetReplies,
      actualReplies,
      keepRatio,
    };
  }

  _resolveThreshold(proactiveScores, expectedProactive, keepRatio) {
    if (keepRatio >= 1) return 0;
    if (keepRatio <= 0) return 1;
    if (proactiveScores.length < MIN_WINDOW_SCORE_COUNT) {
      return staticThreshold(keepRatio);
    }
    // 按概率从高到低累计，累计到保留额度时的概率即阈值
    const budget = keepRatio * expectedProactive;
    let accumulated = 0;
    for (const score of [...proactiveScores].sort((a, b) => b - a)) {
      accumulated += score;
      if (accumulated >= budget) return score;
    }
    return 0;
  }
}

/** 供日志使用的可读描述。 */
export function describeDecision(decision) {
  const base =
    `概率=${decision.probability.toFixed(2)} 阈值=${decision.threshold.toFixed(2)} ` +
    `预计回复=${decision.expectedReplies.toFixed(1)} 目标=${decision.targetReplies.toFixed(1)} ` +
    `已回复=${decision.actualReplies} 保留比例=${decision.keepRatio.toFixed(2)}`;
  return decision.blockedByBudget ? `${base}（本小时额度已用尽）` : base;
}
