/**
 * 拟人化总装：把 LLM 原始回复加工成「像真人发的几条消息」。
 *
 * 顺序有讲究：
 * 1. 先分段——按原意断句，此时还没有错别字
 * 2. 再逐段加错别字——错字只影响字面，不影响断句
 * 3. 最后生成纠正消息——真人打错字后会补一条
 */
import { config } from '../config.js';
import { createTypoSentence } from './typo.js';
import { splitReply } from './splitter.js';
import { calculateTypingDelay } from './typing.js';

/**
 * 把 LLM 回复加工成待发送的消息序列。
 *
 * @param {string} rawReply LLM 原始输出
 * @param {object} [overrides] 覆盖配置
 * @returns {{text: string, quotePrevious: boolean, delayMs: number}[]}
 */
export function buildOutgoingMessages(rawReply, overrides = {}) {
  const source = String(rawReply || '').trim();
  if (!source) return [];

  const splitterCfg = { ...config.persona.splitter, ...overrides.splitter };
  const typoCfg = { ...config.persona.typo, ...overrides.typo };

  const segments = splitterCfg.enabled
    ? splitReply(source, {
        maxLength: splitterCfg.maxLength,
        maxSplitNum: splitterCfg.maxSplitNum,
      })
    : [source];

  const messages = [];
  // 打字延迟开关：config.persona.typing.enabled 为 false 时全部 0
  const typingCfg = config.persona.typing || {};
  const calcDelay = (text) => (typingCfg.enabled === false ? 0 : calculateTypingDelay(text, {
    speed: typingCfg.speed ?? 1,
    chineseCharSec: typingCfg.chineseCharSec ?? 0.09,
    englishCharSec: typingCfg.englishCharSec ?? 0.045,
  }));

  for (const segment of segments) {
    // 打字延迟按「这条消息的字数」算——发送方在 stages.sendOne 消费
    const delayMs = calcDelay(segment);
    if (!typoCfg.enabled) {
      messages.push({ text: segment, quotePrevious: false, delayMs });
      continue;
    }

    const { text, correction } = createTypoSentence(segment, {
      errorRate: typoCfg.errorRate,
      toneErrorRate: typoCfg.toneErrorRate,
      wordReplaceRate: typoCfg.wordReplaceRate,
      correctionProbability: typoCfg.correctionProbability,
    });

    // 有纠正建议时，一半概率补发一条纠正，一半概率直接用正确句子
    if (correction && text !== segment) {
      if (Math.random() < 0.5) {
        messages.push({ text, quotePrevious: false, delayMs });
        messages.push({ text: correction, quotePrevious: true, delayMs: calcDelay(correction) });
      } else {
        messages.push({ text: segment, quotePrevious: false, delayMs });
      }
    } else {
      messages.push({ text, quotePrevious: false, delayMs });
    }
  }

  return messages;
}
