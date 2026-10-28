/**
 * Stage 集合：把 orchestrator.respond 的步骤拆成独立 stage。
 *
 * 原则：逻辑平移不重写。所有纯函数仍从 chat/orchestrator.js、persona/、memory/
 * 导入，stage 只负责编排顺序和往 ctx.state 里放结果。
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { buildMessages, cleanReply } from '../chat/orchestrator.js';
import { chatStream, chatSync } from '../llm/client.js';
import { buildOutgoingMessages } from '../persona/index.js';
import { decideQuote, buildQuoteContext } from '../persona/quote.js';
import { formatMemoryBlock, recallMemories } from '../memory/recall.js';
import { formatMidTermBlock, recallMidTermMemory, recallRecentNotes, formatRecentNotesBlock } from '../memory/mid-term.js';
import { collectActivePersonIds, loadActiveProfiles } from '../memory/profile.js';
import { pullHeuristicMemory } from '../memory/heuristic.js';
import { recallStyleBlock } from '../memory/expression.js';
import { describeImages, formatImageBlock } from '../chat/vision.js';
import { fetchWebContext, extractSearchRequest, searchWeb } from '../chat/web-tools.js';
import { selectRecentMessages } from '../memory/store.js';

const log = createLogger('pipeline');

/**
 * 召回上下文：历史/画像/长期记忆/中期记忆/启发式/联网，全部并行。
 * 原样平移自 orchestrator.respond 的并行块——召回超时 2.5s，串行最坏 5s+。
 */
export const loadContextStage = {
  name: 'load-context',
  async run(ctx) {
    const { message } = ctx;
    const history = selectRecentMessages(ctx.conversationId, config.memory.historyRounds * 2);

    let profiles = [];
    if (config.memory.profile.enabled && message.isGroup) {
      const activeIds = collectActivePersonIds(message, history);
      profiles = loadActiveProfiles({ conversationId: ctx.conversationId, activePersonIds: activeIds });
    }

    const [recall, midTerm, heuristicBlock, webResult, styleBlock, imageDescriptions] = await Promise.all([
      recallMemories(message.text, { conversationId: ctx.conversationId }).catch((error) => {
        log.debug('长期召回失败:', error.message);
        return { memories: [], source: 'error' };
      }),
      recallMidTermMemory(ctx.conversationId, message.text).catch(() => null),
      pullHeuristicMemory({ conversationId: ctx.conversationId, queryText: message.text }).catch(() => ''),
      config.webTools.enabled
        ? fetchWebContext(message.text).catch(() => null)
        : Promise.resolve(null),
      recallStyleBlock(ctx.conversationId, message.text).catch(() => ''),
      // 识图：图片先用视觉模型转文字，与召回并行，不额外拖慢
      message.images?.length
        ? describeImages(message.images).catch(() => [])
        : Promise.resolve([]),
    ]);

    ctx.state.history = history;
    ctx.state.profiles = profiles;
    ctx.state.memories = recall.memories;
    ctx.state.midTerm = midTerm;
    ctx.state.heuristicBlock = heuristicBlock;
    ctx.state.styleBlock = styleBlock;
    ctx.state.imageBlock = formatImageBlock(imageDescriptions);
    ctx.state.webContext = webResult?.context || '';
    // recent-notes：最近脉络无条件在场（借鉴 Cortico 交接笔记）。
    // 与召回命中的同一条去重：命中时 recall 已覆盖，不再重复注入。
    ctx.state.recentNotes = midTerm ? null : recallRecentNotes(ctx.conversationId);
    ctx.timings.recall = ctx.elapsed();
  },
};

/**
 * 拼 prompt：buildMessages + 生图/语音 hint 注入（hint 由 tool stage 提前放好）。
 */
