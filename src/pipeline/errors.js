/**
 * 错误翻译：把底层异常转成给群友看的一句话（借鉴 AstrBot 的
 * error_redaction + llm_error_messages 思想，话术自拟）。
 *
 * 原则：
 * - 只在「一条都没发出去」时兜底发这句；已发出部分内容就不补
 * - 话术要像人不像日志，不暴露服务地址/超时细节
 * - 频控：同一会话短时间内不重复道歉，免得连环失败刷屏
 */
const messages = [
  { match: /timeout|timed? out|ETIMEDOUT|aborted|ECONNRESET|ECONNREFUSED|fetch failed|network/i, text: '卡了，等下再试试' },
  { match: /429|rate.?limit|quota|配额|余额/i, text: '现在有点忙，稍等我缓缓' },
  { match: /401|403|auth|unauthorized|api key|令牌/i, text: '出小问题了，晚点再聊' },
];

/** 会话 -> 上次兜底发送时间戳 */
const lastSentAt = new Map();
const THROTTLE_MS = 60_000;

/**
 * 翻译错误消息；返回用户可见的一句话，无法识别或被频控时返回空串。
 * @param {string} conversationId
 * @param {string|undefined} errorMessage
 */
export function friendlyError(conversationId, errorMessage) {
  if (!errorMessage) return '';
  const now = Date.now();
  if (now - (lastSentAt.get(conversationId) || 0) < THROTTLE_MS) return '';

  for (const item of messages) {
    if (item.match.test(errorMessage)) {
      lastSentAt.set(conversationId, now);
      return item.text;
    }
  }
  return '';
}
