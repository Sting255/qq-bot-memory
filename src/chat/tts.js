/**
 * 语音合成：用小米 MiMo 的 voiceclone 模型复刻角色音色。
 *
 * 为什么选它：本地方案（GPT-SoVITS 之类）要占 6~8G 显存，这台机器上还要
 * 和别的 GPU 任务抢；MiMo 走云端，零显存，而且是 OpenAI 兼容协议，
 * 和现有的 LLM 客户端是同一套调用习惯。TTS 系列目前限时免费。
 *
 * 音色来源是一段参考音频，每次请求都随 body 一起传（10MB 以内，mp3/wav）。
 * 样本挑 20 秒左右的干净人声就够，太长只会让请求体变重。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('tts');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 扩展名 → MIME 类型。接口只认 mp3 和 wav。 */
const MIME_BY_EXT = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/** 缓存参考音频的 base64，避免每次请求都重新读盘编码。 */
let sampleCache = null;
let sampleCachePath = '';

/**
 * 读参考音频并编码成 data URL。
 *
 * @returns {string} data:audio/xxx;base64,....
 */
function loadVoiceSample() {
  const samplePath = resolve(ROOT, config.tts.samplePath);
  if (sampleCache && sampleCachePath === samplePath) return sampleCache;

  if (!existsSync(samplePath)) {
    // 一次说清楚怎么办，别让使用者反复看到同一句报错
    throw new Error(
      `找不到语音样本 ${config.tts.samplePath}——` +
      '仓库不分发音频素材，请自备 20 秒以内的 mp3/wav 放到该路径，'
      + '详见 resources/voice/README.md',
    );
  }

  const ext = extname(samplePath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(`语音样本只支持 mp3 / wav，当前是 ${ext || '无扩展名'}`);
  }

  const base64 = readFileSync(samplePath).toString('base64');
  // 接口限制 10MB，超了会在服务端报错，这里先挡一下
  const approxMb = (base64.length * 3) / 4 / 1024 / 1024;
  if (approxMb > 9.5) {
    throw new Error(`语音样本太大（约 ${approxMb.toFixed(1)}MB），请截短到 20 秒以内`);
  }

  sampleCache = `data:${mime};base64,${base64}`;
  sampleCachePath = samplePath;
  log.info(`语音样本已加载: ${config.tts.samplePath}（约 ${approxMb.toFixed(2)}MB）`);
  return sampleCache;
}

/**
 * 把文字合成为语音。
 *
 * @param {object} params
 * @param {string} params.text 要念的内容
 * @param {string} [params.style] 风格指令，不传用配置里的默认值
 * @returns {Promise<Buffer>} wav 音频数据
 */
export async function synthesize({ text, style = '' }) {
  const tts = config.tts;
  if (!tts.enabled) throw new Error('语音合成未启用');
  if (!tts.apiKey) throw new Error('未配置 MiMo 密钥');

  const content = String(text || '').trim();
  if (!content) throw new Error('合成内容为空');
  // 太长会拖慢生成、也容易触发长度限制
  const clipped = content.slice(0, 300);

  const body = {
    model: tts.model,
    messages: [
      // user 是风格指令，不会出现在语音里
      { role: 'user', content: style || tts.style || '' },
      // 真正要念的文本必须放 assistant
      { role: 'assistant', content: clipped },
    ],
    audio: {
      format: 'wav',
      voice: loadVoiceSample(),
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), tts.timeoutMs);
  const startedAt = Date.now();

  let response;
  try {
    response = await fetch(`${tts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') {
      throw new Error(`语音合成超时（${tts.timeoutMs}ms）`);
    }
    throw new Error(`语音合成请求失败: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`语音合成接口 ${response.status}: ${detail.slice(0, 200)}`);
  }

  const payload = await response.json();
  const base64 = payload?.choices?.[0]?.message?.audio?.data;
  if (!base64) {
    throw new Error(`语音合成返回无音频: ${JSON.stringify(payload).slice(0, 200)}`);
  }

  const buffer = Buffer.from(base64, 'base64');
  log.info(`语音合成完成 耗时=${Date.now() - startedAt}ms 字数=${clipped.length} 字节=${buffer.length}`);
  return buffer;
}

/**
 * 判断这条消息是不是要求发语音。
 *
 * 和生图一样走被动触发——群里每句话都发语音会很吵。
 *
 * @param {string} text
 * @returns {{matched: boolean}}
 */
export function detectVoiceRequest(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 200) return { matched: false };

  // 明确的语音指令
  const patterns = [
    /(语音|念一下|说句话|说一句|来一句|出一声|听听你的?声音)/,
    /(用|发)语音/,
    /唱(一?首|个|歌)/,
    /(读|念)(一下|出来|一遍)/,
  ];
  for (const pattern of patterns) {
    if (pattern.test(raw)) return { matched: true };
  }
  return { matched: false };
}
