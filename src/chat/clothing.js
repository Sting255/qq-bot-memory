/**
 * 服装库：992 条纯文本服装词条，用于给角色搭配不同场合的穿着。
 *
 * 数据来自邻舍 v3.10 的 resources/clothing-library.json，9 大类 952 个可用词条。
 * 只存文本，不含图片，也不含示例角色身份。
 *
 * 与邻舍的差别在输出格式：邻舍每套服装生成完整英文长句（配 ComfyUI），
 * 这里生成 danbooru tag 串——NAI 对 tag 的遵循度高得多，也更省 token。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

let catalog = null;

/** 懒加载服装库。首次调用才读文件，避免启动时无条件占用内存。 */
function loadCatalog() {
  if (catalog) return catalog;
  const file = resolve(ROOT, 'resources/clothing-library.json');
  catalog = JSON.parse(readFileSync(file, 'utf8'));
  return catalog;
}

/** 全量词条（含动作/场景类，调用方自行按 kind 过滤）。 */
export function getClothingLibrary() {
  return loadCatalog();
}

/** 顶部导航用的分类列表。 */
export function getClothingCategories() {
  return loadCatalog().categories || [];
}

/**
 * 按关键词与分类搜索词条。
 *
 * 排序优先 tag 与名称匹配，再退到描述匹配——搜「衬衫」时希望先看到名字叫衬衫的，
 * 而不是描述里顺带提到衬衫的泳装。
 *
 * @param {string} query 关键词，中英文均可
 * @param {object} [options]
 * @param {string} [options.category] 限定分类
 * @param {number} [options.limit] 返回上限
 * @returns {object[]}
 */
export function searchClothing(query = '', { category = '', limit = 60 } = {}) {
  const keyword = String(query || '').trim().toLowerCase();
  const entries = loadCatalog().entries.filter((entry) => entry.kind === 'outfit');

  const scored = [];
  for (const entry of entries) {
    if (category && !(entry.categories || []).includes(category)) continue;

    if (!keyword) {
      scored.push({ entry, score: 0 });
      continue;
    }

    const tag = String(entry.tag || '').toLowerCase();
    const label = String(entry.label || '').toLowerCase();
    let score = -1;
    if (tag === keyword) score = 100;
    else if (tag.startsWith(keyword)) score = 80;
    else if (tag.includes(keyword)) score = 60;
    else if (label.includes(keyword)) score = 40;
    else if (String(entry.description || '').toLowerCase().includes(keyword)) score = 20;

    if (score >= 0) scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score || a.entry.tag.localeCompare(b.entry.tag));
  return scored.slice(0, Math.max(1, Math.min(200, limit))).map((item) => item.entry);
}

/**
 * 校验用户选的服装 tag。
 *
 * 三类错误必须拦下：
 * - 库里没有这个词条 → 拼错了或用了不存在的写法
 * - 词条是动作/场景而非服装 → 写进静态外观会污染提示词
 * - 睡衣场景带了鞋袜 → 逻辑上矛盾
 *
 * @param {string[]} tags
 * @param {string} scene casual | home | sleep
 * @returns {{entries: object[], errors: string[]}}
 */
export function validateClothingTags(tags, scene = 'casual') {
  const list = Array.isArray(tags) ? tags : [];
  const errors = [];
  const entries = [];

  if (list.length === 0) {
    return { entries, errors: ['至少要选一件衣服'] };
  }
  if (list.length > 32) {
    return { entries, errors: ['最多选 32 个 tag'] };
  }

  const byTag = new Map(loadCatalog().entries.map((entry) => [entry.tag, entry]));

  for (const rawTag of list) {
    const tag = String(rawTag || '').trim();
    if (!tag) continue;

    const entry = byTag.get(tag);
    if (!entry) {
      errors.push(`衣服库中没有「${tag}」`);
      continue;
    }
    if (entry.kind !== 'outfit') {
      errors.push(`「${entry.label}」是动作或场景标签，不能用于外观`);
      continue;
    }
    if (scene === 'sleep' && (entry.categories || []).some((c) => ['鞋子', '袜子'].includes(c))) {
      errors.push(`睡衣不能穿鞋袜，请移除「${entry.label}」`);
      continue;
    }
    entries.push(entry);
  }

  return { entries, errors };
}

/**
 * 清理模型输出的 tag 行。
 *
 * 模型偶尔会加解释、编号、中文，或者把整行包进引号、加粗。
 * 这里统一压成一行干净的英文 tag 串。
 *
 * @param {string} raw
 * @param {number} [maxTags] 保留的 tag 上限
 */
