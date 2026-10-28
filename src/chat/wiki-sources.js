/**
 * 多源角色资料采集。
 *
 * 三个来源，按可靠性排序：
 * 1. 哔哩哔哩 wiki（bwiki）—— 国内游戏 wiki 最全，有专门的「资料」和「语音」页。
 *    语音页尤其宝贵：里面是真实台词，生成说话风格有据可依。
 * 2. 萌娘百科 —— ACG 通用，信息框结构化程度高，但有 Cloudflare 风控。
 * 3. Bing 搜索 —— 兜底，质量最差但覆盖面广。
 *
 * 站点映射用固定表而不是猜：bwiki 的子站代码不规律
 * （原神 ys、星穹铁道 sr、鸣潮 wutheringwaves），猜不出来。
 */
import { createLogger } from '../logger.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';

const log = createLogger('wiki-sources');

/**
 * 采集结果缓存。
 *
 * bwiki 有反爬限流（HTTP 567），被限后可能几十分钟不可用。
 * 同一个角色不需要反复抓，缓存 7 天，命中直接返回。
 */
const CACHE_DIR = resolve(config.dataDir, 'wiki-cache');
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

function cacheKey(name, work) {
  return `${name}__${work || 'unknown'}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

function readCache(name, work) {
  try {
    const file = resolve(CACHE_DIR, `${cacheKey(name, work)}.json`);
    if (!existsSync(file)) return null;
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    if (!payload?.savedAt || Date.now() - payload.savedAt > CACHE_TTL_MS) return null;
    log.info(`命中缓存: ${name}`);
    return payload.data;
  } catch {
    return null;
  }
}

function writeCache(name, work, data) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const file = resolve(CACHE_DIR, `${cacheKey(name, work)}.json`);
    writeFileSync(file, JSON.stringify({ savedAt: Date.now(), data }, null, 0), 'utf8');
  } catch (error) {
    log.debug('写缓存失败:', error.message);
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 12000;

/** 单源正文最大字符数，避免把整个语音表塞进 prompt。 */
const MAX_SOURCE_CHARS = 12000;

/**
 * 请求间隔（毫秒）。
 *
 * bwiki 有反爬限流，短时间大量请求会返回 HTTP 567。
 * 并行探测 10 个站点必然触发，所以串行 + 间隔。
 */
const REQUEST_GAP_MS = 250;

/** 限流后重试的等待时间。 */
const RATE_LIMIT_RETRY_MS = 1500;

/** 未指定作品时最多探测几个站点（按热门度排序取前几个）。 */
const MAX_PROBE_SITES = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 作品名 → bwiki 子站代码。
 * 键统一小写匹配，值是该游戏在 wiki.biligame.com 下的路径段。
 */
const BWIKI_SITES = [
  { code: 'ys', aliases: ['原神', 'genshin', 'genshinimpact'] },
  { code: 'sr', aliases: ['崩坏星穹铁道', '星穹铁道', '星铁', '崩铁', 'starrail', 'honkaistarrail'] },
  { code: 'zzz', aliases: ['绝区零', 'zenless', 'zenlesszonezero'] },
  { code: 'wutheringwaves', aliases: ['鸣潮', 'wutheringwaves', 'wuwa'] },
  { code: 'bh3', aliases: ['崩坏3', '崩坏三', 'honkaiimpact3'] },
  { code: 'arknights', aliases: ['明日方舟', 'arknights'] },
  { code: 'fgo', aliases: ['fgo', 'fategrandorder', '命运冠位指定'] },
  { code: 'bluearchive', aliases: ['蔚蓝档案', '碧蓝档案', 'bluearchive'] },
  { code: 'azurlane', aliases: ['碧蓝航线', 'azurlane'] },
  { code: 'pgr', aliases: ['战双帕弥什', 'punishinggrayraven'] },
];

/** 角色资料优先抓这些子页面（bwiki 惯例）。 */
const SUBPAGE_PRIORITY = ['资料', '语音', '攻略'];

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return fetch(url, {
    ...options,
    headers: { 'User-Agent': UA, ...(options.headers || {}) },
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

/** 按作品名找 bwiki 子站代码。 */
export function resolveBwikiSite(work) {
  const key = String(work || '').toLowerCase().replace(/\s|:|：|·/g, '');
  if (!key) return null;
  for (const site of BWIKI_SITES) {
    if (site.code === key) return site.code;
    if (site.aliases.some((alias) => key.includes(alias) || alias.includes(key))) {
      return site.code;
    }
  }
  return null;
}

/** 清理 bwiki wikitext 成可读文本。 */
export function cleanWikitext(wikitext) {
  let text = String(wikitext || '');

  // 模板调用：语音表这类模板里有价值的是参数值，先抽出参数
  text = text.replace(/\{\{([^{}]*?)\}\}/g, (match, inner) => {
    // 只保留 key=value 里的 value
    const parts = inner.split('|').slice(1);
    const values = [];
    for (const part of parts) {
      const eq = part.indexOf('=');
      const value = eq === -1 ? part : part.slice(eq + 1);
      const cleaned = value.trim();
      if (cleaned && !/^[\w-]+$/.test(cleaned) && cleaned.length > 1) values.push(cleaned);
    }
    return values.join(' ');
  });

  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/\[\[(?:File|文件|Image|图像|分类|Category):[^\]]*\]\]/gi, '');
  text = text.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2');
  text = text.replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, '$1');
  text = text.replace(/^=+\s*(.*?)\s*=+$/gm, '## $1');
  text = text.replace(/'''?/g, '');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  if (text.length > MAX_SOURCE_CHARS) text = `${text.slice(0, MAX_SOURCE_CHARS)}…`;
  return text;
}

/**
 * bwiki 搜索页面标题。
 *
 * 遇到 567（限流）会等一会儿重试一次。重试仍失败就放弃，
 * 让上层走 Bing 兜底，不为一个源卡住整个流程。
 *
 * @param {string} site bwiki 子站代码
 * @param {string} keyword 搜索词
 * @param {number} limit
 * @returns {Promise<string[]>}
 */
export async function searchBwiki(site, keyword, limit = 8) {
  const url = `https://wiki.biligame.com/${site}/api.php?action=query&list=search&srsearch=${encodeURIComponent(keyword)}&srlimit=${limit}&format=json`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetchWithTimeout(url);
      if (res.status === 567 || res.status === 429) {
        log.debug(`bwiki(${site}) 限流 ${res.status}，${RATE_LIMIT_RETRY_MS}ms 后重试`);
        await sleep(RATE_LIMIT_RETRY_MS);
        continue;
      }
      if (!res.ok) return [];
      const data = await res.json();
      return (data?.query?.search || []).map((item) => String(item.title));
    } catch (error) {
      log.debug(`bwiki 搜索失败 (${site}): ${error.message}`);
      return [];
    }
  }
  return [];
}

