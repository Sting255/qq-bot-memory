/**
 * OneBot 11 消息归一化。
 *
 * 关键设计：@ 识别只看结构化字段，不看文本。
 * QQ 群名片和 QQ 昵称可能不一致，文本里出现的 "@小夏" 不一定是 @ 机器人；
 * 反过来消息段里的 at.qq 才是可信来源。
 */

import { createLogger } from '../logger.js';

const log = createLogger('normalize');

/** 合并转发在归一化后统一替换成这个占位文本。 */
export const FORWARD_PLACEHOLDER = '[转发的聊天记录，已忽略]';

/** 图片、表情等媒体占位前缀，供概率模型的 placeholderOnly 判定使用。 */
const MEDIA_SEGMENT_PLACEHOLDERS = {
  image: '[图片]',
  mface: '[表情包]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  json: '[卡片]',
  xml: '[卡片]',
};

/**
 * 把 OneBot 11 消息段数组转成归一化结构。
 *
 * @param {object[]} segments OneBot 消息段数组
 * @param {object} options
 * @param {string} options.selfId 机器人 QQ 号
 * @param {boolean} options.ignoreForward 是否忽略合并转发内容
 * @returns {{text: string, isAt: boolean, isMentioned: boolean, hasForward: boolean,
 *   forwardOnly: boolean, images: string[]}}
 */
export function normalizeSegments(segments, { selfId = '', ignoreForward = true } = {}) {
  const list = Array.isArray(segments) ? segments : [];
  const parts = [];
  const images = [];
  let isAt = false;
  let replyToId = '';
  let hasForward = false;
  let forwardDropped = false;

  for (const segment of list) {
    const type = segment?.type;
    const data = segment?.data ?? {};

    switch (type) {
      case 'text':
        parts.push(String(data.text ?? ''));
        break;

      case 'at': {
        const target = String(data.qq ?? '');
        if (selfId && target === String(selfId)) {
          isAt = true;
          // @ 机器人本身不占正文，但要留一个标记供模型理解
          parts.push(`@${data.name || '你'} `);
        } else if (target === 'all') {
          parts.push('@全体成员 ');
        } else {
          parts.push(`@${data.name || target} `);
        }
        break;
      }

      case 'reply':
        // 引用回复的原消息内容不展开（避免把旧内容混进当前发言），
        // 但记下 id：如果被引用的是一条图片消息，上层会去取回图片做识图。
        if (data?.id) replyToId = String(data.id);
        break;

      case 'forward':
        hasForward = true;
        if (ignoreForward) {
          // 丢弃内容，只留占位，维持时间线连续
          parts.push(FORWARD_PLACEHOLDER);
          forwardDropped = true;
        } else {
          parts.push('[转发消息]');
        }
        break;

      case 'image': {
        // NapCat 的图片段字段不固定：常见 url，也出现过 file（本地缓存路径）。
        // 都取不到时打日志，避免再盲猜。
        const candidate = data.url || data.file || data.path || '';
        if (candidate) {
          images.push(String(candidate));
        } else {
          log.debug(`图片段无可取地址: ${JSON.stringify(data).slice(0, 200)}`);
        }
        parts.push(MEDIA_SEGMENT_PLACEHOLDERS.image);
        break;
      }

      case 'mface':
      case 'record':
      case 'video':
      case 'file':
      case 'json':
      case 'xml':
        parts.push(MEDIA_SEGMENT_PLACEHOLDERS[type] ?? '[媒体]');
        break;

      default:
        // 未知类型不猜测内容
        break;
    }
  }

  const text = parts.join('').trim();
  const hasMediaOnly = list.length > 0 && list.every((segment) =>
    ['image', 'mface', 'record', 'video', 'file', 'json', 'xml', 'forward'].includes(segment?.type),
  );

  return {
    text,
    isAt,
    replyToId,
    isMentioned: false, // 由上层按昵称配置填充
    hasForward,
    forwardOnly: forwardDropped && hasMediaOnly,
    images,
  };
}

/**
 * 把 OneBot 事件转成内部消息结构。
 *
 * @param {object} event OneBot 11 事件对象
 * @param {object} options
 * @param {string} options.selfId 机器人 QQ 号
 * @param {boolean} options.ignoreForward 是否忽略合并转发内容
 * @returns {object|null} 归一化消息，非消息事件返回 null
 */
export function normalizeEvent(event, { selfId = '', ignoreForward = true } = {}) {
  if (!event || event.post_type !== 'message') return null;

  const messageType = event.message_type; // 'private' | 'group'
  if (messageType !== 'private' && messageType !== 'group') return null;

  const senderId = String(event.user_id ?? '');
  const senderName = String(event.sender?.card || event.sender?.nickname || senderId);
  const normalized = normalizeSegments(event.message, { selfId, ignoreForward });

  const isGroup = messageType === 'group';
  const groupId = isGroup ? String(event.group_id ?? '') : null;
  const conversationId = isGroup ? `qq_group_${groupId}` : `qq_private_${senderId}`;

  return {
    messageId: String(event.message_id ?? ''),
    conversationId,
    groupId,
    senderId,
    senderName,
    isGroup,
    isSelf: selfId !== '' && senderId === String(selfId),
    text: normalized.text,
    isAt: normalized.isAt,
    replyToId: normalized.replyToId || '',
    isMentioned: normalized.isMentioned,
    hasForward: normalized.hasForward,
    forwardOnly: normalized.forwardOnly,
    images: normalized.images,
    receivedAt: Number(event.time ?? Math.floor(Date.now() / 1000)),
    raw: event,
  };
}

/**
 * 判断消息是否应当被完全跳过（不写库、不判定）。
 *
 * 只有「整条消息就是一段转发」时才跳过——这跟「转发 + 文字」不同，
 * 后者仍有真实发言，需要保留。
 */
export function shouldSkipMessage(message) {
  if (!message) return true;
  if (message.isSelf) return true;
  if (message.forwardOnly) return true;
  return false;
}

/** 群聊子语境 ID：按人隔离的记忆命名空间。 */
export function perUserConversationId(message) {
  if (!message?.isGroup) return message?.conversationId ?? '';
  return `${message.conversationId}_u${message.senderId}`;
}
