/**
 * 触发调度：决定外部消息何时进入对话流程。
 *
 * 流水线顺序（与 MaiBot v1.3.14 一致，逐条短路）：
 *   消息防抖 → 静默消费 → @/提及强制触发 → 空闲退避 → 动态门控
 *
 * 与麦麦的差异：
 * - 没有「快速反应续接 wait」，本实现单轮对话，不维护 wait 状态
 * - @ 强制触发不占用回复额度（DynamicReplyGate 默认 countForcedTurns=false）
 */
import { DynamicReplyGate, describeDecision } from './dynamic-gate.js';
import { IdleBackoffController } from './idle-backoff.js';
import { estimateReplyProbability, summarizePendingTexts } from './reply-likelihood.js';

/** 统计近期消息量与机器人发言占比的时间窗口（秒）。 */
export const RECENT_PRESENCE_WINDOW_SECONDS = 300;

export class TurnScheduler {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.gate = new DynamicReplyGate({
      thresholdScale: Number(config.trigger.thresholdScale) || 0.55,
    });
    this.idleBackoff = new IdleBackoffController({
      baseSeconds: config.trigger.idleBackoffBaseSec,
      capSeconds: config.trigger.idleBackoffCapSec,
      startCount: config.trigger.idleBackoffStartCount,
    });
    /** 当前虚拟轮次内已到达的外部消息 ID。 */
    this._roundMessageIds = new Set();
  }

  /** 记录实际发出了一次回复，供动态门控统计。 */
  recordReply() {
    this.gate.recordReply(Date.now() / 1000);
  }

  /** 记录一次 @ 强制触发。 */
  recordForcedTurn(pendingMessages) {
    const external = this._filterExternal(pendingMessages);
    const fresh = this.gate.takeUncountedMessageIds(external.map((m) => m.messageId));
    if (fresh.length > 0) {
      this.gate.recordForcedTurn(Date.now() / 1000);
    }
  }

  /**
   * 判断这批消息是否放行。
   *
   * @param {object[]} pendingMessages 待处理消息（已归一化）
   * @param {object} context 上下文快照
   * @param {boolean} context.isGroup 是否群聊
   * @param {number} context.recentSelfCount 最近 5 分钟机器人发言数
   * @param {number} context.recentTotalCount 最近 5 分钟总消息数
   * @param {number} context.secondsSinceBotMessage 距机器人上次发言秒数
   * @returns {{decision: 'trigger'|'wait'|'delay', detail: string, delaySeconds?: number}}
   */
  evaluate(pendingMessages, context) {
    const external = this._filterExternal(pendingMessages);
    if (external.length === 0) {
      return { decision: 'wait', detail: '没有新的外部消息' };
    }

    // 私聊不设门控：每条消息都是对机器人说的
    if (!context.isGroup) {
      return { decision: 'trigger', detail: '私聊不设门控' };
    }

    const frequency = this.config.trigger.frequency;

    // 静默消费必须排在强制触发之前（与麦麦一致）：
    // 频率为 0 时只消化消息不回复。这是有意的，但会导致 @ 也不回，
    // 所以 config 校验里禁止频率为 0。
    if (frequency <= 0) {
      return { decision: 'trigger', detail: '调度=静默消费（频率为 0）' };
    }

    // @/提及强制触发：绕过频率与退避
    if (this._hasForcedTrigger(external)) {
      this.recordForcedTurn(pendingMessages);
      this.idleBackoff.reset();
      return { decision: 'trigger', detail: '调度=强制触发（@或提及）' };
    }

    const now = Date.now() / 1000;
    const backoffSeconds = this.idleBackoff.getDelaySeconds(external.length, now);
    if (backoffSeconds > 0) {
      return {
        decision: 'delay',
        detail: `空闲退避中 剩余=${backoffSeconds.toFixed(2)}s`,
        delaySeconds: backoffSeconds,
      };
    }

    const probability = this._estimateProbability(external, context, now);

    // 记录本轮次的主动回复需求。
    // 之前这段逻辑单独放在 trackRoundMessages 里，但从未被调用——
    // 导致 gate 里的主动需求永远是 0，阈值只能一直用静态表的保守高值，
    // 结果普通群消息概率 0.3~0.4 永远打不过 0.5+ 的阈值，回复率低到 1.4%。
    this._recordRoundDemand(external, context, now);

    const decision = this.gate.evaluate(probability, frequency, now);
    if (decision.shouldTrigger) {
      this.gate.closeRound();
    }
    return {
      decision: decision.shouldTrigger ? 'trigger' : 'wait',
      detail: `动态门控: ${describeDecision(decision)} 频率=${frequency}`,
    };
  }

  /** 本轮结束时调用，记录是否空转以维护退避。 */
  recordCycleResult(hadReply) {
    this.idleBackoff.recordCycleResult(!hadReply);
    // 连续沉默计数：回复即清零，未回复累加（供 SILENCE_REMINDER 判定）
    this._silenceStreak = hadReply ? 0 : (this._silenceStreak || 0) + 1;
  }

  /** 连续沉默是否达到提醒阈值。 */
  shouldRemindSilence() {
    return (this._silenceStreak || 0) >= SILENCE_REMIND_THRESHOLD;
  }

  _hasForcedTrigger(messages) {
    return messages.some((message) => {
      if (message.isAt && this.config.trigger.replyOnAt) return true;
      if (message.isMentioned && this.config.trigger.replyOnMention) return true;
      return false;
    });
  }

  _filterExternal(messages) {
    return (messages || []).filter((message) => !message.isSelf);
  }

  /** 把当前轮次的主动回复需求记进 gate，供额度换算。 */
  _recordRoundDemand(external, context, now) {
    const fresh = this.gate.takeUncountedMessageIds(external.map((m) => m.messageId));
    if (fresh.length === 0) return;

    if (!this.gate.isRoundOpen(now)) {
      this._roundMessageIds = new Set();
    }
    for (const messageId of fresh) {
      this._roundMessageIds.add(messageId);
    }
    const roundMessages = external.filter((message) => this._roundMessageIds.has(message.messageId));
    const demandProbability = this._estimateProbability(roundMessages, context, now);
    this.gate.recordProactiveDemand(demandProbability, now);
  }

  _estimateProbability(messages, context, now) {
    const texts = messages.map((message) => message.text || '');
    const hasAtBot = messages.some((message) => message.isAt);
    const { atOther, hasQuestionMark, placeholderOnly } = summarizePendingTexts(texts, { hasAtBot });
    const recentMessageCount = context.recentTotalCount || 0;
    return estimateReplyProbability({
      mentionBot: messages.some((message) => message.isMentioned),
      atOther,
      hasQuestionMark,
      placeholderOnly,
      recentSelfRatio: recentMessageCount > 0 ? (context.recentSelfCount || 0) / recentMessageCount : 0,
      recentMessageCount,
      secondsSinceBotMessage: context.secondsSinceBotMessage ?? 3600,
      pendingCount: messages.length,
    }) * participationFactor(context);
  }
}