/**
 * 抓 bwiki 指定页面的 wikitext。
 *
 * 遇到限流同样重试一次；连续抓多个页面时调用方需自己控制间隔。
 *
 * @param {string} site 子站代码
 * @param {string} page 页面标题
 * @returns {Promise<{title: string, text: string}|null>}
 */
export async function fetchBwikiPage(site, page) {
  const url = `https://wiki.biligame.com/${site}/api.php?action=parse&page=${encodeURIComponent(page)}&prop=wikitext&format=json`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetchWithTimeout(url);
      if (res.status === 567 || res.status === 429) {
        log.debug(`bwiki 抓取限流 ${res.status} (${page})，重试`);
        await sleep(RATE_LIMIT_RETRY_MS);
        continue;
      }
      if (!res.ok) return null;
      const data = await res.json();
      const wikitext = data?.parse?.wikitext?.['*'] ?? '';
      if (!wikitext) return null;
      const text = cleanWikitext(wikitext);
      if (!text) return null;
      log.info(`bwiki 抓取成功: ${page} (${text.length} 字)`);
      return { title: data.parse.title || page, text };
    } catch (error) {
      log.debug(`bwiki 抓取失败 ${page}: ${error.message}`);
      return null;
    }
  }
  return null;
}

/**
 * 从 bwiki 采集角色资料。
 *
 * 策略：搜到标题后，优先抓「角色名/资料」和「角色名/语音」——
 * 前者是官方设定，后者是真实台词，合起来足够生成准确人设。
 *
 * 没给作品名时并行探测所有已知站点，哪个有结果用哪个。
 * 这样「昔涟」也能命中，不必用户手动加作品名。
 *
 * @param {string} name 角色名
 * @param {string} work 作品名
 * @returns {Promise<{source: string, parts: {label: string, text: string}[]}|null>}
 */
