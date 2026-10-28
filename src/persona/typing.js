/**
 * 打字延迟模拟。
 *
 * 移植自 MaiBot v1.3.14 的 src/chat/utils/utils.py 中 calculate_typing_time，
 * 但修了它的一个问题：原版按 0.3 秒/字算，16 个字要等 4.8 秒，
 * 加上 LLM 本身 4 秒，用户要干等 9 秒——真人打字也没这么慢。
 *
 * 这里改成 0.09 秒/字（约每分钟 111 字，接近正常打字速度），
 * 并加 2.5 秒上限，避免长回复无限等下去。
 */

/** 单条消息的延迟上限（毫秒）。超过就别等了，直接发。 */
const MAX_DELAY_MS = 2500;

/**
 * 计算发送某条消息前的等待时长（毫秒）。
 *
 * @param {string} text 要发送的文本
 * @param {object} options
 * @param {number} options.speed 0=最快，1=默认，2=更慢
 * @param {number} options.chineseCharSec 每个中文字符的耗时
 * @param {number} options.englishCharSec 每个非中文字符的耗时
 * @returns {number} 毫秒
 */
export function calculateTypingDelay(text, options = {}) {
  const {
    speed = 1,
    chineseCharSec = 0.09,
    englishCharSec = 0.045,
  } = options;

  if (speed <= 0) return 0;

  const source = String(text || '');
  if (!source) return 0;

  const chineseCount = [...source].filter((char) => /[\u4e00-\u9fff]/.test(char)).length;

  // 只有一个中文字符时用 3 倍时间：真人打单字要想一下
  if (chineseCount === 1 && source.trim().length === 1) {
    return Math.min(MAX_DELAY_MS, Math.round((chineseCharSec * 3 + 0.2) * speed * 1000));
  }

  let totalSeconds = 0;
  for (const char of source) {
    totalSeconds += /[\u4e00-\u9fff]/.test(char) ? chineseCharSec : englishCharSec;
  }

  // 回车时间：发消息这个动作本身有成本
  totalSeconds += 0.2;

  return Math.min(MAX_DELAY_MS, Math.round(totalSeconds * speed * 1000));
}

/** 延迟执行。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
