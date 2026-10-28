/**
 * 对话编排：把消息变成一次完整的回复。
 *
 * 流程：召回记忆 → 拼 prompt → 调 LLM → 拟人化加工 → 逐条发送
 * 单轮调用，不引入 planner 多轮工具循环——那是麦麦变重的根源，
 * 也是「性能弱」的主因。
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { chatStream, chatSync } from '../llm/client.js';
import { renderSystemPrompt } from './persona.js';
import { buildOutgoingMessages } from '../persona/index.js';
import { formatMemoryBlock, recallMemories } from '../memory/recall.js';
import { formatMidTermBlock, recallMidTermMemory, formatRecentNotesBlock } from '../memory/mid-term.js';
import { collectActivePersonIds, formatProfileBlock, loadActiveProfiles } from '../memory/profile.js';
import { pullHeuristicMemory } from '../memory/heuristic.js';
import { fetchWebContext, extractSearchRequest, searchWeb } from './web-tools.js';
import { buildAttentionDriftBlock } from '../persona/drift.js';
import { decideQuote, buildQuoteContext } from '../persona/quote.js';
import { selectRecentMessages } from '../memory/store.js';
import { escapeUserContent, formatUserLine, sanitizeSpeakerName } from '../security/sanitize.js';

const log = createLogger('chat');

/**
 * 取当前人设渲染出的 system prompt。
 *
 * 每次调用都从数据库读，这样面板改完人设立刻生效，不用重启。
 * 读取开销是一次 SQLite 单行查询（微秒级），值得。
 */
function getSystemPrompt(isGroup) {
  try {
    return renderSystemPrompt(null, { isGroup });
  } catch (error) {
    log.error('渲染人设失败，使用最小提示词:', error.message);
    return '你是一个在 QQ 群里聊天的普通人。回复简短自然。';
  }
}

/** 转发提示：@ + 转发时注入，明确告知看不到内容。 */
const FORWARD_NOTICE = '对方 @ 了你并转发了一段聊天记录，你无法查看转发内容，请自然地回应这个情况。';

/**
 * 构造发给 LLM 的消息列表。
 *
 * 安全边界：所有用户可控文本（昵称、群名片、消息内容）都经过消毒，
 * 统一包进 <user_input> 标签。历史消息与当前消息同等待遇，
 * 因为历史里的旧内容同样是别人说过的话。
 *
 * @param {object} params
 * @param {object} params.message 当前消息
 * @param {string} params.conversationId 会话 ID
 * @param {object[]} params.memories 召回的记忆
 * @param {object[]} params.history 历史消息
 * @returns {{role: string, content: string}[]}
 */
export function buildMessages({ message, conversationId, memories, history, midTerm, profiles, heuristicBlock, webContext = '', recentNotes = null }) {
  const messages = [{ role: 'system', content: getSystemPrompt(message.isGroup) }];

  // 说话风格：控制跑题程度，让回复不像 AI
  const driftBlock = buildAttentionDriftBlock({
    driftLevel: config.persona.drift.level,
    anchorPolicy: config.persona.drift.anchorPolicy,
    reactionStyle: config.persona.drift.reactionStyle,
  });
  if (driftBlock) {
    messages.push({ role: 'system', content: driftBlock });
  }

  // 人物画像：当前对话里活跃的人是谁、以前聊过什么
  const profileBlock = formatProfileBlock(profiles);
  if (profileBlock) {
    messages.push({ role: 'system', content: profileBlock });
  }

  const memoryBlock = formatMemoryBlock(memories);
  if (memoryBlock) {
    messages.push({ role: 'system', content: memoryBlock });
  }

  // 启发式记忆：按节流条件拉取的长期记忆，与上面按当前消息召回的互补
  if (heuristicBlock) {
    messages.push({ role: 'system', content: heuristicBlock });
  }

  // 中期记忆：被裁出短期上下文的对话脉络，按线索语义匹配召回
  const midTermBlock = formatMidTermBlock(midTerm);
  if (midTermBlock) {
    messages.push({ role: 'system', content: midTermBlock });
  }

  // recent-notes：最近脉络的无条件在场版（借鉴 Cortico 交接笔记）。
  // 未被线索召回命中时兜底注入；命中同一条时由调用方去重（传空跳过）。
  const recentBlock = formatRecentNotesBlock(recentNotes);
  if (recentBlock) {
    messages.push({ role: 'system', content: recentBlock });
  }

  // 联网结果：明确标注是外部数据，避免模型当成自己的知识
  if (webContext) {
    messages.push({ role: 'system', content: webContext });
  }

  if (message.hasForward) {
    messages.push({ role: 'system', content: FORWARD_NOTICE });
  }

  // 历史对话：机器人自己的发言用 assistant，其他人一律当 user 且经消毒
  for (const row of history || []) {
    if (row.role === 'assistant') {
      messages.push({ role: 'assistant', content: escapeUserContent(row.content) });
    } else {
      // 优先用结构化的 speaker_name；旧数据没有该字段时回退到拆 "名字: 内容"
      let speaker = row.speaker_name;
      let content = row.content;
      if (!speaker) {
        const parsed = splitStoredUserContent(row.content);
        speaker = parsed.speaker;
        content = parsed.content;
      }
      const line = formatUserLine({ speaker, content });
      if (line) messages.push({ role: 'user', content: line });
    }
  }

  // 当前消息
  const currentLine = formatUserLine({
    speaker: message.isGroup ? message.senderName : message.senderName || '对方',
    content: message.text,
  });
  if (currentLine) {
    messages.push({ role: 'user', content: currentLine });
  }

  return messages;
}