/**
 * 参与度衰减（借鉴 MaiBot heartflow 思想）：最近话题里 bot 已插话越多，
 * 再次插话的价值越低。只降不升，@/提及不受影响（它们走强制触发路径）。
 * recentSelfCount/recentTotalCount 来自 5 分钟窗口统计。
 */
function participationFactor(context) {
  const total = context.recentTotalCount || 0;
  if (total <= 0) return 1;
  const self = context.recentSelfCount || 0;
  const ratio = self / total;
  // 已占话 30% 以上开始压：占比 50% 时压到 0.4，封底 0.2
  if (ratio <= 0.3) return 1;
  return Math.max(0.2, 1 - (ratio - 0.3));
}

/**
 * 连续沉默提醒（借鉴 MaiBot mode_policy 的 wait_reminder 思想）：
 * 群里持续有消息但连续 N 批都没触发时，给下一批注入一条轻提醒——
 * 不强制开口，只让模型知道「很久没说话了」，避免无限观望。
 * bot 一旦回复立即清零。
 */
export const SILENCE_REMIND_THRESHOLD = 3;

export const SILENCE_REMINDER =
  '（你已经很久没在这个群里说话了。如果接下来的话题你真有想说的，可以自然接上一句；没有就继续保持沉默，不用勉强。）';
