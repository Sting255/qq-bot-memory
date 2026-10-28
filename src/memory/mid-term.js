/**
 * 中期记忆：把被裁出短期上下文的对话压缩成「摘要 + 召回线索」。
 *
 * 借鉴 MaiBot v1.3.14 的 src/maisaka/memory/mid_term.py。
 *
 * 解决的问题：只有「最近 N 条消息」+「长期向量记忆」两层时，中间有断层。
 * 群里聊 100 条，bot 只看得到最后 20 条，前面 80 条的话题脉络直接丢失；
 * 而长期记忆是抽取出来的判断句，不含对话脉络。
 *
 * 中期记忆的巧思：压缩时不只产出摘要，还让模型写出「召回线索」——
 * 即「什么情况下会需要这段信息」。召回时用当前对话去匹配线索，
 * 而不是匹配摘要本身。这比直接匹配摘要准得多，因为线索是按
 * 「未来可能的问题形态」写的。
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { chatSync } from '../llm/client.js';
import { embedText } from './vector-client.js';
import {
  getDb,
  insertMidTermMemory,
  latestMidTermMemory,
  listMidTermMemory,
  markMidTermRecalled,
  selectRawMessagesBetween,
} from './store.js';

const log = createLogger('mid-term');

/** 召回线索与当前对话的余弦相似度阈值。低于此值视为不相关。 */
export const RECALL_THRESHOLD = config.memory.midTerm.recallThreshold;

/** 摘要输入的最大字符数，防止一次塞进太多内容。 */
/**
 * 摘要输入的最大字符数。
 *
 * 不能太大：这个模型会先输出一大段 reasoning 再给正文，
 * 输入越长推理越多，正文容易被 maxTokens 截断成空。
 * 6000 字足够保留脉络，又不会把配额吃光。
 */
export const MAX_SUMMARY_INPUT_CHARS = 6000;

/** 一次摘要最多引用多少条消息。 */
export const MAX_SUMMARY_MESSAGES = config.memory.midTerm.maxMessages;

const SUMMARY_PROMPT = `请把后续多条即将被裁切出短期上下文的聊天消息压缩成聊天回想。

要求：
1. 只根据后续消息总结，不要编造没有出现的信息。
2. summary 保留话题脉络、人物立场、结论和重要细节，但**控制在 300 字以内**——上游模型会先消耗大量 reasoning token，摘要写太长会导致 JSON 被截断成无效格式。
3. recall_cues 输出 3-5 个用于之后语义匹配的查询式段落。请额外思考「什么情景下可能会需要这些信息」「这些信息和什么内容、人物、任务、关键词关联」，每条写成自然语言短句，包含可匹配的场景、意图或关联内容。
4. 只输出一个 JSON 对象，不要使用 Markdown 代码块或额外解释，格式必须为 {"summary":"...","recall_cues":["..."]}。

时间范围：{time_range}
参与人物：{participants}`;

/** 余弦相似度。两向量已归一化时等价于点积。 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 解析摘要模型的输出，容错 Markdown 包裹与多余文字。 */
export function parseSummaryResponse(raw) {
  if (!raw) return null;
  let text = String(raw).trim();

  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  let payload;
  try {
    payload = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }

  const summary = String(payload?.summary ?? '').trim();
  if (!summary) return null;

  const cues = Array.isArray(payload?.recall_cues)
    ? payload.recall_cues.map((cue) => String(cue).trim()).filter(Boolean).slice(0, 5)
    : [];

  return { summary, recallCues: cues };
}

/** 从消息行里提取参与者和时间范围。 */
export function summarizeParticipants(rows) {
  const names = new Set();
  for (const row of rows) {
    if (row.role === 'user' && row.speaker_name) names.add(row.speaker_name);
  }
  return [...names].slice(0, 8);
}

export function summarizeTimeRange(rows) {
  if (!rows.length) return '';
  const first = rows[0]?.created_at;
  const last = rows[rows.length - 1]?.created_at;
  if (!first || !last) return '';
  return `${first} ~ ${last}`;
}

