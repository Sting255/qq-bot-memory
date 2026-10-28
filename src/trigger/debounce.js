/**
 * 消息防抖状态机：拟人的开批节奏（借鉴 MaiBot chat/debounce 思想，JS 重写）。
 *
 * 规则：
 * - 开批等待：群安静 quietSec / 群活跃 activeSec（活跃=上一条消息距今 ≤ quietThresholdSec）
 * - 续发等待：同人续发 sameAuthorSec（等人把话说完）/ 换人 differentAuthorSec（抢话节奏更快）
 * - @ 机器人：mentionLimitSec 压缩整批截止（被点名不该让人干等）
 * - 整批上限：batchLimitSec，无论怎么续都不能无限拖
 * - 纯表情：只把截止提前，不能延长已有批次
 * - 批次到期后：新消息不再延长本批，进下一批的上下文
 */

/** 判定「群活跃」的间隔阈值（秒）：上一条消息距今小于它视为活跃。 */
export const QUIET_THRESHOLD_SEC = 30;

/**
 * @param {object} [options] 全部可选，默认值对齐 MaiBot natural 档
 * @param {number} [options.quietSec=2] 群安静时开批等待
 * @param {number} [options.activeSec=5] 群活跃时开批等待
 * @param {number} [options.sameAuthorSec=2] 同人续发等待
 * @param {number} [options.differentAuthorSec=0.5] 换人续发等待
 * @param {number} [options.mentionLimitSec=1] @ 机器人时的整批截止
 * @param {number} [options.batchLimitSec=8] 整批硬上限
 * @param {number} [options.bareImageSec=4] 裸图（消息只有图片）至少等待
 */
export class SmartDebouncer {
  constructor({
    quietSec = 2,
    activeSec = 5,
    sameAuthorSec = 2,
    differentAuthorSec = 0.5,
    mentionLimitSec = 1,
    batchLimitSec = 8,
    bareImageSec = 4,
  } = {}) {
    this.waits = { quietSec, activeSec, sameAuthorSec, differentAuthorSec, mentionLimitSec, batchLimitSec, bareImageSec };
    /** 本批第一条消息到达时刻（秒，单调或 wall clock 均可，内部自洽） */
    this._firstAt = null;
    /** 上一条消息到达时刻（跨批保留，用于判活跃） */
    this._lastArrival = null;
    /** 上一条发言人（跨批保留，用于同人/换人判定） */
    this._lastAuthor = null;
    /** 当前批截止时刻 */
    this._deadline = null;
    /** @ 压缩出的最早截止 */
    this._urgent = null;
  }

  /**
   * 观察一条新消息，更新截止时间。
   * @param {object} params
   * @param {string} params.author 发言人 ID
   * @param {boolean} [params.isBareImage=false] 消息只有图片段
   * @param {boolean} [params.isPureEmoji=false] 纯表情/表情包
   * @param {boolean} [params.atBot=false] @ 了机器人
   * @param {number} params.now 当前时刻（秒）
   * @returns {{deadline: number|null, reason: string}} 本条消息作用后的截止与说明
   */
  observe({ author, isBareImage = false, isPureEmoji = false, atBot = false, now }) {
    const arrival = Math.max(now, this._lastArrival ?? now);
    const previousArrival = this._lastArrival;
    const previousAuthor = this._lastAuthor;
    this._lastArrival = arrival;
    this._lastAuthor = author;

    const newBatch = this._firstAt === null;
    if (newBatch) this._firstAt = arrival;

    if (atBot) {
      const urgent = now + this.waits.mentionLimitSec;
      this._urgent = this._urgent === null ? urgent : Math.min(this._urgent, urgent);
    }

    // 批次已到期：不再延长，消息进下一批上下文
    if (this._deadline !== null && this._deadline <= now) {
      return { deadline: this._deadline, reason: '批次已到期，不再延长等待' };
    }

    const reasons = [];
    const hardLimit = this._firstAt + this.waits.batchLimitSec;

    let wait;
    if (newBatch) {
      const active = previousArrival !== null && arrival - previousArrival <= QUIET_THRESHOLD_SEC;
      wait = active ? this.waits.activeSec : this.waits.quietSec;
      reasons.push(`${active ? '活跃' : '安静'}开批 ${wait}s`);
      if (isBareImage) {
        reasons.push(`裸图开批至少 ${this.waits.bareImageSec}s`);
        wait = Math.max(wait, this.waits.bareImageSec);
      }
    } else {
      wait = author === previousAuthor ? this.waits.sameAuthorSec : this.waits.differentAuthorSec;
      reasons.push(`${author === previousAuthor ? '同人续发' : '换人'} ${wait}s`);
    }

    let candidate = arrival + wait;

    // 纯表情只提前不推迟
    if (isPureEmoji && !newBatch && this._deadline !== null) {
      reasons.push('纯表情包不延长等待');
      candidate = Math.min(candidate, this._deadline);
    }
    if (this._urgent !== null && candidate > this._urgent) reasons.push(`受@提及 ${this.waits.mentionLimitSec}s 上限限制`);
    if (candidate > hardLimit) reasons.push(`受整批 ${this.waits.batchLimitSec}s 上限限制`);

    let deadline = Math.min(candidate, hardLimit);
    if (this._urgent !== null) deadline = Math.min(deadline, this._urgent);
    this._deadline = deadline;

    return { deadline, reason: reasons.join('；') };
  }

  /** 批次是否已到消费时刻。 */
  due(now) {
    return this._deadline !== null && now >= this._deadline;
  }

  /** 本批消息已被消费：清批次状态，保留上一条时间/发言人供下批判活跃与同人。 */
  consume() {
    this._firstAt = null;
    this._deadline = null;
    this._urgent = null;
  }

  /** 是否有正在攒的批次。 */
  get hasBatch() {
    return this._deadline !== null;
  }
}