export const buildPromptStage = {
  name: 'build-prompt',
  run(ctx) {
    const { message, options } = ctx;
    const messages = buildMessages({
      message,
      conversationId: ctx.conversationId,
      memories: ctx.state.memories,
      history: ctx.state.history,
      midTerm: ctx.state.midTerm,
      profiles: ctx.state.profiles,
      heuristicBlock: ctx.state.heuristicBlock,
      webContext: ctx.state.webContext,
      recentNotes: ctx.state.recentNotes,
    });
    if (options.imageHint) messages.push({ role: 'system', content: options.imageHint });
    if (options.voiceHint) messages.push({ role: 'system', content: options.voiceHint });
    if (options.silenceReminder) messages.push({ role: 'system', content: options.silenceReminder });
    // 风格块：本群表达习惯 + 黑话（借鉴 MaiBot learners）
    if (ctx.state.styleBlock) messages.push({ role: 'system', content: ctx.state.styleBlock });

    // 识图结果：图片已被视觉模型转成文字，主模型据此理解画面
    if (ctx.state.imageBlock) messages.push({ role: 'system', content: ctx.state.imageBlock });
    ctx.state.messages = messages;
    ctx.state.promptChars = messages.reduce((sum, item) => sum + String(item.content || '').length, 0);
  },
};

/**
 * 发送单句：cleanReply → 拟人化分段 → quote/引用 → OneBot 发送。
 * 平移自 orchestrator 的 sendOne 闭包，改为从 ctx.state 读写共享变量。
 */
async function sendOne(ctx) {
  const { message, client, options } = ctx;
  const text = ctx.state.pendingSentence;
  const cleaned = cleanReply(text, { forceShort: false });
  if (!cleaned) return;

  if (options.silent) {
    ctx.state.sent.push(cleaned);
    return;
  }

  const pieces = buildOutgoingMessages(cleaned);
  for (const item of pieces) {
    // 打字延迟：模拟「分段慢慢打」的节奏（第一条除外——首句要快，人回消息也是先快后慢）
    if (ctx.state.sent.length > 0 && item.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(item.delayMs, 2500)));
    }
    try {
      const segments = [];
      if (!ctx.state.quoted && ctx.state.sent.length === 0) {
        const quoteDecision = decideQuote({
          context: buildQuoteContext({
            history: [{ messageId: message.messageId, senderId: message.senderId, receivedAt: message.receivedAt }],
            targetMessageId: message.messageId,
            botUserId: message.isGroup ? (client.selfId || '') : '',
            nowSeconds: Math.floor(Date.now() / 1000),
          }),
          botUserId: client.selfId || '',
          text: item.text,
          frequency: config.persona.quote.frequency,
          isGroup: message.isGroup,
        });
        if (quoteDecision.shouldQuote) {
          segments.push({ type: 'reply', data: { id: message.messageId } });
        }
        ctx.state.quoted = true;
      } else if (item.quotePrevious && ctx.state.previousMessageId) {
        segments.push({ type: 'reply', data: { id: ctx.state.previousMessageId } });
      }
      segments.push({ type: 'text', data: { text: item.text } });

      const result = message.isGroup
        ? await client.sendGroupMsg(message.groupId, segments)
        : await client.sendPrivateMsg(message.senderId, segments);

      ctx.state.previousMessageId = result?.message_id ?? ctx.state.previousMessageId;
      ctx.state.sent.push(item.text);
    } catch (error) {
      log.error('消息发送失败:', error.message);
    }
  }
}

/**
 * 流式生成并发送：第一句生成完就发，不等全文（体感提速关键）。
 * 含联网搜索重试、剩余 buffer、空回复非流式兜底——全部平移自 orchestrator。
 */
