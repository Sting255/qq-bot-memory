/**
 * 消息处理主流程：串起适配器 → 触发判定 → 对话 → 记忆。
 *
 * 职责边界：本模块只做编排，不含业务规则。
 * 判定在 trigger/，拟人在 persona/，记忆在 memory/，对话在 chat/。
 */
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { normalizeEvent, shouldSkipMessage } from '../adapters/normalize.js';
import { TurnScheduler, SILENCE_REMINDER } from '../trigger/scheduler.js';
import { respond } from '../chat/orchestrator.js';
import { createImage, isGenerating } from '../chat/image.js';
import { synthesize } from '../chat/tts.js';
import { detectTools, IMAGE_HINT, VOICE_HINT } from '../pipeline/tools.js';
import { ConversationQueue } from '../pipeline/queue.js';
import { friendlyError } from '../pipeline/errors.js';
import { sanitizeSpeakerName } from '../security/sanitize.js';
import { Heartbeat } from '../trigger/heartbeat.js';
import { SmartDebouncer } from '../trigger/debounce.js';
import {
  getConversationState,
  incrementRound,
  insertAssistantMessage,
  insertUserMessage,
  getLatestRawId,
  getRecentActivity,
  listActiveConversations,
} from '../memory/store.js';
import { curateMemories } from '../memory/curate.js';
import { decayMemories } from '../memory/recall.js';
import { mineExpressions } from '../memory/expression.js';
import { MemoryIndexWorker } from '../memory/index-worker.js';

const log = createLogger('handler');

/** 消息防抖：SmartDebouncer 状态机 + 会话缓冲（拟人开批节奏，借鉴 MaiBot）。 */
class DebounceBuffer {
  constructor({ config, onFlush }) {
    this.onFlush = onFlush;
    /** conversationId -> { debouncer, messages, timer } */
    this._buffers = new Map();
    this._waits = {
      quietSec: config.trigger.debounce?.quietSec ?? config.trigger.debounceSec ?? 2,
      activeSec: config.trigger.debounce?.activeSec ?? 5,
      sameAuthorSec: config.trigger.debounce?.sameAuthorSec ?? 2,
      differentAuthorSec: config.trigger.debounce?.differentAuthorSec ?? 0.5,
      mentionLimitSec: config.trigger.debounce?.mentionLimitSec ?? 1,
      batchLimitSec: config.trigger.debounce?.batchLimitSec ?? 8,
      bareImageSec: config.trigger.debounce?.bareImageSec ?? 4,
    };
  }

  push(message) {
    const key = message.conversationId;
    let entry = this._buffers.get(key);
    if (!entry) {
      entry = {
        debouncer: new SmartDebouncer(this._waits),
        messages: [],
        timer: null,
      };
      this._buffers.set(key, entry);
    }

    entry.messages.push(message);
    const observed = entry.debouncer.observe({
      author: message.senderId,
      isBareImage: message.images?.length > 0 && !message.text?.trim(),
      isPureEmoji: /^\[[^\]]{1,12}\]$/.test(message.text?.trim() || ''),
      atBot: Boolean(message.isAt),
      now: Date.now() / 1000,
    });
    log.debug(`防抖 ${key}: ${observed.reason}`);
    if (typeof observed.deadline === 'number') {
      clearTimeout(entry.timer);
      const delayMs = Math.max(0, (observed.deadline - Date.now() / 1000) * 1000);
      entry.timer = setTimeout(() => this._flush(key), delayMs);
    }
  }

  _flush(key) {
    const entry = this._buffers.get(key);
    if (!entry) return;
    this._buffers.delete(key);
    clearTimeout(entry.timer);
    entry.debouncer.consume();
    this.onFlush(key, entry.messages).catch((error) => {
      log.error('批次处理失败:', error.message);
    });
  }

  clear() {
    for (const [, entry] of this._buffers) clearTimeout(entry.timer);
    this._buffers.clear();
  }
}

