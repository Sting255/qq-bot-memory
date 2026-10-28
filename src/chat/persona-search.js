/**
 * 角色人设生成。
 *
 * 提示词移植自邻舍 agent-core/src/routes/characters.js 的 buildPersonaSystemPrompt，
 * 保留它的四条核心创作原则，这是原版最有价值的部分：
 *
 * A. 你就是她/他 —— 用第二人称贯穿，不出现「扮演」「模仿」这类旁观字眼
 * B. 过去化为直觉 —— 经历塑造性格，但角色不主动提过去
 * C. 自我认知而非外部评价 —— 写「我怎么看自己」，不写「别人怎么看我」
 * D. 保留血肉 —— 原始资料里的台词、细节全部保留，不删减不架空
 *
 * 与原版的差异：输出 JSON 而不是行格式，为的是直接填进面板的表单字段。
 */
import { chatSync } from '../llm/client.js';
import { createLogger } from '../logger.js';
import { searchCharacterInfo, extractNameForSearch } from './web-search.js';
import { collectMaterials, formatMaterials } from './wiki-sources.js';
import { PERSONA_FIELDS } from './persona.js';

const log = createLogger('persona-search');

/** 四条核心创作原则，原版精华。 */
const CORE_PRINCIPLES = `【核心创作原则 —— 必须遵守】
A. 你就是她/他 —— 所有描述从"你"出发。让模型"成为"而非"扮演"该角色。全文不得出现"扮演""模仿""以XX的身份回答"等旁观字眼。
B. 过去化为直觉 —— 经历如何塑造性格必须写清，但角色在对话中不主动提及自己的过去。那些经历是你所有回应的底层逻辑，不是挂在嘴边的谈资。
C. 自我认知而非外部评价 —— 写"我怎么看自己"，不写"别人怎么看我"。思考角色自己最想深藏心底、永远不会忘记的事。
D. 保留血肉 —— 原始资料中的具体台词、评价、故事细节全部保留，只做视角转换（她→你）和内化逻辑的补充，不删减素材。`;

/** 有外部资料时的提示词：忠实还原。 */
const PROMPT_WITH_MATERIAL = `你是角色人格生成器。用户会给出角色名（可能含作品名），以及从百科抓到的角色资料。

你的任务：基于资料生成完整的人设，严格遵循下方模板与原则。

${CORE_PRINCIPLES}

【模板要求】
- identity（身份背景，600 字内）：2-3 句话描述角色是谁、来自哪个作品、关键经历。让角色有血有肉。资料里有外貌描述的话一并写进去。
- personality（性格特征，400 字内）：至少 4 条，以"你"的口吻自然写出。必须覆盖以下四个维度：
  · 表层语调 —— 别人听起来你是什么样的语气？快慢冷热礼貌粗鲁？
  · 内因驱动 —— 你为什么这样说话？深层恐惧/信念/伤口是什么？每句话在防御什么、渴望什么？
  · 话语与行动的反差 —— 嘴上说什么 vs 实际做什么，矛盾越大越立体
  · 裂缝时刻 —— 什么情况下语气会变、面具会滑落？哪个词/哪个人/哪种场景让你停顿？
- speakingStyle（说话风格，300 字内）：语气、用词习惯、句长偏好。资料里有台词的话，务必从中提炼真实的语言特征（口头禅、称呼方式、句尾习惯），不要凭空编造。
- rules（行为准则）：留空，用系统默认。

资料里没有的信息不要编造。宁可写得短，也不要瞎补。

只输出严格 JSON，不要 Markdown 代码块，不要额外解释：
{"name":"角色中文名","identity":"...","personality":"...","speakingStyle":"...","rules":""}`;

/** 无外部资料时的提示词：用模型知识，但严禁编造。 */
const PROMPT_FROM_KNOWLEDGE = `你是角色人格生成器。用户会给出角色名（可能含作品名）。

你的任务：基于你对该角色的了解生成完整人设，严格遵循下方原则与模板。

${CORE_PRINCIPLES}

【模板要求】
- identity（身份背景，600 字内）：角色是谁、来自哪个作品、关键经历。有外貌描述一并写进去。
- personality（性格特征，400 字内）：至少 4 条，用"你"的口吻。覆盖表层语调、内因驱动、话语与行动的反差、裂缝时刻四个维度。
- speakingStyle（说话风格，300 字内）：语气、用词习惯、句长偏好。如果记得这个角色的真实台词特征，务必写出来。
- rules（行为准则）：留空。

如果你不认识这个角色，返回 {"name":"","identity":"","personality":"","speakingStyle":""}。
不要编造一个不存在的角色。宁可空着，也不要以假乱真。

只输出严格 JSON，不要 Markdown 代码块，不要额外解释：
{"name":"角色中文名","identity":"...","personality":"...","speakingStyle":"...","rules":""}`;

/**
 * 解析 LLM 返回的人设 JSON。
 *
 * @param {string} raw
 * @returns {object|null}
 */
export function parsePersonaDraft(raw) {
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

  // 按 schema 的字段与长度上限裁剪，避免超长内容写进数据库
  const draft = {};
  for (const field of PERSONA_FIELDS) {
    const value = String(payload?.[field.key] ?? '').trim();
    if (!value) continue;
    draft[field.key] = field.maxLength && value.length > field.maxLength
      ? value.slice(0, field.maxLength)
      : value;
  }

  if (!draft.name && !draft.identity) return null;
  return draft;
}

