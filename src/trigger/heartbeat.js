/**
 * 心跳主动性：冷场时给 Bot 一个「开口的机会」（借鉴 Cortico heartbeat 思想）。
 *
 * 机制：
 * - 基线间隔 baselineSec（默认 30 分钟）定时 tick
 * - 连续空拍（tick 时群里无新消息）间隔逐次翻倍，上限 8 倍；
 *   任何外部消息到达立即 noteActivity() 复位到基线
 * - tick 不直接说话：先过冷却与日限，再把「静默时长 + 近期记忆」交给
 *   LLM 判定值不值得开口，输出一句话或空（空 = 放弃）
 * - 完全独立于 scheduler 概率门控：不参与 recordReply 闭环统计，
 *   不污染被动触发的概率模型
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { chatSync } from '../llm/client.js';
import { listActiveMemories, quietSecondsSince } from '../memory/store.js';

const log = createLogger('heartbeat');

/** 空拍回退倍率上限（与 Cortico 相同取值）。 */
export const IDLE_BACKOFF_MAX = 8;
/** 空拍数封顶：再数下去只是让 2^n 溢出。 */
export const IDLE_TICKS_MAX = Math.ceil(Math.log2(IDLE_BACKOFF_MAX));

const JUDGE_PROMPT = `你在一个 QQ 群里扮演一个普通人。群里已经安静了一段时间。

当前群静默时长：{quiet}
你最近记得的群里的事：
{memories}

请判断：此刻主动说一句话是否自然？
- 只有当你真的有值得一提的事（接续之前的话题、回应之前聊过的内容、或一句自然的随感）才说
- 不确定、勉强、为了说话而说话 → 输出空
- 说的话要短（20 字内）、口语、符合你的身份，不要解释为什么开口
- 只输出那句话本身，不要任何前后缀；放弃就输出空内容`;

export class Heartbeat {
  /**
   * @param {object} params
   * @param {(text: string) => Promise<void>} params.onSpeak 决定开口时回调（发送由调用方处理）
   * @param {() => string[]} params.conversations 活跃会话列表
   */
  constructor({ onSpeak, conversations }) {
    this.onSpeak = onSpeak;
    this.conversations = conversations;
    /** 会话 -> { timer, idleTicks, lastActivity, spokenToday, dayKey } */
    this._state = new Map();
    this._running = false;
  }

  /** 配置快捷读取（支持热改）。 */
  get enabled() {
    return Boolean(config.trigger.heartbeat?.enabled);
  }
  get baselineSec() {
    return Math.max(60, Number(config.trigger.heartbeat?.baselineSec) || 1800);
  }
  get dailyLimit() {
    return Math.max(0, Number(config.trigger.heartbeat?.dailyLimit) ?? 3);
  }
  get cooldownSec() {
    return Math.max(0, Number(config.trigger.heartbeat?.cooldownSec) || 3600);
  }

  /** 外部事件到达：复位该会话的空拍计数。 */
  noteActivity(conversationId) {
    const entry = this._state.get(conversationId);
    if (entry) entry.idleTicks = 0;
  }

  /** 下一拍间隔：基线 × 2^空拍数，封顶。 */
  nextDelaySec(idleTicks) {
    const factor = 2 ** Math.min(idleTicks, IDLE_TICKS_MAX);
    return Math.round(this.baselineSec * Math.min(factor, IDLE_BACKOFF_MAX));
  }

  start() {
    if (!this.enabled || this._running) return;
    this._running = true;
    this._armAll();
    log.info(`心跳已启动 基线=${this.baselineSec}s 日限=${this.dailyLimit}次/会话`);
  }

  stop() {
    this._running = false;
    for (const [, entry] of this._state) clearTimeout(entry.timer);
    this._state.clear();
  }

  _armAll() {
    for (const conversationId of this.conversations()) {
      this._arm(conversationId);
    }
  }

  _arm(conversationId) {
    if (!this._running || !this.enabled) return;
    let entry = this._state.get(conversationId);
    if (!entry) {
      entry = { timer: null, idleTicks: 0, spokenToday: 0, dayKey: this._dayKey() };
      this._state.set(conversationId, entry);
    }
    // 跨天重置日限
    const today = this._dayKey();
    if (entry.dayKey !== today) {
      entry.dayKey = today;
      entry.spokenToday = 0;
    }
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      this._tick(conversationId).catch((error) => log.debug('心跳 tick 异常:', error.message));
    }, this.nextDelaySec(entry.idleTicks) * 1000);
  }

  _dayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  /** 群静默秒数：最近一条消息距今多久。 */
  _quietSeconds(conversationId) {
    try {
      return quietSecondsSince(conversationId);
    } catch {
      return 0;
    }
  }

  async _tick(conversationId) {
    const entry = this._state.get(conversationId);
    if (!entry || !this.enabled) return;

    const quiet = this._quietSeconds(conversationId);
    // 群里还有动静就不算空拍（tick 白跑，但不动 idleTicks——由 noteActivity 管）

    if (entry.spokenToday >= this.dailyLimit) {
      entry.idleTicks += 1;
      this._arm(conversationId);
      return;
    }

    if (quiet < this.baselineSec) {
      // 不够安静，下一拍再说
      this._arm(conversationId);
      return;
    }

    try {
      const memories = listActiveMemories(conversationId, 5)
        .map((m) => `- ${m.judgment}`)
        .join('\n') || '（暂无）';
      const prompt = JUDGE_PROMPT
        .replace('{quiet}', `${Math.round(quiet / 60)} 分钟`)
        .replace('{memories}', memories);

      const raw = await chatSync(
        [{ role: 'system', content: prompt }],
        { temperature: 0.8, maxTokens: 100, timeoutMs: 30000, label: '心跳判定' },
      );
      const text = String(raw || '').trim();

      if (text && text.length <= 50) {
        entry.spokenToday += 1;
        entry.idleTicks = 0; // 开过口算一次有效活动
        log.info(`心跳主动发言（${conversationId}，今日第 ${entry.spokenToday} 次）: ${text}`);
        await this.onSpeak(conversationId, text);
      } else {
        entry.idleTicks += 1;
        log.debug(`心跳判定放弃（${conversationId}，空拍 ${entry.idleTicks}）`);
      }
    } catch (error) {
      entry.idleTicks += 1;
      log.debug('心跳判定失败:', error.message);
    }

    this._arm(conversationId);
  }
}