export class MessageHandler {
  constructor({ client }) {
    this.client = client;
    this.scheduler = new TurnScheduler({ config, logger: log });
    this.indexWorker = new MemoryIndexWorker({ concurrency: 1 });
    this.debounce = new DebounceBuffer({
      config,
      onFlush: (conversationId, messages) => this._handleBatch(conversationId, messages),
    });
    /** 心跳主动性：冷场时给开口机会（默认关，见 config trigger.heartbeat） */
    this.heartbeat = new Heartbeat({
      conversations: () => listActiveConversations(20),
      onSpeak: (conversationId, text) => this._speakProactively(conversationId, text),
    });
    /** 会话队列：同一会话批次串行，处理中到达的排队而非丢弃（上限 2） */
    this.queue = new ConversationQueue({ maxPending: 2 });
    /** 会话 -> 正在整理记忆，避免并发调 LLM */
    this._curating = new Set();
    /** 会话 -> 上次生图时间戳，用于冷却控制 */
    this._lastImageAt = new Map();
    /** 会话 -> 上次被 @ 的时刻（ms）。用于把「@ 之后紧跟的图片」串起来：
     *  QQ 里 @ 和图片常是两条消息，图片晚几秒到且不带 @，
     *  没有这个衔接就会先答一句没看到图的回复。 */
    this._lastMentionAt = new Map();
    /** 会话 -> 已为哪条待看图消息补过识图回复，避免重复 */
    this._imageFollowUpDone = new Set();
    /** 会话 -> 正在合成语音，避免同一会话并发合成排队卡死 */
    this._voiceBusy = new Set();
    /** 机器人自己的 QQ 号，连接就绪后由 get_login_info 填充。 */
    this._selfId = String(config.onebot.selfId || '');
  }

  /** 设置机器人 QQ 号（自动获取或手工配置）。 */
  setSelfId(selfId) {
    this._selfId = String(selfId || '');
    config.onebot.selfId = this._selfId;
  }

  get selfId() {
    return this._selfId;
  }

  start() {
    this.indexWorker.start();
    this.heartbeat.start();
    // 上次进程如果崩在发送途中，临时图会留在 outbox 里，启动时清掉
    try {
      const dir = resolve(config.dataDir, 'outbox');
      if (existsSync(dir)) {
        for (const name of readdirSync(dir)) {
          try {
            unlinkSync(resolve(dir, name));
          } catch {
            // 单个删不掉不影响启动
          }
        }
      }
    } catch {
      // 清理失败不是错误
    }
  }

  stop() {
    this.indexWorker.stop();
    this.heartbeat.stop();
    this.debounce.clear();
  }

  /** OneBot 事件入口。 */
  handleEvent(event) {
    const message = normalizeEvent(event, {
      selfId: this._selfId,
      ignoreForward: config.forward.ignore,
    });
    if (!message) return;

    // 自己发的消息直接忽略，不写库不判定
    if (shouldSkipMessage(message)) {
      if (message.forwardOnly) {
        log.debug(`忽略纯转发消息 from=${message.senderName}`);
      }
      return;
    }

    // 昵称提及识别（默认关闭，QQ 群名片易误判）
    if (config.trigger.replyOnMention && !message.isAt) {
      message.isMentioned = detectMention(message.text, config.trigger.nicknames);
    }

    // 转发占位消息仍然写库（维持时间线），但不触发判定
    this._persistUserMessage(message);

    // 记忆整理独立于回复：群里聊了 40 条但 bot 一句没说，也该整理。
    // 之前只在回复后触发，导致不说话的群消息永远进不了记忆库。
    this._maybeCurate(message.conversationId);

    if (message.forwardOnly) return;

    // 记下 @ 时刻，供「@ 后紧跟图片」的补看图判断
    if (message.isAt || message.isMentioned) {
      this._lastMentionAt.set(message.conversationId, Date.now());
    }

    // 图片消息：记一行便于排查识图链路（URL 可能是带签名的临时地址）
    if (message.images?.length) {
      log.debug(`收到图片 ${message.images.length} 张: ${String(message.images[0]).slice(0, 100)}`);
    }

    // 消息到达：心跳空拍复位（群里越热闹越不需要它开口）
    this.heartbeat.noteActivity(message.conversationId);

    this.debounce.push(message);
  }

