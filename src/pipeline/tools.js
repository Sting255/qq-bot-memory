/**
 * 工具检测：从消息批次里识别生图/语音请求，并给出对应 hint。
 *
 * 从 handler._handleBatch 平移。检测必须发生在进入 pipeline 之前——
 * 它参与「要不要回复」的决策（明确要图要声时不受概率门控约束）。
 * 后续如需更多被动工具（如表情包、点歌），在此统一注册。
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { detectImageRequest, hasImageSignal, judgeImageIntent } from '../chat/image.js';
import { detectVoiceRequest } from '../chat/tts.js';

const log = createLogger('tools');

/** 生图时的补充提示（平移自 handler，注释也一并保留）：
 * 不加这条，模型看到「画一张」很可能反问「画什么呀」，
 * 而图其实已经在生成了——文字和图各说各的会很怪。 */
export const IMAGE_HINT =
  '用户要你画一张图，图正在生成，十几秒后会单独发出来。' +
  '你就回一句简短的话表示在画了，比如「等一下」「这就画」。' +
  '不要反问画什么，不要描述画面细节，不要解释怎么生成。15 字以内。';

/** 语音请求的补充提示：不让模型说「我不会发语音」这类出戏的话。 */
export const VOICE_HINT =
  '这条回复会被系统合成语音发给对方。你就像平时聊天一样说一句话就行。' +
  '不要说自己发不出语音、不会说话之类的话，也不要解释合成、文字这些技术细节。';

/**
 * @param {object} params
 * @param {object} params.message 批次里最新一条消息
 * @param {(message: object, request: object) => boolean} params.startImageJob 启动生图任务（冷却/并发控制由调用方持有）
 * @returns {Promise<{imageRequest: {matched: boolean, scene?: string}, voiceRequest: {matched: boolean}, imageStarted: boolean}>}
 */
export async function detectTools({ message, startImageJob }) {
  // 群聊里没被 @ 也没提及名字时，完全不碰生图逻辑。
  // 否则别人闲聊带个「画」字就被配图，非常烦。
  const imageAllowed = config.image.enabled
    && (!message.isGroup || message.isAt || message.isMentioned);

  // 生图是明确指令，不受频率门控约束——用户主动要图时门控挡掉很突兀
  const imageRequest = imageAllowed
    ? detectImageRequest(message.text)
    : { matched: false };

  // 语音请求同样要求被 @ 或提及，不然群里容易突然冒出语音
  const voiceAllowed = config.tts.enabled
    && (!message.isGroup || message.isAt || message.isMentioned);
  const voiceRequest = voiceAllowed
    ? detectVoiceRequest(message.text)
    : { matched: false };

  let imageStarted = imageRequest.matched
    ? startImageJob(message, imageRequest)
    : false;

  // 弱信号兜底：正则没命中但句子里明显在聊画图，让模型判断一次。
  if (!imageStarted && imageAllowed) {
    if (hasImageSignal(message.text)) {
      try {
        const want = await judgeImageIntent({ text: message.text });
        log.info(`生图意图判断: "${message.text.slice(0, 40)}" -> ${want ? '要图' : '不要'}`);
        if (want) {
          imageStarted = startImageJob(message, { matched: true, scene: message.text });
        }
      } catch (error) {
        log.debug('生图意图判断失败:', error.message);
      }
    } else {
      log.info(`生图判断跳过: 正则未命中，且没有画图相关词 ("${message.text.slice(0, 30)}")`);
    }
  } else if (!imageAllowed && (message.isGroup && !message.isAt)) {
    log.debug(`未 @ 也未提及，跳过生图判断 ("${message.text.slice(0, 30)}")`);
  }

  return { imageRequest, voiceRequest, imageStarted };
}
