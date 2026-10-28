/**
 * 角色资料联网检索：从萌娘百科抓取角色设定。
 *
 * 移植自邻舍 agent-core/src/services/webSearch.js 的 searchCharacterInfo。
 *
 * 三步：
 * 1. 用 LLM 从用户输入提取规范角色名与作品名（顺便纠错别字）
 * 2. 先用页面标题直连解析（处理别名重定向），失败再走 opensearch
 * 3. 抓页面内容，提取信息框（发色瞳色身高等结构化字段）+ 正文
 *
 * 用 MediaWiki API 而不是爬 HTML：接口稳定、返回干净、不会被页面改版搞坏。
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { chatSync } from '../llm/client.js';

const log = createLogger('wiki');

const API_BASE = 'https://mzh.moegirl.org.cn/api.php';
const USER_AGENT = 'ZiliQQBot/1.0 (local personal bot)';

/** 单次抓取正文的最大字符数，超出截断。 */
const MAX_CONTENT_CHARS = 8000;

/** 请求超时。 */
const REQUEST_TIMEOUT_MS = 15000;

async function wikiFetch(params) {
  const url = `${API_BASE}?${new URLSearchParams(params).toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 用 LLM 提取规范角色名与作品名。
 *
 * 顺带纠正错别字：「芙宁哪」→「芙宁娜」。这一步能显著提升搜索命中率，
 * 因为萌娘百科的页面标题是精确匹配的。
 *
 * @param {string} rawQuery 用户输入
 * @returns {Promise<{name: string, work: string}>}
 */
export async function extractCharacterName(rawQuery) {
  const input = String(rawQuery || '').trim();
  if (input.length < 2) return { name: input, work: '' };

  try {
    const result = await chatSync(
      [
        {
          role: 'system',
          content: `你是动漫游戏角色搜索关键词提取器。从用户输入提取规范角色名和所属作品。

如果角色名有错别字，纠正为官方名称。
只输出一行，格式：角色名|作品名
没有作品名时，竖线后留空。

示例：
输入：绝区零里的千夏 → 千夏|绝区零
输入：芙宁娜（原神） → 芙宁娜|原神
输入：帮我看一下雷电将军的背景 → 雷电将军|
输入：芙宁哪 → 芙宁娜|原神
输入：一个金发双马尾的傲娇角色 → 金发双马尾傲娇角色|`,
        },
        { role: 'user', content: input },
      ],
      { temperature: 0, maxTokens: 60, label: '角色名提取' },
    );

    const trimmed = String(result || '').trim();
    const pipeIndex = trimmed.indexOf('|');
    if (pipeIndex !== -1) {
      const name = trimmed.slice(0, pipeIndex).trim();
      const work = trimmed.slice(pipeIndex + 1).trim();
      if (name && name.length <= 30) {
        log.debug(`关键词提取: "${input}" → 角色="${name}" 作品="${work}"`);
        return { name, work };
      }
    }
  } catch (error) {
    log.warn('关键词提取失败，直接用原始输入:', error.message);
  }
  return { name: input, work: '' };
}

/** 从 wikitext 里提取信息框字段（发色、瞳色、身高、萌点等）。 */
export function extractInfobox(wikitext) {
  const text = String(wikitext || '');
  const start = text.indexOf('{{人物信息');
  if (start === -1) {
    // 兼容其他常见模板名
    const alt = text.indexOf('{{Infobox');
    if (alt === -1) return '';
  }

  const begin = start !== -1 ? start : text.indexOf('{{Infobox');
  // 简单配平：数花括号层数找到模板结束位置
  let depth = 0;
  let end = begin;
  for (let i = begin; i < text.length - 1; i += 1) {
    if (text[i] === '{' && text[i + 1] === '{') { depth += 1; i += 1; continue; }
    if (text[i] === '}' && text[i + 1] === '}') {
      depth -= 1;
      i += 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }

  const block = text.slice(begin, end);
  const lines = [];
  for (const rawLine of block.split('\n')) {
    const match = /^\s*\|\s*([^=|]+?)\s*=\s*(.+?)\s*$/.exec(rawLine);
    if (!match) continue;
    const key = match[1].trim();
    let value = match[2].trim();
    // 跳过空值与纯模板调用
    if (!value || /^\{\{.*\}\}$/.test(value)) continue;
    // 清理 wiki 标记：[[链接|显示]] → 显示，去 HTML 标签
    value = value
      .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
      .replace(/<[^>]+>/g, '')
      .replace(/'''?/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!value || value.length > 120) continue;
    lines.push(`${key}：${value}`);
  }
  return lines.slice(0, 25).join('\n');
}

/** 清理正文 wikitext 成可读纯文本。 */
export function cleanWikitext(wikitext) {
  let text = String(wikitext || '');

  // 去掉模板、注释、文件、分类
  text = text.replace(/\{\{[\s\S]*?\}\}/g, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/\[\[(?:File|文件|Image|图像|分类|Category):[^\]]*\]\]/gi, '');

  // [[链接|显示]] → 显示；[[链接]] → 链接
  text = text.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2');
  // 外链 [http://x 显示] → 显示
  text = text.replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, '$1');

  // 标题标记、粗斜体
  text = text.replace(/^=+\s*(.*?)\s*=+$/gm, '## $1');
  text = text.replace(/'''?/g, '');
  // HTML 标签
  text = text.replace(/<[^>]+>/g, '');
  // 多余空行
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}

/**
 * 按标题直接取页面（跟随重定向）。
 *
 * @param {string} title 页面标题
 * @returns {Promise<{title: string, content: string, infobox: string}|null>}
 */
export async function fetchPageByTitle(title) {
  try {
    const data = await wikiFetch({
      action: 'query',
      prop: 'revisions',
      rvprop: 'content',
      rvslots: 'main',
      titles: String(title),
      redirects: '1',
      format: 'json',
      formatversion: '2',
    });

    const pages = data?.query?.pages;
    if (!Array.isArray(pages) || pages.length === 0) return null;

    const page = pages[0];
    if (page.missing) return null;

    const wikitext = page.revisions?.[0]?.slots?.main?.content ?? '';
    if (!wikitext) return null;

    const infobox = extractInfobox(wikitext);
    let content = cleanWikitext(wikitext);
    if (content.length > MAX_CONTENT_CHARS) {
      content = `${content.slice(0, MAX_CONTENT_CHARS)}…`;
    }

    log.info(`抓取成功: "${page.title}" 正文 ${content.length} 字，信息框 ${infobox.length} 字`);
    return { title: page.title, content, infobox };
  } catch (error) {
    log.debug(`按标题抓取失败 "${title}": ${error.message}`);
    return null;
  }
}

/**
 * 用 opensearch 搜候选标题。
 *
 * @param {string} query 搜索词
 * @param {number} limit 返回条数
 * @returns {Promise<string[]>}
 */
export async function searchTitles(query, limit = 5) {
  try {
    const data = await wikiFetch({
      action: 'opensearch',
      search: String(query),
      limit: String(limit),
      namespace: '0',
      format: 'json',
    });
    return Array.isArray(data?.[1]) ? data[1].map(String) : [];
  } catch (error) {
    log.debug(`搜索失败 "${query}": ${error.message}`);
    return [];
  }
}

/** 判断是否消歧义页。 */
function isDisambiguation(content) {
  return /消歧义页|可以指|下列[^。]*条目|列出[^。]*同名/.test(String(content || ''));
}

/**
 * 检索角色资料。
 *
 * 策略：先按标题直连（处理别名重定向），消歧义时尝试「角色(作品)」形式，
 * 再退到 opensearch 搜索。命中后如果内容里有作品名，优先取匹配的那条。
 *
 * @param {string} rawQuery 用户输入
 * @returns {Promise<{found: boolean, name: string, work: string, title?: string, content?: string, infobox?: string, reason?: string}>}
 */
export async function searchCharacterInfo(rawQuery) {
  const { name, work } = await extractCharacterName(rawQuery);

  if (!name) return { found: false, name: '', work, reason: '未提取到角色名' };

  log.info(`开始检索: 角色="${name}" 作品="${work || '(无)'}"`);

  // 1. 按标题直连
  let page = await fetchPageByTitle(name);

  // 2. 消歧义页：尝试「角色(作品)」
  if (page && isDisambiguation(page.content) && work) {
    log.info(`"${name}" 是消歧义页，尝试 "${name}(${work})"`);
    const specific = await fetchPageByTitle(`${name}(${work})`);
    if (specific) page = specific;
  }

  // 3. 直连失败 → 搜索
  if (!page) {
    const titles = await searchTitles(name, 5);
    log.info(`搜索 "${name}" 得到 ${titles.length} 个候选: ${titles.join(', ')}`);

    // 有作品名时优先取标题含作品名的候选
    const ordered = work
      ? [...titles].sort((a, b) => {
          const aHit = a.toLowerCase().includes(work.toLowerCase()) ? 1 : 0;
          const bHit = b.toLowerCase().includes(work.toLowerCase()) ? 1 : 0;
          return bHit - aHit;
        })
      : titles;

    for (const title of ordered) {
      const candidate = await fetchPageByTitle(title);
      if (!candidate) continue;
      if (isDisambiguation(candidate.content)) continue;
      // 有作品名时校验内容确实提到该作品
      if (work && !`${candidate.title} ${candidate.content}`.toLowerCase().includes(work.toLowerCase())) {
        continue;
      }
      page = candidate;
      break;
    }
  }

  if (!page) {
    return { found: false, name, work, reason: '萌娘百科未找到匹配页面' };
  }

  // 质量检查：信息框为空且正文极短，多半是无效页
  if (!page.infobox && page.content.length < 300) {
    return { found: false, name, work, reason: '页面内容过短，可能是消歧义或空页' };
  }

  return {
    found: true,
    name,
    work,
    title: page.title,
    content: page.content,
    infobox: page.infobox,
  };
}

/**
 * 把检索结果格式化成给 LLM 的参考资料文本。
 *
 * @param {object} result searchCharacterInfo 的返回
 * @returns {string}
 */
export function formatReference(result) {
  if (!result?.found) return '';
  const parts = [`【萌娘百科 · ${result.title}】`];
  if (result.infobox) {
    parts.push('基本信息框（高度精确的结构化数据，必须优先采用）：');
    parts.push(result.infobox);
  }
  if (result.content) {
    parts.push('');
    parts.push('正文描述（背景故事与性格描写的补充参考）：');
    parts.push(result.content);
  }
  return parts.join('\n');
}
