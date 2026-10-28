/**
 * 空闲退避：连续空转后按指数退避，避免反复唤醒烧 token。
 *
 * 移植自 MaiBot v1.3.14 的 src/maisaka/turn_trigger/idle_backoff.py。
 */

/** 连续空转到第几次开始退避。 */
export const DEFAULT_START_COUNT = 3;

export class IdleBackoffController {
  constructor({ baseSeconds = 30, capSeconds = 600, startCount = DEFAULT_START_COUNT } = {}) {
    this.baseSeconds = Math.max(0, baseSeconds);
    this.capSeconds = Math.max(0, capSeconds);
    this.startCount = Math.max(1, startCount);
    this._count = 0;
    this._until = 0;
  }

  _getBackoffSeconds() {
    if (this.baseSeconds <= 0 || this.capSeconds <= 0) return 0;
    if (this._count < this.startCount) return 0;
    const exponent = Math.max(0, this._count - this.startCount);
    return Math.min(this.capSeconds, this.baseSeconds * 2 ** exponent);
  }

  /** 清理连续空闲退避状态。 */
  reset() {
    this._count = 0;
    this._until = 0;
  }

  /**
   * 按整轮结束原因维护退避状态。
   * 只有「空转结束」的原因才累加计数，实际有动作则清零。
   *
   * @param {boolean} isIdleReason 本轮是否属于空转结束
   */
  recordCycleResult(isIdleReason) {
    if (!isIdleReason) {
      this.reset();
      return;
    }
    this._count += 1;
    this._until = Date.now() / 1000 + this._getBackoffSeconds();
  }

  /**
   * 返回剩余退避秒数；0 表示可以继续。
   * 有待处理消息时不应退避——真实新消息应当打断退避。
   *
   * @param {number} pendingCount 当前待处理消息数
   * @param {number} [now] 当前时间戳（秒）
   */
  getDelaySeconds(pendingCount, now = Date.now() / 1000) {
    if (pendingCount > 0) return 0;
    const remaining = this._until - now;
    return remaining > 0 ? remaining : 0;
  }

  get count() {
    return this._count;
  }
}