  /** 检查并异步执行记忆整理。不阻塞消息处理。 */
  _maybeCurate(conversationId) {
    if (!config.memory.enabled) return;
    // 防重入：同一会话正在整理时跳过，避免并发调 LLM
    if (this._curating.has(conversationId)) return;

    try {
      const latestId = this._latestRawId(conversationId);
      if (!latestId) return;

      this._curating.add(conversationId);
      curateMemories(conversationId, latestId, { assistantLabel: '我' })
        .then((outcome) => {
          if (outcome?.saved > 0) {
            this.indexWorker.wake();
            log.info(`记忆整理完成: 新增 ${outcome.saved} 条（${conversationId}）`);
          }
          // 顺带跑一次记忆衰减（内部 24h 节流，几乎零开销）
          decayMemories({ conversationId });
          // 表达习惯/黑话挖掘（内部 12h 节流，LLM 离线跑）
          mineExpressions(conversationId).catch(() => {});
        })
        .catch((error) => log.debug('记忆整理跳过:', error.message))
        .finally(() => this._curating.delete(conversationId));
    } catch (error) {
      this._curating.delete(conversationId);
      log.debug('记忆整理检查失败:', error.message);
    }
  }

  /**
   * 被引用消息里如果有图片，取回并挂到当前消息上。
   * 只在「当前消息没有图 + 有 replyToId」时执行，失败静默跳过。
   */
  async _enrichQuotedImages(message) {
    if (message.images?.length || !message.replyToId) return;
    try {
      const res = await this.client.call(
        'get_msg',
        { message_id: Number(message.replyToId) },
        4000,
      );
      const segments = res?.message ?? res?.data?.message ?? [];
      if (!Array.isArray(segments)) return;
      const urls = segments
        .filter((seg) => seg?.type === 'image')
        .map((seg) => seg?.data?.url || seg?.data?.file || '')
        .filter(Boolean);
      if (urls.length > 0) {
        message.images = urls;
        log.info(`引用消息里取到 ${urls.length} 张图片，将做识图`);
      }
    } catch (error) {
      log.debug('取被引用消息失败:', error.message);
    }
  }

  _persistUserMessage(message) {
    // 入库前消毒发言者名：群名片完全由用户控制，可能带冒号换行伪造 prompt 结构。
    // 名字必须在这里就干净，否则入库后存成 "名字: 内容"，拆分时已分不清边界。
    const safeSpeaker = sanitizeSpeakerName(message.senderName);
    const content = message.isGroup ? `${safeSpeaker}: ${message.text}` : message.text;
    try {
      insertUserMessage({
        conversationId: message.conversationId,
        content,
        speakerId: message.senderId,
        speakerName: safeSpeaker,
        clientMsgId: message.messageId,
      });
    } catch (error) {
      log.error('消息入库失败:', error.message);
    }
  }

  async _handleBatch(conversationId, messages) {
    const accepted = this.queue.submit(conversationId, () => this._processBatch(conversationId, messages));
    if (!accepted) {
      log.debug(`会话 ${conversationId} 排队已满，丢弃本批`);
    }
  }