/** 把消息行渲染成对话文本。 */
function renderRows(rows) {
  return rows
    .map((row) => {
      const content = String(row.content ?? '').trim();
      if (!content) return '';
      if (row.role === 'assistant') return `[我] ${content}`;
      return `[${row.speaker_name || '某人'}] ${content}`;
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * 为一段被裁出短期上下文的消息生成中期记忆。
 *
 * @param {object} params
 * @param {string} params.conversationId 会话 ID
 * @param {number} params.fromRawId 起始消息 id（含）
 * @param {number} params.toRawId 结束消息 id（含）
 * @returns {Promise<{created: boolean, id?: number, reason?: string}>}
 */
export async function buildMidTermMemory({ conversationId, fromRawId, toRawId }) {
  if (!config.memory.midTerm.enabled) return { created: false, reason: '未启用' };

  const rows = selectRawMessagesBetween(conversationId, fromRawId, toRawId);
  if (rows.length === 0) return { created: false, reason: '无消息' };

  const usable = rows.slice(0, MAX_SUMMARY_MESSAGES);
  const transcript = renderRows(usable);
  if (!transcript.trim()) return { created: false, reason: '内容为空' };

  // 超长时按字符截断，优先保留靠后的内容（更接近当前上下文）
  let input = transcript;
  if (input.length > MAX_SUMMARY_INPUT_CHARS) {
    input = input.slice(-MAX_SUMMARY_INPUT_CHARS);
  }

  const participants = summarizeParticipants(usable);
  const timeRange = summarizeTimeRange(usable);

  try {
    const raw = await chatSync(
      [
        {
          role: 'system',
          content: SUMMARY_PROMPT
            .replace('{time_range}', timeRange || '未知')
            .replace('{participants}', participants.join('、') || '未知'),
        },
        { role: 'user', content: input },
      ],
      { temperature: 0.3, maxTokens: 8000, timeoutMs: 90000, label: '中期记忆摘要' },
    );

    const parsed = parseSummaryResponse(raw);
    if (!parsed) {
      // 记录原始输出的前 300 字，便于判断是格式问题还是空回复
      log.warn(
        `摘要解析失败 conversation=${conversationId} ` +
        `原始输出(${String(raw || '').length}字): ${JSON.stringify(String(raw || '').slice(0, 300))}`,
      );
      return { created: false, reason: '解析失败' };
    }

    // 召回线索做嵌入，供后续语义匹配
    const cueEmbeddings = [];
    for (const cue of parsed.recallCues) {
      try {
        const vec = await embedText(cue);
        if (Array.isArray(vec) && vec.length > 0) cueEmbeddings.push(vec);
      } catch (error) {
        log.debug('线索嵌入失败:', error.message);
      }
    }

    const id = insertMidTermMemory({
      conversationId,
      summary: parsed.summary,
      recallCues: parsed.recallCues,
      cueEmbeddings,
      participants: participants.join('、'),
      timeRange,
      sourceRawStartId: usable[0]?.id ?? null,
      sourceRawEndId: usable[usable.length - 1]?.id ?? null,
    });

    log.info(
      `中期记忆已生成 conversation=${conversationId} id=${id} ` +
      `消息数=${usable.length} 线索数=${parsed.recallCues.length} 已嵌入=${cueEmbeddings.length}`,
    );
    return { created: true, id };
  } catch (error) {
    log.error('中期记忆生成失败:', error.message);
    return { created: false, reason: error.message };
  }
}

/**
 * 为当前对话召回最相关的一条中期记忆。
 *
 * 匹配对象是「召回线索」而非摘要本身——线索是按未来可能的提问形态写的，
 * 与当前对话的语义距离更近。
 *
 * @param {string} conversationId 会话 ID
 * @param {string} queryText 当前对话文本
 * @param {number} threshold 相似度阈值
 * @returns {Promise<object|null>}
 */
export async function recallMidTermMemory(conversationId, queryText, threshold = RECALL_THRESHOLD) {
  if (!config.memory.midTerm.enabled) return null;

  const text = String(queryText || '').trim();
  if (!text) return null;

  const candidates = listMidTermMemory(conversationId, 20);
  if (candidates.length === 0) return null;

  let queryVec;
  try {
    queryVec = await embedText(text);
  } catch (error) {
    log.debug('召回查询嵌入失败:', error.message);
    return null;
  }
  if (!Array.isArray(queryVec) || queryVec.length === 0) return null;

  let best = null;
  for (const candidate of candidates) {
    const embeddings = candidate.cue_embeddings ? JSON.parse(candidate.cue_embeddings) : [];
    for (let i = 0; i < embeddings.length; i += 1) {
      const score = cosineSimilarity(queryVec, embeddings[i]);
      if (score >= threshold && (!best || score > best.score)) {
        best = {
          id: candidate.id,
          summary: candidate.summary,
          cue: candidate.recall_cues ? JSON.parse(candidate.recall_cues)[i] : '',
          score,
          timeRange: candidate.time_range,
        };
      }
    }
  }

  if (best) {
    markMidTermRecalled(best.id);
    log.info(`中期记忆召回命中 id=${best.id} score=${best.score.toFixed(4)}`);
  }
  return best;
}

/** 把召回的中期记忆格式化成可注入 prompt 的文本块。 */
export function formatMidTermBlock(memory) {
  if (!memory?.summary) return '';
  const lines = [`<chat_recall time="${memory.timeRange || '未知'}">`];
  lines.push(memory.summary);
  if (memory.cue) lines.push(`（关联线索：${memory.cue}）`);
  lines.push('</chat_recall>');
  return lines.join('\n');
}

/**
 * recent-notes 交接笔记（借鉴 Cortico handoffNote 思想）。
 *
 * 取最近一条中期记忆，不做相似度匹配——刚被裁出上下文的对话脉络
 * 应当无条件在场，不该赌「当前消息恰好命中召回线索」。
 * 超时（默认 6 小时）自动退场，之后回归正常的线索召回路径。
 */
export const RECENT_NOTES_MAX_AGE_MS = (config.memory.midTerm.recentNotesHours ?? 6) * 3600_000;

/** recent-note 的 summary 折叠上限：越老的脉络越粗，近的给全额。 */
const RECENT_NOTE_MAX_CHARS = 500;
const RECENT_NOTE_FOLD_CHARS = 200;

/**
 * 取最近脉络（recent-note）。
 * @param {string} conversationId
 * @returns {object|null} 形如 { id, summary, timeRange } 或 null
 */
export function recallRecentNotes(conversationId) {
  if (!config.memory.midTerm.enabled) return null;
  const row = latestMidTermMemory(conversationId, RECENT_NOTES_MAX_AGE_MS);
  if (!row) return null;
  return { id: row.id, summary: row.summary, timeRange: row.time_range };
}

/**
 * 渲染 recent-note 块，带年龄衰减折叠（Cortico 分层预算的简化版）：
 * 摘要过长只保留开头——老记忆本就该粗，细节交给线索召回。
 */
export function formatRecentNotesBlock(note) {
  if (!note?.summary) return '';
  let summary = String(note.summary);
  if (summary.length > RECENT_NOTE_MAX_CHARS) {
    summary = `${summary.slice(0, RECENT_NOTE_FOLD_CHARS)}…`;
  }
  return [
    `<recent_context time="${note.timeRange || '未知'}">`,
    summary,
    '（这是最近一段对话的脉络整理，一直供你参考，不需要回应它。）',
    '</recent_context>',
  ].join('\n');
}