export const llmStage = {
  name: 'llm',
  async run(ctx) {
    const tLlm = Date.now();
    ctx.state.previousMessageId = null;
    let buffer = '';
    let fullReply = '';
    let firstChunkLogged = false;
    const messages = () => ctx.state.messages;

    const runStream = async (extraContext = '') => {
      const streamMessages = extraContext
        ? [...messages(), { role: 'system', content: extraContext }]
        : messages();

      let pendingSearch = null;
      let guardBuffer = '';
      buffer = '';

      // 聊天回复只重试 1 次（maxAttempts=2）：首字超时 45s × 3 次 = 135s 最坏情况，
      // 实测出现过 204 秒才回复的极端案例。用户宁可收到一句「卡了」也不要等三分钟。
      const stream = chatStream(streamMessages, { label: '聊天回复', maxAttempts: 2 });
      const MAX_SPLIT = 2;

      for await (const chunk of stream) {
        if (!firstChunkLogged) {
          ctx.timings.firstToken = Date.now() - tLlm;
          firstChunkLogged = true;
        }
        fullReply += chunk;
        buffer += chunk;

        if (ctx.state.sent.length === 0 && !pendingSearch && guardBuffer.length < 100) {
          guardBuffer += chunk;
          const query = extractSearchRequest(guardBuffer);
          if (query) {
            pendingSearch = query;
            break;
          }
        }

        if (ctx.state.sent.length >= MAX_SPLIT) continue;

        const match = /^([\s\S]*?[。！？!?…\n]+)/.exec(buffer);
        if (match) {
          const sentence = match[1];
          buffer = buffer.slice(sentence.length);
          if (sentence.replace(/[。！？!?…\n\s]/g, '').length >= 2) {
            ctx.state.pendingSentence = sentence;
            await sendOne(ctx);
          } else {
            buffer = sentence + buffer;
          }
        }
      }

      return { searchQuery: pendingSearch };
    };

    let result = await runStream();

    if (result.searchQuery && config.webTools.enabled) {
      log.info(`模型请求联网: "${result.searchQuery}"`);
      const snippets = await searchWeb(result.searchQuery, 3).catch(() => '');
      if (snippets) {
        fullReply = '';
        firstChunkLogged = false;
        const webBlock =
          `<web_result type="搜索">\n${snippets}\n` +
          `（这是刚搜到的网络信息，可能不全或过时，参考着回答，别照念）\n</web_result>`;
        result = await runStream(webBlock);
        if (result.searchQuery) {
          log.warn('模型二次请求联网，忽略以避免循环');
        }
      } else {
        log.warn(`联网搜索无结果: "${result.searchQuery}"`);
      }
    }

    if (buffer.trim()) {
      ctx.state.pendingSentence = buffer;
      await sendOne(ctx);
    }

    // 空回复兜底：reasoning 吃光配额时流里可能一个 chunk 都没有
    if (ctx.state.sent.length === 0) {
      log.warn('流式无输出，回退到非流式重试');
      try {
        // 兜底也要给足 max_tokens：600 装不下 reasoning，正文会被截空。
        // 超时压到 45s——此时用户已经等了整个流式周期（最坏 45s×3 次重试），
        // 再挂 60s 只会更糟，宁可尽快失败让用户重发。
        const fallbackText = await chatSync(messages(), {
          maxTokens: 1200,
          timeoutMs: 45000,
          priority: 0,
          label: '聊天回复-兜底',
        });
        const cleaned = cleanReply(fallbackText);
        if (cleaned) {
          ctx.state.pendingSentence = cleaned;
          await sendOne(ctx);
        }
      } catch (retryError) {
        log.error('兜底重试也失败:', retryError.message);
      }
    }

    ctx.state.fullReply = fullReply;
    ctx.state.replied = ctx.state.sent.length > 0;
    ctx.timings.llm = Date.now() - tLlm;
    ctx.timings.total = ctx.elapsed();
    log.info(
      `回复耗时 召回=${ctx.timings.recall}ms 首字=${ctx.timings.firstToken}ms LLM=${ctx.timings.llm}ms 合计=${ctx.timings.total}ms ` +
      `prompt=${ctx.state.promptChars}字 分${ctx.state.sent.length}条 记忆=${ctx.state.memories.length}条`,
    );
  },
};

/** 完整回复管线。tool 检测（生图/语音）在进管线前由调用方决定。 */
export const respondStages = [loadContextStage, buildPromptStage, llmStage];
