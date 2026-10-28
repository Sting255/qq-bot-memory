/**
 * 引用回复概率模型。
 *
 * 移植自 MaiBot v1.3.14 的 src/maisaka/quote/rules.py。
 * 系数来自离线 AI 弱标签试验拟合，不是拍脑袋的权重，不要随意调整。
 *
 * 设计意图：引用是活人感的强信号——真人会指着某句话回。
 * 但每次都引用就成了客服，所以按概率抽签，让「什么时候该指着说」有依据。
 */

/** 引用频率档位。 */
export const QUOTE_FREQUENCY = {
  NEVER: 'never',
  OCCASIONALLY: 'occasionally',
  OFTEN: 'often',
};

/** 目标距离上限：超出拟合窗口不再外推。 */
const MAX_TARGET_DISTANCE = 32;

/** 对方连发条数上限。 */
const MAX_PREVIOUS_BURST = 16;

/**
 * 群聊引用概率。
 *
 * 八个基础概率分别对应：文本是否为空（纯媒体）、上一条是否自己发的、
 * 距今秒数、文本长度。再乘以频率档位与目标距离系数。
 *
 * @param {object} params
 * @param {number} params.textLength 待发送文本长度
 * @param {boolean} params.previousSenderSelf 上一条消息是否机器人自己发的
 * @param {number} params.previousSeconds 距上一条消息的秒数
 * @param {string} params.frequency 引用频率档位
 * @param {number} params.targetDistance 引用目标距当前的消息条数
 * @returns {number} 0~1 的概率
 */
export function groupQuoteProbability({
  textLength,
  previousSenderSelf,
  previousSeconds,
  frequency,
  targetDistance,
}) {
  if (targetDistance < 0) throw new Error('引用目标距离不能为负数');
  if (frequency === QUOTE_FREQUENCY.NEVER) return 0;
  if (frequency !== QUOTE_FREQUENCY.OCCASIONALLY && frequency !== QUOTE_FREQUENCY.OFTEN) {
    throw new Error(`未知的引用频率档位：${frequency}`);
  }

  let probability;
  if (textLength === 0) {
    probability = previousSenderSelf
      ? (previousSeconds <= 3 ? 0.005913471588878362 : 0.013812173277286514)
      // 前一分钟是否有人发言，等价于上一条发言距今是否不超过 60 秒
      : (previousSeconds <= 60 ? 0.025472825783009516 : 0.0108627046866078);
  } else if (previousSenderSelf) {
    probability = previousSeconds <= 3 ? 0.011765162067321502 : 0.07760369512696548;
  } else {
    probability = textLength <= 50 ? 0.20934408508581265 : 0.08614950202149084;
  }

  let distanceMultiplier;
  if (targetDistance === 0) distanceMultiplier = 0.5;
  else if (targetDistance <= 2) distanceMultiplier = 1.0;
  else if (targetDistance <= 5) distanceMultiplier = 1.1;
  else distanceMultiplier = 1.5;

  const frequencyMultiplier = frequency === QUOTE_FREQUENCY.OFTEN ? 2 : 1;
  return Math.min(1, probability * frequencyMultiplier * distanceMultiplier);
}

/**
 * 私聊引用概率：logistic 形式，距离按往前第几条计算。
 *
 * @param {object} params
 * @param {number} params.textLength 待发送文本长度
 * @param {boolean} params.previousSenderSelf 上一条是否自己发的
 * @param {number} params.previousSeconds 距上一条消息秒数
 * @param {number} params.previousBurst 对方连发条数
 * @param {number} params.targetDistance 引用目标距离
 * @param {string} params.frequency 引用频率档位
 * @returns {number} 0~1 的概率
 */