export async function collectFromBwiki(name, work) {
  // 缓存优先
  const cached = readCache(name, work);
  if (cached) return cached;

  const site = resolveBwikiSite(work);

  // 有明确作品 → 只查那一个站点
  // 没有作品 → 串行探测热门站点（并行会触发限流）
  const probes = [];
  if (site) {
    probes.push({ code: site, titles: await searchBwiki(site, name, 5) });
  } else {
    const candidates = BWIKI_SITES.slice(0, MAX_PROBE_SITES).map((item) => item.code);
    log.info(`未指定作品，串行探测 ${candidates.length} 个 wiki 站点`);
    for (const code of candidates) {
      const titles = await searchBwiki(code, name, 5);
      probes.push({ code, titles });
      // 已有精确命中就停，省下后续请求
      if (titles.some((title) => title === name)) break;
      await sleep(REQUEST_GAP_MS);
    }
  }

  // 优先选标题与角色名完全匹配的站点
  const ranked = probes
    .filter((probe) => probe.titles.length > 0)
    .sort((a, b) => {
      const aExact = a.titles.some((t) => t === name) ? 1 : 0;
      const bExact = b.titles.some((t) => t === name) ? 1 : 0;
      return bExact - aExact;
    });

  if (ranked.length === 0) {
    log.debug(`bwiki 未搜到「${name}」`);
    return null;
  }

  const chosen = ranked[0];
  const { code, titles } = chosen;
  log.info(`bwiki 命中站点: ${code}（${titles.slice(0, 3).join(', ')}）`);

  // 找出主条目：优先完全等于角色名的，其次以角色名开头的
  const exact = titles.find((t) => t === name);
  const base = exact || titles.find((t) => t.startsWith(name)) || titles[0];

  const parts = [];

  // 主条目
  const main = await fetchBwikiPage(code, base);
  if (main && main.text.length > 200) {
    parts.push({ label: `${base}（主条目）`, text: main.text });
  }
  // 子页面：资料优先，其次语音
  const subpages = titles.filter((t) => SUBPAGE_PRIORITY.some((sub) => t.includes(`/${sub}`)));
  const ordered = subpages.sort((a, b) => {
    const rank = (title) => {
      const index = SUBPAGE_PRIORITY.findIndex((sub) => title.includes(`/${sub}`));
      return index === -1 ? 99 : index;
    };
    return rank(a) - rank(b);
  });

  for (const page of ordered.slice(0, 2)) {
    await sleep(REQUEST_GAP_MS);
    const fetched = await fetchBwikiPage(code, page);
    if (fetched && fetched.text.length > 100) {
      parts.push({ label: `${page}`, text: fetched.text });
    }
  }

  if (parts.length === 0) return null;

  // 语音页截断：只取前 6000 字，够看说话风格了
  const capped = parts.map((part) => ({
    label: part.label,
    text: part.label.includes('语音') && part.text.length > 6000
      ? `${part.text.slice(0, 6000)}…`
      : part.text,
  }));

  log.info(`bwiki 采集完成: ${capped.length} 个页面`);
  const result = { source: `哔哩哔哩wiki(${code})`, parts: capped };
  writeCache(name, work, result);
  return result;
}

/**
 * 采集所有可用的角色资料。
 *
 * 哔哩哔哩 wiki 命中就够用了，不再调萌娘百科——
 * 萌娘百科有 Cloudflare 风控，等待可能拖十几秒，没必要为了锦上添花让用户干等。
 *
 * @param {object} params
 * @param {string} params.name 角色名
 * @param {string} params.work 作品名
 * @param {object} [params.moegirlFallback] 可选：bwiki 未命中时的补充采集函数
 * @returns {Promise<{source: string, parts: {label: string, text: string}[], sources: string[]}>}
 */
export async function collectMaterials({ name, work, moegirlFallback = null }) {
  const collected = [];
  const sourceNames = [];

  // 1. 哔哩哔哩 wiki（主力源，有资料页和语音页）
  const bwiki = await collectFromBwiki(name, work).catch((error) => {
    log.warn('bwiki 采集异常:', error.message);
    return null;
  });
  if (bwiki) {
    collected.push(...bwiki.parts);
    sourceNames.push(bwiki.source);
  }

  // 2. 只有 bwiki 没命中时才用萌娘百科补充
  if (collected.length === 0 && moegirlFallback) {
    try {
      const moe = await moegirlFallback(name, work);
      if (moe?.text && moe.text.length > 200) {
        collected.push({ label: `萌娘百科 · ${moe.title || name}`, text: moe.text });
        sourceNames.push('萌娘百科');
      }
    } catch (error) {
      log.debug('萌娘百科采集失败:', error.message);
    }
  }

  return {
    source: sourceNames.join(' + ') || '无',
    parts: collected,
    sources: sourceNames,
  };
}

/** 把采集结果拼成给 LLM 的参考资料文本。 */
export function formatMaterials(parts) {
  if (!parts || parts.length === 0) return '';
  return parts
    .map((part) => `\n### ${part.label}\n${part.text}`)
    .join('\n');
}