  async _processBatch(conversationId, messages) {
    try {
      const latest = messages[messages.length - 1];

      // 引用了一张图片并让机器人看：图片在被引用的那条消息里，
      // 当前消息的 images 是空的。取回原消息把图片补进来，否则它会答
      // 「我看不到图」「这个我不接」。
      await this._enrichQuotedImages(latest);

      const context = this._buildContext(conversationId, latest.isGroup);
      let decision = this.scheduler.evaluate(messages, context);

      // 「@ 之后紧跟的图片」：用户在 QQ 里通常先发 @+文字，再单独发图。
      // 图片消息不带 @，按普通消息判定会被直接忽略，用户就会觉得「它看不见图」。
      // 这里把 30 秒内紧跟 @ 的纯图片视为强制触发，补一次识图回复。
      const mentionAt = this._lastMentionAt.get(conversationId) || 0;
      const imageFollowUp = Boolean(
        latest.images?.length
        && !latest.isAt
        && Date.now() - mentionAt < 30_000
        && !this._imageFollowUpDone.has(latest.messageId),
      );
      if (imageFollowUp && decision.decision !== 'trigger') {
        decision = { decision: 'trigger', detail: '调度=强制触发（@ 后的图片）' };
        this._imageFollowUpDone.add(latest.messageId);
        log.info(`触发 ${conversationId}: @ 后紧跟图片，补看图回复`);
      }

      // 生图/语音检测拆到 pipeline/tools.js；这里只拿结果做决策
      const { imageRequest, voiceRequest, imageStarted } = await detectTools({
        message: latest,
        startImageJob: (msg, req) => this._startImageJob(msg, req),
      });

      // 未触发是常态，降到 debug；只有真正触发才值得看
      if (imageRequest.matched) {
        log.info(`触发 ${conversationId}: 生图请求`);
      } else if (voiceRequest.matched) {
        log.info(`触发 ${conversationId}: 语音请求`);
      } else if (decision.decision === 'trigger') {
        log.info(`触发 ${conversationId}: ${decision.detail}`);
      } else {
        log.debug(`未触发 ${conversationId}: ${decision.decision} ${decision.detail}`);
      }

      if (!imageRequest.matched && !voiceRequest.matched && decision.decision !== 'trigger') {
        this.scheduler.recordCycleResult(false);
        return;
      }

      // 静默消费：只写库不回复。生图/语音请求不走这条——人家明确要图要声，不该装没看见
      if (!imageRequest.matched && !voiceRequest.matched && decision.detail.includes('静默消费')) {
        return;
      }

      const result = await respond({
        message: latest,
        client: this.client,
        assistantLabel: '我',
        imageHint: imageStarted ? IMAGE_HINT : '',
        voiceHint: voiceRequest.matched ? VOICE_HINT : '',
        // 语音请求只发语音，文字只用来合成，不重复打在群里
        silent: voiceRequest.matched,
        // 连续沉默多批后轻提醒一次：不强制开口，只给感知（bot 回复即自动清零）
        silenceReminder: this.scheduler.shouldRemindSilence() ? SILENCE_REMINDER : '',
      });

      if (!result.replied) {
        this.scheduler.recordCycleResult(false);
        return;
      }

      // 语音请求：把刚生成的那句回复合成语音发出去，和文字并行不阻塞后续
      if (voiceRequest.matched && result.segments.length > 0) {
        this._sendVoice(latest, result.segments.join('，'))
          .catch((error) => log.error('语音发送异常:', error.message));
      }

      // 记录回复，供频率闭环统计。
      // 只有「主动插话」才占额度：@ / 提及 / 生图 / 语音是用户点名要的回复，
      // 算进配额会让机器人在被叫几次后一小时内彻底哑火（阈值被顶到 1.00）。
      const forced = decision.detail.includes('强制触发');
      const userRequested = imageRequest.matched || voiceRequest.matched;
      if (!forced && !userRequested) {
        this.scheduler.recordReply();
      }
      this.scheduler.recordCycleResult(true);

      insertAssistantMessage({
        conversationId,
        content: result.segments.join('\n'),
        segments: result.segments,
      });

      // 轮次 +1，达标则异步整理记忆
      const state = incrementRound(conversationId);
      if (config.memory.enabled) {
        curateMemories(conversationId, this._latestRawId(conversationId), { assistantLabel: '我' })
          .then((outcome) => {
            if (outcome.saved > 0) this.indexWorker.wake();
          })
          .catch((error) => log.error('记忆整理异常:', error.message));
      }

      log.debug(`轮次 ${state.total_rounds} 待整理 ${state.rounds_since_curate}`);
    } catch (error) {
      log.error('处理批次异常:', error.message);
      // 错误翻译：完全没回复时给群友一句人话，而不是沉默（60s 频控）
      const fallback = friendlyError(conversationId, error.message);
      if (fallback) {
        const latest = messages[messages.length - 1];
        this._sendPlain(latest, fallback).catch((e) => log.debug('错误提示发送失败:', e.message));
      }
    }
  }