export function privateQuoteProbability({
  textLength,
  previousSenderSelf,
  previousSeconds,
  previousBurst,
  targetDistance,
  frequency,
}) {
  if (targetDistance < 0) throw new Error('引用目标距离不能为负数');
  if (frequency === QUOTE_FREQUENCY.NEVER) return 0;
  if (frequency !== QUOTE_FREQUENCY.OCCASIONALLY && frequency !== QUOTE_FREQUENCY.OFTEN) {
    throw new Error(`未知的引用频率档位：${frequency}`);
  }

  let z = -4.176576611204103;
  if (previousSenderSelf) {
    z += previousSeconds <= 3 ? -2.0390866101745555 : 0.407259409803155;
  } else {
    z += 0.6811570734750046 * Math.log2(Math.max(1, Math.min(previousBurst, MAX_PREVIOUS_BURST)));
  }
  if (textLength === 0) z -= 3.4527659205203576;
  z += 0.521800209819322 * Math.log2(Math.min(targetDistance + 1, MAX_TARGET_DISTANCE));

  const probability = 1 / (1 + Math.exp(-z));
  const frequencyMultiplier = frequency === QUOTE_FREQUENCY.OFTEN ? 2 : 1;
  return Math.min(1, probability * frequencyMultiplier);
}

/**
 * 决定是否引用。
 *
 * 窗口外或历史目标无序号时直接引用（返回概率 1）——
 * 因为此时无法计算距离，保守选择引用更自然。
 *
 * @param {object} params
 * @param {object|null} params.context 引用上下文快照
 * @param {string} params.botUserId 机器人自己的账号
 * @param {string} params.text 待发送文本
 * @param {string} params.frequency 引用频率档位
 * @param {boolean} params.isGroup 是否群聊
 * @param {() => number} params.random 随机源，测试时可注入
 * @returns {{shouldQuote: boolean, probability: number}}
 */
export function decideQuote({
  context,
  botUserId,
  text,
  frequency,
  isGroup,
  random = Math.random,
}) {
  if (frequency === QUOTE_FREQUENCY.NEVER) return { shouldQuote: false, probability: 0 };
  if (frequency !== QUOTE_FREQUENCY.OCCASIONALLY && frequency !== QUOTE_FREQUENCY.OFTEN) {
    throw new Error(`未知的引用频率档位：${frequency}`);
  }

  if (!context || context.targetDistance === null || context.targetDistance === undefined) {
    return { shouldQuote: true, probability: 1 };
  }

  const common = {
    textLength: String(text || '').trim().length,
    previousSenderSelf: context.previousSenderId === botUserId,
    previousSeconds: context.previousSeconds,
    targetDistance: context.targetDistance,
    frequency,
  };

  const probability = isGroup
    ? groupQuoteProbability(common)
    : privateQuoteProbability({ ...common, previousBurst: context.previousBurst ?? 1 });

  return { shouldQuote: random() < probability, probability };
}

/**
 * 构造引用上下文快照。
 *
 * @param {object} params
 * @param {object[]} history 历史消息（按时间正序）
 * @param {string} targetMessageId 引用目标的消息 ID
 * @param {string} botUserId 机器人账号
 * @param {number} nowSeconds 当前时间戳（秒）
 * @returns {object|null}
 */
export function buildQuoteContext({ history, targetMessageId, botUserId, nowSeconds }) {
  if (!Array.isArray(history) || history.length === 0) return null;
  if (!targetMessageId) return null;

  const targetIndex = history.findIndex((item) => String(item.messageId) === String(targetMessageId));
  if (targetIndex === -1) return null;

  // 目标距离：从最新消息往回数第几条
  const targetDistance = history.length - 1 - targetIndex;
  const previous = history[history.length - 1];
  const previousSeconds = previous?.receivedAt ? Math.max(0, nowSeconds - previous.receivedAt) : 0;

  // 对方连发条数：从末尾往回数同一个人的连续消息
  let previousBurst = 1;
  for (let i = history.length - 1; i > 0; i -= 1) {
    if (String(history[i].senderId) === String(history[i - 1].senderId)) previousBurst += 1;
    else break;
  }

  return {
    targetDistance,
    previousSenderId: String(previous?.senderId ?? ''),
    previousSeconds,
    previousBurst,
  };
}
