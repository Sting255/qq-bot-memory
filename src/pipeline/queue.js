/**
 * 会话队列：同一会话的批次串行处理（借鉴 AstrBot follow_up 的顺序思想）。
 *
 * handler 原有 _busy Set 的行为是「处理中直接丢弃新批」。
 * 丢弃在「上一条还在生成、用户又补了一句」时体验差——补的那句永远没回应。
 * 这里改为默认排队：前一批处理完立刻处理下一批（此时防抖缓冲也已把
 * 连发消息并成一批）。排队上限防止极端刷屏时积压。
 */
export class ConversationQueue {
  /**
   * @param {object} params
   * @param {number} [params.maxPending] 每个会话最多排队的批次数，超过则丢弃（默认 2）
   */
  constructor({ maxPending = 2 } = {}) {
    this.maxPending = maxPending;
    /** conversationId -> { running: boolean, queue: Array<() => Promise<void>> } */
    this._entries = new Map();
  }

  /**
   * 提交任务。若该会话空闲则立即执行，否则入队。
   * @param {string} conversationId
   * @param {() => Promise<void>} task
   * @returns {boolean} 是否被接收（false = 队列已满被丢弃）
   */
  submit(conversationId, task) {
    let entry = this._entries.get(conversationId);
    if (!entry) {
      entry = { running: false, queue: [] };
      this._entries.set(conversationId, entry);
    }

    if (entry.running) {
      if (entry.queue.length >= this.maxPending) return false;
      entry.queue.push(task);
      return true;
    }

    entry.running = true;
    // 任务抛错不能让 rejection 无人处理，也不能卡住队列（finally 里已接力下一个）
    this._run(conversationId, entry, task).catch(() => {});
    return true;
  }

  async _run(conversationId, entry, task) {
    try {
      await task();
    } finally {
      const next = entry.queue.shift();
      if (next) {
        this._run(conversationId, entry, next);
      } else {
        entry.running = false;
        this._entries.delete(conversationId);
      }
    }
  }
}
