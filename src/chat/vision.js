/**
 * 识图：把 QQ 图片转成文字描述，喂给主聊天模型。
 *
 * 为什么不直接把图片发给主模型：deepseek-v4.1-flash 在上游不是多模态，
 * 带图请求会被拒（502 The request model is not multimodal）并触发账号
 * 10 分钟冷却，等于把机器人打死。所以走两段式：
 *
 *   图片 URL → 视觉模型（Qwen3-VL）→ 一句文字描述 → 注入对话
 *
 * 描述按 URL 缓存，同一张图（群里反复转发）只识别一次。
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('vision');

/**
 * 熔断：识图请求被上游拒绝（502/503）会让网关账号进 10 分钟冷却，
 * 期间连主聊天都不可用——一张坏图能拖垮整个机器人。
 * 所以一旦出现上游级失败，直接停用识图一段时间，宁可暂时不认图。
 */
const BREAKER_COOLDOWN_MS = 20 * 60_000;
let breakerUntil = 0;

/** 识图是否因上游故障被临时停用。 */
export function isVisionTripped() {
  return Date.now() < breakerUntil;
}

function tripBreaker(reason) {
  breakerUntil = Date.now() + BREAKER_COOLDOWN_MS;
  log.error(`识图熔断 ${BREAKER_COOLDOWN_MS / 60000} 分钟（${reason}）——期间图片只记占位，不调用上游`);
}

/** URL -> { text, at }。LRU 用 Map 的插入顺序，超上限删最早的。 */
const cache = new Map();
const CACHE_MAX = 300;
const CACHE_TTL_MS = 6 * 3600_000;

const PROMPT =
  '用一句中文描述这张图片里有什么、在表达什么，20 字以内。' +
  '如果是截图或带文字的图，把关键文字原样带上。只输出描述本身，不要任何前缀。';

/**
 * 描述单张图片。
 * @param {string} url 图片地址（http/https 或 data:）
 * @returns {Promise<string>} 描述文本，失败返回空串
 */
export async function describeImage(url) {
  if (!config.vision?.enabled) return '';
  if (isVisionTripped()) {
    log.debug('识图熔断中，跳过');
    return '';
  }
  const key = String(url || '').slice(0, 500);
  if (!key) return '';

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.text;

  // 两种传法，按顺序尝试：
  // 1) 原始 http(s) 地址：上游自己下载，实测它更认这种
  // 2) base64 data URI：上游下载不到时兜底（部分上游不认 data URI）
  const isRemote = key.startsWith('http://') || key.startsWith('https://');
  const remoteRef = isRemote ? key : '';
  let localRef = '';
  if (isRemote) {
    try {
      const imgRes = await fetch(key, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://qq.com/' },
        signal: AbortSignal.timeout(10000),
      });
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        if (buf.length > 0 && buf.length <= 6 * 1024 * 1024) {
          const mime = imgRes.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
          localRef = `data:${mime};base64,${buf.toString('base64')}`;
          log.debug(`图片已下载 ${buf.length}B ${mime}`);
        }
      } else {
        log.warn(`图片下载失败 ${imgRes.status}: ${key.slice(0, 80)}`);
      }
    } catch (error) {
      log.warn('图片下载异常:', error.message);
    }
  } else {
    localRef = key; // 已是 data URI 或本地路径
  }

  // 尝试顺序：远程地址 → 本地 base64（如果下载到了）
  const attempts = [];
  if (remoteRef) attempts.push(remoteRef);
  if (localRef && localRef !== remoteRef) attempts.push(localRef);
  if (attempts.length === 0) {
    log.warn('没有可用的图片引用，跳过识图');
    return '';
  }

  // 地址与接口都来自配置（llm.vision.base_url / llm.vision.path），
  // 换供应商时只改配置，不用动代码。path 也可以直接填完整 URL。
  const endpoint = /^https?:\/\//i.test(config.vision.path || '')
    ? config.vision.path
    : `${String(config.vision.baseUrl || '').replace(/\/+$/, '')}/${String(config.vision.path || '/chat/completions').replace(/^\/+/, '')}`;

  for (let i = 0; i < attempts.length; i += 1) {
    const imageRef = attempts[i];
    const isLast = i === attempts.length - 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.vision.timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.vision.apiKey ? { Authorization: `Bearer ${config.vision.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.vision.model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: { url: imageRef } },
            ],
          }],
          max_tokens: 500,
          temperature: 0.2,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log.warn(`识图失败 ${res.status}（第 ${i + 1}/${attempts.length} 种传法）: ${body.slice(0, 120)}`);
        // 上游级故障（账号冷却/服务不可用）会连累聊天，直接熔断
        if ([502, 503, 504].includes(res.status)) {
          tripBreaker(`上游 ${res.status}`);
          return '';
        }
        if (!isLast) continue;
        return '';
      }

      const data = await res.json();
      const text = String(data?.choices?.[0]?.message?.content || '').trim();
      if (!text) return '';

      // reasoning 模型的思考内容不算，只要正文；超长截断
      const cleaned = text.replace(/\s+/g, ' ').slice(0, 80);
      cache.set(key, { text: cleaned, at: Date.now() });
      if (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
      }
      log.info(`识图完成: ${cleaned}`);
      return cleaned;
    } catch (error) {
      const aborted = error.name === 'AbortError' || /abort/i.test(String(error.message || ''));
      log.warn(`识图${aborted ? '超时' : '异常'}（第 ${i + 1}/${attempts.length} 种传法）: ${error.message}`);
      if (!isLast) continue;
      return '';
    } finally {
      clearTimeout(timer);
    }
  }
  return '';
}

/**
 * 批量描述当前消息里的图片。
 * @param {string[]} urls
 * @returns {Promise<string[]>} 与输入同序，失败的为空串
 */
export async function describeImages(urls) {
  if (!config.vision?.enabled) return [];
  const list = (urls || []).slice(0, config.vision.maxImages);
  if (list.length === 0) return [];
  // 并行识别：多图时总耗时取决于最慢的一张
  return Promise.all(list.map((url) => describeImage(url)));
}

/**
 * 把描述渲染成注入 prompt 的文本块。
 * @param {string[]} descriptions
 */
export function formatImageBlock(descriptions) {
  const valid = (descriptions || []).filter(Boolean);
  if (valid.length === 0) return '';
  if (valid.length === 1) {
    return `<image_context>\n当前消息附带一张图片，内容是：${valid[0]}\n</image_context>`;
  }
  const lines = ['<image_context>', '当前消息附带图片，内容是：'];
  valid.forEach((d, i) => lines.push(`${i + 1}. ${d}`));
  lines.push('</image_context>');
  return lines.join('\n');
}