  /**
   * 心跳主动发言：把判定出的一句话发出去并入库。
   * 不走 scheduler 统计——主动开口不该影响被动触发的概率闭环。
   */
  async _speakProactively(conversationId, text) {
    // 会话 ID 约定：qq_group_<群号> / qq_private_<QQ号>（见 adapters/normalize.js）
    const isGroup = conversationId.startsWith('qq_group_');
    const targetId = conversationId.split('_').pop();
    try {
      const segments = [{ type: 'text', data: { text } }];
      if (isGroup) {
        await this.client.sendGroupMsg(targetId, segments);
      } else {
        await this.client.sendPrivateMsg(targetId, segments);
      }
      insertAssistantMessage({ conversationId, content: text, segments: [text] });
    } catch (error) {
      log.error('心跳发言发送失败:', error.message);
    }
  }

  /**
   * 构造触发判定需要的上下文快照。
   *
   * recentSelfCount / recentTotalCount 必须是真实统计：
   * 概率模型用它们算「自己发言占比」和「群活跃度」——
   * 比例高说明自己说太多了，该收敛；消息多说明群里正热，别乱插。
   * 之前这两个值硬编码成 0，等于把这两个特征废掉了。
   */
  _buildContext(conversationId, isGroup) {
    const state = getConversationState(conversationId);
    const now = Math.floor(Date.now() / 1000);
    const lastBotAt = state.last_bot_message_at ?? null;

    let recentSelfCount = 0;
    let recentTotalCount = 0;
    try {
      const stats = getRecentActivity(conversationId, 300);
      recentSelfCount = stats.selfCount;
      recentTotalCount = stats.totalCount;
    } catch (error) {
      log.debug('取近期活跃度失败:', error.message);
    }

    return {
      isGroup,
      recentSelfCount,
      recentTotalCount,
      secondsSinceBotMessage: lastBotAt ? Math.max(0, now - lastBotAt) : 3600,
    };
  }

  /**
   * 异步生图并补发图片。
   *
   * 不 await 是有意的：生图要十几秒，等它会把文字回复一起拖住。
   * 这里只负责启动，结果通过 promise 回调补发。
   *
   * @param {object} message 触发消息
   * @param {{matched: boolean, scene?: string}} request 识别结果
   * @returns {boolean} 是否真的启动了任务（冷却或并发中被拒则 false）
   */
  _startImageJob(message, request) {
    const conversationId = message.conversationId;

    if (isGenerating(conversationId)) {
      log.debug(`生图任务进行中，跳过（${conversationId}）`);
      return false;
    }

    const cooldownMs = Math.max(0, config.image.cooldownSec) * 1000;
    const lastAt = this._lastImageAt.get(conversationId) || 0;
    if (cooldownMs > 0 && lastAt > 0 && Date.now() - lastAt < cooldownMs) {
      const remainSec = Math.ceil((cooldownMs - (Date.now() - lastAt)) / 1000);
      log.info(`生图冷却中，还需 ${remainSec}s（${conversationId}）`);
      return false;
    }

    this._lastImageAt.set(conversationId, Date.now());
    log.info(`生图请求: "${request.scene || '(按上下文取景)'}" (${conversationId})`);

    createImage({
      conversationId,
      scene: request.scene,
      requestText: message.text,
      speakerName: message.senderName,
    })
      .then((result) => {
        if (!result?.buffer) {
          // message 为空表示无需提示（如并发跳过），非空才是要给用户看的
          return result?.message ? this._sendPlain(message, result.message) : undefined;
        }
        return this._sendImage(message, result.buffer);
      })
      .catch((error) => log.error('生图任务异常:', error.message));

    return true;
  }