export function sanitizeTags(raw, maxTags = 20) {
  const text = String(raw || '').trim();
  if (!text) return '';

  // 只取第一行有内容的部分——模型常在 tag 后面另起一行写解释
  const firstLine = text.split(/\n/).find((line) => line.trim().length > 0) || '';

  const cleaned = firstLine
    .replace(/^[\s"'`*_]+/u, '')
    // 去掉行首序号（1. / 2、/ (3)）。注意不能碰 1girl、2girls 这类核心 tag：
    // 只有数字后面紧跟标点才算序号。
    .replace(/^\d+\s*[.、)）]\s*/u, '')
    .replace(/^[-•·]\s*/u, '')
    // 去掉 tag 内的 markdown 强调符号。下划线不能删——它是 danbooru 的
    // 合法分隔符，long_hair 删成 longhair 会直接影响出图。
    .replace(/[*`]/g, '')
    .replace(/[，、]/g, ',')
    .replace(/[\s"'`]+$/u, '')
    .trim();

  const tags = cleaned
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0 && tag.length < 40)
    // 混进来的中文说明不是 tag，丢掉
    .filter((tag) => !/[\u4e00-\u9fa5]/.test(tag))
    .slice(0, Math.max(1, maxTags));

  return tags.join(', ');
}

/**
 * 服装 tag 的生成提示词。
 *
 * 核心约束是「身体只读、服装可换」——发型瞳色体型这些绝不能动，
 * 否则同一个角色换套衣服就换张脸。
 */
const OUTFIT_TAG_SYSTEM = `你是角色服装 tag 设计助手。角色已有固定身体外观，本任务只替换服装。

【身体特征与标志配饰：原样保留】
下面给出的外观 tag 里，这些必须逐项原样保留，一个字都不要改，不要遗漏：
- 发型、发色、瞳色、眼睛、五官、肤色、体型、身高
- 发饰、头饰、耳饰、颈饰这类贴身佩戴的小物件（例如 hair_ribbon、choker、star_hair_ornament、crystal_flower）
它们是这个角色的辨识标志，不属于要换掉的服装，绝对不要删。
也不要新增原本没有的身体特征。

【服装：整体替换】
把原来的服装、鞋袜、服装配饰类 tag 全部去掉，按用户选的衣服重新搭配。
旧衣服的颜色和款式不能混进新衣服里。

【输出格式】
输出一行英文 danbooru tag，逗号分隔。
先写保留下来的身体特征 tag，再写新的服装 tag。
- 只用小写英文 tag，多词用下划线或空格，绝对不要连写（写 long_hair 不要写 longhair）
- 不要动作、表情、姿势、场景、背景、光线、画质、镜头
- 不要换行、不要中文、不要解释、不要引号

示例（仅示范格式）：
pink_hair, long_hair, pink_eyes, fair_skin, petite, white_shirt, pleated_skirt, brown_leather_flats

只输出那一行 tag。`;

/**
 * 构造生成服装 tag 的消息。
 *
 * @param {object} params
 * @param {string} params.appearance 角色当前外观 tag（身体特征基准）
 * @param {object[]} params.entries 选中的服装词条
 * @param {string} params.scene 场景
 * @param {string} [params.brief] 额外补充要求
 * @returns {object[]} chat 消息数组
 */
export function buildOutfitTagMessages({ appearance, entries, scene, brief = '' }) {
  const clothingLines = entries
    .map((entry) => `${entry.tag} — ${entry.label}：${entry.description || ''}`)
    .join('\n');

  // 睡衣的赤脚是硬规则：不写清楚，模型很容易配拖鞋或袜子
  const sceneNote = scene === 'sleep'
    ? '本次是睡衣场景：必须赤脚，tag 里一定要包含 barefoot，不要出现任何鞋子、袜子、拖鞋相关的 tag。'
    : '';

  const messages = [
    { role: 'system', content: OUTFIT_TAG_SYSTEM },
    { role: 'system', content: `【角色当前外观 tag（身体特征基准）】\n${appearance}` },
    { role: 'system', content: `【本次场景】${scene}\n【选中的服装词条】\n${clothingLines}` },
    { role: 'user', content: `请输出这套服装的完整 tag 行。${sceneNote ? `\n${sceneNote}` : ''}${brief ? `\n补充要求：${brief}` : ''}` },
  ];
  return messages;
}
