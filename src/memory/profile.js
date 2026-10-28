/**
 * 人物画像：按 QQ 号积累对每个人的认知，注入 prompt。
 *
 * 借鉴 MaiBot v1.3.14 的 src/maisaka/memory/person_profile.py。
 *
 * 解决的问题：记忆按「会话」组织，但群聊里会话是群，不是人。
 * A 说话时，bot 只能靠当前消息文本去向量库碰运气，
 * 不知道自己正在和谁说话、这个人以前聊过什么。
 *
 * 画像与「按人建子语境」互补：
 * - 子语境存该人的完整对话记忆，用于深度召回
 * - 画像存浓缩摘要，注入快、省 token
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import {
  getPersonProfile,
  listActiveMemoriesByPerson,
  upsertPersonProfile,
} from './store.js';

const log = createLogger('profile');

/** 单次注入最多几个人的画像。 */
export const PROFILE_QUERY_LIMIT = 4;

/** 单个人物画像注入文本的最大字符数。 */
export const PROFILE_TEXT_MAX_CHARS = 900;

/** 生成画像所需的最少记忆条数。少于这个数不值得建画像。 */
export const MIN_FACTS_FOR_PROFILE = 3;

/**
 * 从记忆列表渲染画像文本。
 *
 * 只取判断句本身，按类型分组，不带元数据——画像要短。
 *
 * @param {object[]} memories 记忆条目
 * @param {number} maxChars 最大字符数
 * @returns {string}
 */
export function renderProfileText(memories, maxChars = PROFILE_TEXT_MAX_CHARS) {
  if (!Array.isArray(memories) || memories.length === 0) return '';

  const byType = { knowledge: [], preference: [], emotion: [] };
  for (const memory of memories) {
    const type = byType[memory.memory_type] ? memory.memory_type : 'knowledge';
    const judgment = String(memory.judgment ?? '').trim();
    if (judgment) byType[type].push(judgment);
  }

  const labels = { knowledge: '已知', preference: '偏好', emotion: '情绪' };
  const lines = [];
  for (const type of ['knowledge', 'preference', 'emotion']) {
    if (byType[type].length === 0) continue;
    lines.push(`${labels[type]}：${byType[type].join('；')}`);
  }

  let text = lines.join('\n');
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars - 1)}…`;
  }
  return text;
}

/**
 * 为某个会话里的人物构建或更新画像。
 *
 * personId 用 QQ 号，不用群名片——群名片会改，QQ 号不会。
 * personName 只作为展示用，随最新群名片更新。
 *
 * 名字改了怎么办：已有画像时沿用上次的来源记忆，不靠名字重新匹配。
 * 否则改名后用新名字查不到旧记忆，画像会直接失效。
 *
 * @param {object} params
 * @param {string} params.conversationId 会话 ID（群聊主会话）
 * @param {string} params.personId QQ 号
 * @param {string} params.personName 显示名（可空，仅用于展示）
 * @returns {{created: boolean, factCount: number}}
 */
export function refreshPersonProfile({ conversationId, personId, personName }) {
  const id = String(personId || '').trim();
  if (!id) return { created: false, factCount: 0 };

  const existing = getPersonProfile(conversationId, id);

  // 取该人在此会话下的记忆：个人子语境 + 主会话里名字命中的
  const memories = listActiveMemoriesByPerson({
    conversationId,
    personId: id,
    personName,
    limit: 40,
  });

  // 改名场景：新名字查不到记忆时，回退到画像已记录的历史记忆
  let sourceIds = memories.map((memory) => memory.memory_id);
  if (memories.length < MIN_FACTS_FOR_PROFILE && existing?.source_memory_ids) {
    try {
      const previous = JSON.parse(existing.source_memory_ids);
      if (Array.isArray(previous) && previous.length > 0) {
        sourceIds = previous;
      }
    } catch {
      // 旧数据损坏就忽略，走正常流程
    }
  }

  // 记忆条数不够且没有历史来源，跳过
  if (memories.length < MIN_FACTS_FOR_PROFILE && sourceIds.length < MIN_FACTS_FOR_PROFILE) {
    return { created: false, factCount: memories.length };
  }

  // 有新记忆时重新渲染；只有历史来源时保留原画像文本，仅更新显示名
  let profileText = renderProfileText(memories);
  if (!profileText && existing?.profile_text) {
    profileText = existing.profile_text;
  }
  if (!profileText) return { created: false, factCount: memories.length };

  upsertPersonProfile({
    conversationId,
    personId: id,
    personName: personName || existing?.person_name || '',
    profileText,
    factCount: Math.max(memories.length, sourceIds.length),
    sourceMemoryIds: sourceIds,
  });

  log.debug(`画像已更新 conversation=${conversationId} person=${personName || id}(${id}) 记忆数=${memories.length}`);
  return { created: true, factCount: Math.max(memories.length, sourceIds.length) };
}

/**
 * 取当前对话里活跃人物的画像，用于注入。
 *
 * @param {object} params
 * @param {string} params.conversationId 会话 ID
 * @param {string[]} params.activePersonIds 活跃人物 QQ 号列表
 * @returns {object[]} 画像列表
 */
export function loadActiveProfiles({ conversationId, activePersonIds }) {
  if (!Array.isArray(activePersonIds) || activePersonIds.length === 0) return [];

  const profiles = [];
  for (const personId of activePersonIds.slice(0, PROFILE_QUERY_LIMIT)) {
    const profile = getPersonProfile(conversationId, personId);
    if (profile?.profile_text) profiles.push(profile);
  }
  return profiles;
}

/**
 * 把画像列表格式化成可注入 prompt 的文本块。
 *
 * @param {object[]} profiles 画像列表
 * @returns {string}
 */
export function formatProfileBlock(profiles) {
  if (!Array.isArray(profiles) || profiles.length === 0) return '';
  const lines = ['<profiles>'];
  for (const profile of profiles) {
    const name = profile.person_name || profile.person_id;
    lines.push(`【${name}】`);
    lines.push(profile.profile_text);
  }
  lines.push('</profiles>');
  return lines.join('\n');
}

/**
 * 从消息里提取活跃人物。
 *
 * 群聊里「活跃」指：当前发言者、被 @ 的人、被回复的人。
 * 统一返回 QQ 号——群名片会改，QQ 号不会。
 *
 * @param {object} message 当前消息
 * @param {object[]} history 最近历史消息
 * @returns {string[]} QQ 号列表
 */
export function collectActivePersonIds(message, history = []) {
  const ids = new Set();

  if (message?.senderId) ids.add(String(message.senderId));
  for (const id of message?.atUserIds ?? []) {
    if (id) ids.add(String(id));
  }
  if (message?.replyToUserId) ids.add(String(message.replyToUserId));

  // 最近历史里的发言者也算活跃（判断谁在聊）
  for (const row of history.slice(-10)) {
    const id = row.speaker_id ?? row.sender_id;
    if (id) ids.add(String(id));
  }

  return [...ids].filter(Boolean);
}