/**
 * 拆开入库时的 "名字: 内容" 格式。
 *
 * 入库时群聊消息存成 `${senderName}: ${text}`，这里要拆回来，
 * 否则名字里的冒号会和内容混在一起，消毒也就失效了。
 */
export function splitStoredUserContent(content) {
  const raw = String(content ?? '');
  const match = /^([^:：]{1,64})[:：]\s*([\s\S]*)$/.exec(raw);
  if (!match) return { speaker: '某人', content: raw };
  return { speaker: sanitizeSpeakerName(match[1]), content: match[2] };
}

/**
 * 执行一次回复。
 *
 * @param {object} params
 * @param {object} params.message 归一化后的消息
 * @param {object} params.client OneBot 客户端
 * @param {string} params.assistantLabel 机器人自己在记录里的称呼
 * @param {string} [params.imageHint] 生图场景的额外提示，让文字回复与图片协调
 * @returns {Promise<{replied: boolean, segments: string[], error?: string}>}
 */
export async function respond({ message, client, assistantLabel = '我', imageHint = '', voiceHint = '', silent = false, silenceReminder = '' }) {
  // Pipeline 化：步骤拆到 src/pipeline/stages.js，本函数只做入口装配与错误兜底。
  // 逻辑平移自原实现，行为保持一致（含流式中途失败时「已发出部分就不再补发」）。
  const { PipelineContext, runPipeline } = await import('../pipeline/index.js');
  const { respondStages } = await import('../pipeline/stages.js');

  const ctx = new PipelineContext({
    message,
    client,
    options: { assistantLabel, imageHint, voiceHint, silent, silenceReminder },
  });

  try {
    await runPipeline(ctx, respondStages);
    return { replied: ctx.state.replied, segments: ctx.state.sent, quoted: ctx.state.quoted };
  } catch (error) {
    log.error('流式回复失败:', error.message);
    if (ctx.state.sent.length === 0) {
      return { replied: false, segments: [], error: error.message };
    }
    return { replied: true, segments: ctx.state.sent, quoted: ctx.state.quoted };
  }
}

/**
 * 清理 LLM 输出：剥掉括号动作描写、多余空白。
 *
 * @param {string} raw 原始输出
 * @param {object} [options]
 * @param {boolean} [options.forceShort] 是否强制压到 30 字以内。
 *   流式发送时每句已经切好了，不该再截断（会切断完整句子），所以传 false。
 */
export function cleanReply(raw, { forceShort = true } = {}) {
  let text = String(raw || '').trim();
  if (!text) return '';

  // 剥掉模型请求联网的标记（正常流程会拦截，这里是兜底）
  text = text.replace(/\[SEARCH:\s*[^\]\n]{1,80}\]/g, '').trim();
  if (!text) return '';

  // 剥掉整行的括号动作描写，如 "（笑了笑）"
  text = text.replace(/^[（(][^）)]{0,30}[）)]\s*/u, '');
  // 剥掉 Markdown 标记
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  // 压缩多余空行
  text = text.replace(/\n{2,}/g, '\n').trim();

  if (!forceShort) return text;

  // 强制短：模型经常不听话写一大段，这里兜底截断。
  // 只留第一句——真人聊天说一句就够，后面那些通常是解释和补充。
  const MAX_REPLY_CHARS = 30;
  if (text.length > MAX_REPLY_CHARS) {
    const firstSentence = /^[^。！？!?…\n]{1,60}[。！？!?…]?/.exec(text);
    if (firstSentence && firstSentence[0].trim().length >= 4) {
      text = firstSentence[0].trim();
    } else {
      text = `${text.slice(0, MAX_REPLY_CHARS)}…`;
    }
  }

  return text;
}
