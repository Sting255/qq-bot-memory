/**
 * 联网工具：聊天中按需获取实时信息。
 *
 * 设计原则：不做每轮预检索——那会让每条消息都多几百毫秒。
 * 只在文本明确需要时才查，其余情况零开销。
 *
 * 目前支持两类：
 * - 天气（wttr.in，免费无 key，实测 900ms）
 * - 通用搜索（Bing，实测 500ms）
 *
 * 维基百科 API 在国内网络下超时，没有采用。
 */
import { createLogger } from '../logger.js';

const log = createLogger('web-tools');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 8000;

/** 默认城市，用户没指定时用。 */
const DEFAULT_CITY = 'Hangzhou';

/**
 * 判断这条消息是否需要联网，以及需要什么。
 *
 * 两套机制并存：
 * 1. 关键词快速命中（零 LLM 开销，覆盖明确的天气/搜索需求）
 * 2. 模型自主判断（在回复里输出 [SEARCH: 关键词]，见 orchestrator）
 *
 * 关键词只是「快速通道」，覆盖不全没关系——模型那条路兜底。
 *
 * @param {string} text 用户消息
 * @returns {'weather'|'search'|null}
 */
export function detectWebNeed(text) {
  const value = String(text || '');
  if (!value.trim()) return null;

  // 天气类：问温度、下雨、天气
  if (/(天气|几度|多少度|气温|温度|下雨|下雪|冷不冷|热不热)/.test(value)) {
    return 'weather';
  }

  // 明确的搜索指令
  if (/(搜一下|搜搜|查一下|查查|帮我搜|帮我查|百度一下|谷歌一下)/.test(value)) {
    return 'search';
  }
  if (/(最新|最近).{0,6}(消息|新闻|情况|怎么样|动态)/.test(value)) {
    return 'search';
  }

  return null;
}

/** 模型在回复里输出这个标记时，表示它需要联网。 */
export const SEARCH_MARKER_RE = /\[SEARCH:\s*([^\]\n]{1,80})\]/;

/**
 * 从模型输出里提取搜索请求。
 *
 * @param {string} text 模型输出
 * @returns {string|null} 搜索关键词
 */
export function extractSearchRequest(text) {
  const match = SEARCH_MARKER_RE.exec(String(text || ''));
  return match ? match[1].trim() : null;
}

/** 从文本里提取城市名，没提到就用默认。 */
export function extractCity(text) {
  const value = String(text || '');
  // 常见城市白名单，避免把无关词当城市
  const known = [
    '北京', '上海', '广州', '深圳', '杭州', '南京', '成都', '重庆', '武汉', '西安',
    '苏州', '天津', '长沙', '郑州', '青岛', '大连', '厦门', '福州', '合肥', '昆明',
    '哈尔滨', '沈阳', '济南', '石家庄', '太原', '南昌', '贵阳', '南宁', '海口', '兰州',
  ];
  for (const city of known) {
    if (value.includes(city)) return city;
  }
  // 「XX天气」形式：取前面 2-4 个字
  const match = /([\u4e00-\u9fff]{2,4})(?:的)?(?:天气|气温|温度|几度)/.exec(value);
  if (match) {
    const candidate = match[1];
    // 「现在的天气」「最近的天气」里的「现在的」不是城市名，
    // 含这些虚词就一律回落到默认城市，否则会拿无效地名去查天气。
    const notCity = /(的|了|现在|今天|明天|后天|昨天|最近|目前|当地|这里|那边|外面|这边|那里|我们)/;
    if (!notCity.test(candidate)) return candidate;
  }
  return DEFAULT_CITY;
}

/**
 * 查天气。
 *
 * @param {string} city 城市名（支持中文）
 * @returns {Promise<string>} 可注入 prompt 的天气描述，失败返回空串
 */
export async function fetchWeather(city) {
  const target = String(city || DEFAULT_CITY).trim() || DEFAULT_CITY;
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(target)}?format=j1&lang=zh`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const cur = data.current_condition?.[0];
    if (!cur) return '';

    const desc = cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '';
    const temp = cur.temp_C;
    const feels = cur.FeelsLikeC;
    const humidity = cur.humidity;

    // 今天的最高最低
    const today = data.weather?.[0];
    const maxTemp = today?.maxtempC;
    const minTemp = today?.mintempC;

    const parts = [`${target}现在 ${temp}°C`];
    if (desc) parts.push(desc);
    if (feels && feels !== temp) parts.push(`体感 ${feels}°C`);
    if (maxTemp && minTemp) parts.push(`今天 ${minTemp}~${maxTemp}°C`);
    if (humidity) parts.push(`湿度 ${humidity}%`);

    const text = parts.join('，');
    log.info(`天气查询成功: ${text}`);
    return text;
  } catch (error) {
    log.warn(`天气查询失败 (${target}):`, error.message);
    return '';
  }
}

/** 清理 HTML 实体与标签。 */
function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&ensp;|&nbsp;/g, ' ')
    .replace(/&#0183;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 用 Bing 搜索。
 *
 * @param {string} query 查询词
 * @param {number} maxResults 返回条数
 * @returns {Promise<string>} 可注入 prompt 的搜索结果，失败返回空串
 */
export async function searchWeb(query, maxResults = 3) {
  const q = String(query || '').trim();
  if (!q) return '';

  try {
    const res = await fetch(
      `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-hans&count=5`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    // Bing 的结果摘要主要在 <p> 标签里
    const snippets = [...html.matchAll(/<p[^>]*>([\s\S]{20,400}?)<\/p>/g)]
      .map((match) => stripHtml(match[1]))
      .filter((text) => text.length >= 20);

    const unique = [];
    for (const snippet of snippets) {
      if (unique.length >= maxResults) break;
      // 去重：避免同一句话出现多次
      if (unique.some((item) => item.includes(snippet.slice(0, 20)))) continue;
      unique.push(snippet);
    }

    if (unique.length === 0) return '';

    const text = unique.map((item, index) => `${index + 1}. ${item}`).join('\n');
    log.info(`搜索成功: "${q}" 命中 ${unique.length} 条`);
    return text;
  } catch (error) {
    log.warn(`搜索失败 (${q}):`, error.message);
    return '';
  }
}

/**
 * 按需联网：检测需求 → 查询 → 返回可注入的上下文。
 *
 * @param {string} text 用户消息
 * @returns {Promise<{type: string, context: string}|null>}
 */
export async function fetchWebContext(text) {
  const need = detectWebNeed(text);
  if (!need) return null;

  const startedAt = Date.now();

  if (need === 'weather') {
    const city = extractCity(text);
    const context = await fetchWeather(city);
    if (!context) return null;
    return {
      type: 'weather',
      context: `<web_result type="天气">\n${context}\n（这是实时天气数据，可以自然地回答，不用复述具体数字）\n</web_result>`,
    };
  }

  if (need === 'search') {
    // 去掉"搜一下""查查"这类指令词，只留查询内容
    const query = text
      .replace(/(帮我)?(搜一下|搜搜|查一下|查查|百度一下|谷歌一下)/g, '')
      .replace(/[？?。！!，,]/g, ' ')
      .trim();
    const context = await searchWeb(query || text);
    if (!context) return null;
    return {
      type: 'search',
      context: `<web_result type="搜索">\n${context}\n（这是刚搜到的网络信息，可能不准确，仅供参考）\n</web_result>`,
    };
  }

  return null;
}
