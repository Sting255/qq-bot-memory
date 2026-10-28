/**
 * 回复概率估计：七特征逻辑回归。
 *
 * 权重直接取自 MaiBot v1.3.14 的 src/maisaka/turn_trigger/reply_likelihood.py，
 * 由真实群聊记录拟合得到（拟合样本只包含「有新的外部消息且没有 @ 机器人」的轮次）。
 * 不要随手改这些系数——它们是数据拟合结果，不是拍脑袋的权重。
 *
 * 用途：估计「这批消息如果不设门控，机器人会开口的概率」，
 * 供动态门控换算成回复额度。
 */

/** 待处理消息数进入函数前的上限，与拟合时的截断一致。 */
export const MAX_PENDING_COUNT = 20;

/**
 * 窗口内消息数的上限。拟合样本来自中等活跃群，而我们这个群 5 分钟能到
 * 50+ 条，落在拟合样本之外——-0.0367/条 的惩罚一路线性叠下去，概率被压到
 * 0.03，任何阈值都够不着，等于永久闭嘴。截断到拟合范围内的上沿，
 * 保留「群越热越少插话」的倾向，但不让它失控。
 */
export const MAX_RECENT_MESSAGE_COUNT = 20;

/** 上下文中没有机器人发言时采用的间隔，与拟合时的缺省值一致。 */
export const DEFAULT_SECONDS_SINCE_BOT_MESSAGE = 3600;

/** 只有媒体占位、没有文字内容的消息前缀。 */
export const MEDIA_PLACEHOLDER_PREFIXES = [
  '[表情包',
  '[图片',
  '[消息类型]',
  '[CQ:image',
  '[语音',
  '[文件]',
  '[卡片',
];

const INTERCEPT = -1.2005;
const WEIGHT_MENTION_BOT = 1.5852;
const WEIGHT_AT_OTHER = -1.1157;
const WEIGHT_QUESTION_MARK = 0.4807;
const WEIGHT_PLACEHOLDER_ONLY = -1.0281;
const WEIGHT_RECENT_SELF_RATIO = 2.6525;
const WEIGHT_RECENT_MESSAGE_COUNT = -0.0367;
const WEIGHT_LOG_SECONDS_SINCE_BOT = 0.0571;
const WEIGHT_PENDING_COUNT = 0.1012;

/**
 * 从新消息文本得到三个布尔特征。
 *
 * @param {string[]} texts 新消息的纯文本
 * @param {{hasAtBot: boolean}} options 本批消息里是否有 @ 机器人
 * @returns {{atOther: boolean, hasQuestionMark: boolean, placeholderOnly: boolean}}
 */
export function summarizePendingTexts(texts, { hasAtBot = false } = {}) {
  const stripped = (texts || []).map((text) => String(text ?? '').trim()).filter(Boolean);
  const atOther = !hasAtBot && stripped.some((text) => text.includes('@'));
  const hasQuestionMark = stripped.some((text) => text.includes('?') || text.includes('？'));
  const placeholderOnly =
    stripped.length > 0 &&
    stripped.every((text) => MEDIA_PLACEHOLDER_PREFIXES.some((prefix) => text.startsWith(prefix)));
  return { atOther, hasQuestionMark, placeholderOnly };
}

/**
 * 估计这批消息进入对话流程后机器人会开口的概率。
 *
 * @param {object} input
 * @param {boolean} input.mentionBot 新消息里是否提到了机器人名字
 * @param {boolean} input.atOther 新消息里是否 @ 了机器人以外的人
 * @param {boolean} input.hasQuestionMark 新消息里是否带问号
 * @param {boolean} input.placeholderOnly 新消息是否全是媒体占位
 * @param {number} input.recentSelfRatio 最近 5 分钟机器人发言占比
 * @param {number} input.recentMessageCount 最近 5 分钟消息条数
 * @param {number} input.secondsSinceBotMessage 距机器人上次发言的秒数
 * @param {number} input.pendingCount 本批新的外部消息条数
 * @returns {number} 0~1 的概率
 */
export function estimateReplyProbability(input) {
  const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));
  const logit =
    INTERCEPT +
    WEIGHT_MENTION_BOT * (input.mentionBot ? 1 : 0) +
    WEIGHT_AT_OTHER * (input.atOther ? 1 : 0) +
    WEIGHT_QUESTION_MARK * (input.hasQuestionMark ? 1 : 0) +
    WEIGHT_PLACEHOLDER_ONLY * (input.placeholderOnly ? 1 : 0) +
    WEIGHT_RECENT_SELF_RATIO * clamp01(input.recentSelfRatio) +
    WEIGHT_RECENT_MESSAGE_COUNT * Math.min(MAX_RECENT_MESSAGE_COUNT, Math.max(0, Number(input.recentMessageCount) || 0)) +
    WEIGHT_LOG_SECONDS_SINCE_BOT * Math.log1p(Math.max(0, Number(input.secondsSinceBotMessage) || 0)) +
    WEIGHT_PENDING_COUNT * Math.min(MAX_PENDING_COUNT, Math.max(0, Number(input.pendingCount) || 0));

  return 1 / (1 + Math.exp(-logit));
}