/** 调 LLM 生成人设草稿，解析失败自动重试一次。 */
async function generateDraft(systemPrompt, userContent) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await chatSync(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        { temperature: attempt === 0 ? 0.4 : 0.2, maxTokens: 2600, label: '人设生成' },
      );
      const draft = parsePersonaDraft(raw);
      if (draft) return draft;

      // 解析失败：把原始输出记下来，重试时降低温度提高稳定性
      lastError = new Error('返回内容无法解析成 JSON');
      log.warn(`人设解析失败（第 ${attempt + 1} 次），原始输出前 200 字:`, String(raw || '').slice(0, 200));
    } catch (error) {
      lastError = error;
      log.warn(`人设生成失败（第 ${attempt + 1} 次）:`, error.message);
    }
  }

  throw lastError || new Error('人设生成失败');
}

/**
 * 生成人设草稿。
 *
 * @param {string} query 角色名或「角色名 作品名」
 * @param {object} options
 * @param {'web'|'model'} options.mode
 * @returns {Promise<object>}
 */
export async function searchPersona(query, { mode = 'web' } = {}) {
  const text = String(query || '').trim();
  if (!text) return { ok: false, error: '请填写角色名或描述' };

  // 模式一：只用模型知识
  if (mode === 'model') {
    log.info(`用模型知识生成人设: ${text}`);
    try {
      const draft = await generateDraft(PROMPT_FROM_KNOWLEDGE, text);
      if (!draft) {
        return { ok: false, error: '模型不认识这个角色，或生成内容无法解析。请改用联网搜索，或手动填写。' };
      }
      return { ok: true, draft, mode: 'model', source: '模型知识' };
    } catch (error) {
      log.error('模型生成失败:', error.message);
      return { ok: false, error: `生成失败: ${error.message}` };
    }
  }

  // 模式二：多源联网采集
  // 只做一次 LLM 调用提取规范名（顺带纠错别字），不复用 searchCharacterInfo——
  // 那条链路内部还会再调一次 LLM 并跑完整的萌娘+Bing 流程，太慢。
  let name = text;
  let work = '';
  try {
    const extracted = await extractNameForSearch(text);
    if (extracted?.name) {
      name = extracted.name;
      work = extracted.context || '';
    }
  } catch (error) {
    log.debug('规范名提取失败:', error.message);
  }

  // 用户输入里带了作品名但提取没拿到，从原始输入拆
  if (!work) {
    const parts = text.split(/[\s,，:：]+/).filter(Boolean);
    if (parts.length >= 2) {
      name = parts[0];
      work = parts.slice(1).join('');
    }
  }

  log.info(`开始多源采集: 角色="${name}" 作品="${work || '(未知)'}"`);

  // 萌娘百科作为补充源（bwiki 未覆盖时有用）
  const moegirlFallback = async (charName) => {
    try {
      const mod = await import('./wiki.js');
      const page = await mod.fetchPageByTitle(charName);
      if (!page) return null;
      const body = page.infobox
        ? `【基本信息框】\n${page.infobox}\n\n【正文】\n${page.content}`
        : page.content;
      return { title: page.title, text: body };
    } catch {
      return null;
    }
  };

  let materials;
  try {
    materials = await collectMaterials({ name, work, moegirlFallback });
  } catch (error) {
    log.warn('多源采集失败:', error.message);
    materials = { source: '无', parts: [], sources: [] };
  }

  let materialText = formatMaterials(materials.parts);

  // bwiki 没命中且没有作品名时，用 Bing 兜底一次
  if (!materialText || materialText.length < 200) {
    log.info('bwiki 未命中，尝试 Bing 兜底');
    try {
      const bingText = await searchCharacterInfo(`${name}${work ? ` ${work}` : ''}`);
      if (bingText && bingText.length > 200) {
        materials.parts.push({ label: '网络搜索结果', text: bingText });
        materials.sources.push('Bing');
        materials.source = materials.sources.join(' + ');
        materialText = formatMaterials(materials.parts);
      }
    } catch (error) {
      log.debug('Bing 兜底失败:', error.message);
    }
  }

  // 采集不到 → 降级到模型知识
  if (!materialText || materialText.length < 200) {
    log.warn('采集资料不足，降级到模型知识');
    try {
      const draft = await generateDraft(PROMPT_FROM_KNOWLEDGE, `${name}${work ? ` ${work}` : ''}`);
      if (!draft) {
        return {
          ok: false,
          error: '联网没找到资料，模型也不认识这个角色。请手动填写，或换个更准确的名字（加上作品名）。',
        };
      }
      return {
        ok: true,
        draft,
        mode: 'model',
        source: '模型知识（联网资料不足，已自动降级）',
        warning: '没抓到百科资料，以下内容来自模型自身知识，准确性请自行判断',
      };
    } catch (error) {
      return { ok: false, error: `联网与模型都失败: ${error.message}` };
    }
  }

  log.info(`采集完成，资料 ${materialText.length} 字，来源: ${materials.source}`);

  try {
    const userContent = `角色：${name}${work ? `（来自《${work}》）` : ''}

以下是从百科采集的角色资料：

${materialText.slice(0, 20000)}`;

    const draft = await generateDraft(PROMPT_WITH_MATERIAL, userContent);
    if (!draft) {
      return { ok: false, error: '模型返回的内容无法解析成人设，请重试' };
    }

    return {
      ok: true,
      draft,
      mode: 'web',
      source: materials.source,
      rawLength: materialText.length,
      sources: materials.sources,
    };
  } catch (error) {
    log.error('人设整理失败:', error.message);
    return { ok: false, error: `整理失败: ${error.message}` };
  }
}