  /**
   * 合成并发送语音。
   *
   * 和发图一样走本地文件路径，NapCat 内部会转成 QQ 用的 silk 格式。
   */
  async _sendVoice(message, text) {
    const key = message.conversationId;

    // 同一个会话同时只合成一条：并发会让请求排队，实测有卡到 68 秒的情况
    if (this._voiceBusy.has(key)) {
      log.info('该会话语音合成中，跳过本次');
      return;
    }
    this._voiceBusy.add(key);

    try {
      let buffer;
      try {
        buffer = await synthesize({ text });
      } catch (error) {
        // 语音没合成出来就退回文字，至少别让对方什么都收不到
        log.error('语音合成失败，改用文字发送:', error.message);
        await this._sendPlain(message, text);
        return;
      }

      let tempPath = '';
      try {
        const dir = resolve(config.dataDir, 'outbox');
        mkdirSync(dir, { recursive: true });
        tempPath = resolve(dir, `voice_${Date.now()}.wav`);
        writeFileSync(tempPath, buffer);
      } catch (error) {
        log.error('写语音文件失败:', error.message);
        return;
      }

      try {
        const segments = [{ type: 'record', data: { file: tempPath.replace(/\\/g, '/') } }];
        const result = message.isGroup
          ? await this.client.sendGroupMsg(message.groupId, segments)
          : await this.client.sendPrivateMsg(message.senderId, segments);
        log.info(`语音已发送 字节=${buffer.length} message_id=${result?.message_id ?? '未知'}`);
      } catch (error) {
        log.error('语音发送失败:', error.message);
      } finally {
        setTimeout(() => {
          try {
            unlinkSync(tempPath);
          } catch {
            // 已清理过就算了
          }
        }, 60000);
      }
    } finally {
      this._voiceBusy.delete(key);
    }
  }

  /**
   * 发送图片消息。
   *
   * 优先写本地文件让 NapCat 自己读：同样一张 1.5MB 的图，base64 要在
   * WebSocket 上塞 2MB 字符串，实测上传近 4 秒；给本地路径实测 0.4~2.4 秒。
   * 写文件或按路径发送失败时回退 base64，保证功能不中断。
   */
  async _sendImage(message, buffer) {
    let tempPath = '';

    try {
      const dir = resolve(config.dataDir, 'outbox');
      mkdirSync(dir, { recursive: true });
      tempPath = resolve(dir, `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`);
      writeFileSync(tempPath, buffer);
    } catch (error) {
      log.warn('写临时图失败，直接用 base64:', error.message);
      tempPath = '';
    }

    const send = (ref) => {
      const segments = [{ type: 'image', data: { file: ref } }];
      return message.isGroup
        ? this.client.sendGroupMsg(message.groupId, segments)
        : this.client.sendPrivateMsg(message.senderId, segments);
    };

    try {
      if (tempPath) {
        try {
          const result = await send(tempPath.replace(/\\/g, '/'));
          log.info(`图片已发送 字节=${buffer.length} 方式=file message_id=${result?.message_id ?? '未知'}`);
          return;
        } catch (error) {
          log.warn('按文件路径发送失败，回退 base64:', error.message);
        }
      }
      const result = await send(`base64://${buffer.toString('base64')}`);
      log.info(`图片已发送 字节=${buffer.length} 方式=base64 message_id=${result?.message_id ?? '未知'}`);
    } catch (error) {
      log.error(`图片发送失败 字节=${buffer.length}:`, error.message);
    } finally {
      // NapCat 读文件是异步的，不能立刻删；留一分钟足够
      if (tempPath) {
        setTimeout(() => {
          try {
            unlinkSync(tempPath);
          } catch {
            // 已经被清理过就算了
          }
        }, 60000);
      }
    }
  }

  /** 发一句纯文本，用于生图失败时的兜底告知。 */
  async _sendPlain(message, text) {
    const segments = [{ type: 'text', data: { text } }];
    try {
      if (message.isGroup) {
        await this.client.sendGroupMsg(message.groupId, segments);
      } else {
        await this.client.sendPrivateMsg(message.senderId, segments);
      }
    } catch (error) {
      log.error('提示发送失败:', error.message);
    }
  }

  _latestRawId(conversationId) {
    try {
      return getLatestRawId(conversationId);
    } catch (error) {
      log.warn('取最新消息 id 失败:', error.message);
      return 0;
    }
  }
}

/** 昵称提及检测：去掉 @ 标记后再匹配，避免 @ 里的名字误判。 */
export function detectMention(text, nicknames) {
  if (!nicknames || nicknames.length === 0) return false;
  const stripped = String(text || '')
    .replace(/@\S+/g, '')
    .replace(/\[CQ:at[^\]]*\]/g, '');
  return nicknames.some((name) => name && stripped.includes(name));
}
