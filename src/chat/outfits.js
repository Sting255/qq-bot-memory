/**
 * 场景服装：让角色按场合换衣服。
 *
 * 四套场景，`work` 直接用人设里的「外貌特征」，其余三套存在 bot_outfits 表里。
 * 生图时按当前时间（周末算私服）选一套，聊天内容里的场景词可以覆盖时间判断。
 *
 * 和邻舍的差别：邻舍靠日程系统判断「此刻在干什么」，本项目没有日程，
 * 所以用时间代替——这是唯一不需要额外系统的触发源。
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { chatSync } from '../llm/client.js';
import { getDb } from '../memory/store.js';
import { getPersona, savePersona } from './persona.js';
import { buildOutfitTagMessages, sanitizeTags, validateClothingTags } from './clothing.js';

const log = createLogger('outfits');

/**
 * 场景定义。`work` 不存表，直接读人设外貌特征，避免两份数据打架。
 */
export const OUTFIT_SCENES = [
  { key: 'work', label: '日常装', desc: '日常状态穿的衣服，就是人设里的外貌特征', editable: false },
  { key: 'casual', label: '私服', desc: '周末、出门、逛街时穿的便装', editable: true },
  { key: 'home', label: '居家服', desc: '在家休息、做家务时穿的宽松衣物', editable: true },
  { key: 'sleep', label: '睡衣', desc: '睡觉时穿的睡衣，赤脚不穿鞋袜', editable: true },
];

const EDITABLE_SCENES = OUTFIT_SCENES.filter((s) => s.editable).map((s) => s.key);

/** 场景 key → 中文标签。 */
export const SCENE_LABEL = Object.fromEntries(OUTFIT_SCENES.map((s) => [s.key, s.label]));

/**
 * 从聊天内容里识别场景。
 *
 * 顺序有讲究：「在家睡觉」应该判成 sleep 而不是 home，
 * 所以 sleep 的关键词先匹配。
 */
const SCENE_KEYWORDS = [
  { scene: 'sleep', pattern: /(睡觉|睡了|睡着|睡衣|床上|被窝|睡前|躺床|枕|失眠|做梦)/ },
  { scene: 'casual', pattern: /(出门|逛街|在外面|街上|上街|约会|散步|旅行|旅游|出门玩)/ },
  { scene: 'home', pattern: /(在家|家里|居家|沙发|厨房|做饭|客厅|窝在)/ },
];

/**
 * 确保场景服装表存在。
 *
 * 一个场景可以有多套服装，生图时随机穿其中一套。
 * 老版本把 scene 当主键（一场景只能一套），检测到就重建表并迁移数据。
 */
let tableReady = false;
function ensureOutfitTable() {
  if (tableReady) return;
  const db = getDb();

  const NEW_SCHEMA = `
    CREATE TABLE bot_outfits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scene TEXT NOT NULL,
      name TEXT DEFAULT '',
      tags TEXT DEFAULT '',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bot_outfits'")
    .get();
  const columns = exists ? db.prepare('PRAGMA table_info(bot_outfits)').all() : [];
  const needsRebuild = Boolean(exists) && !columns.some((col) => col.name === 'id');

  if (!needsRebuild) {
    if (!exists) db.exec(NEW_SCHEMA);
    tableReady = true;
    return;
  }

  db.exec('ALTER TABLE bot_outfits RENAME TO bot_outfits_legacy');
  db.exec(NEW_SCHEMA);
  db.exec(`
    INSERT INTO bot_outfits (scene, name, tags, updated_at)
    SELECT scene, name, tags, updated_at FROM bot_outfits_legacy
  `);
  db.exec('DROP TABLE bot_outfits_legacy');
  log.info('场景服装表已升级为「一场景多套」结构');
  tableReady = true;
}

/**
 * 按时间判断该穿哪套。
 *
 * 周末优先级最高（但深夜仍是睡衣）——用户明确要求周末直接读日期。
 *
 * @param {Date} [now]
 * @returns {string} 场景 key
 */
export function pickSceneByTime(now = new Date()) {
  const hour = now.getHours();
  // 深夜到清晨一律睡衣，周末也不例外
  if (hour >= 23 || hour < 7) return 'sleep';

  const day = now.getDay();
  if (day === 0 || day === 6) return 'casual';

  if (hour < 19) return 'work';
  return 'home';
}

/**
 * 选场景：聊天内容优先，其次时间。
 *
 * @param {object} [params]
 * @param {string} [params.text] 消息原文
 * @param {Date} [params.now]
 * @returns {{scene: string, source: 'text'|'time'}}
 */
export function pickScene({ text = '', now = new Date() } = {}) {
  const raw = String(text || '');
  if (raw) {
    for (const rule of SCENE_KEYWORDS) {
      if (rule.pattern.test(raw)) return { scene: rule.scene, source: 'text' };
    }
  }
  return { scene: pickSceneByTime(now), source: 'time' };
}

/**
 * 列出所有场景及其服装。
 *
 * 按场景分组，每个场景下可以有任意多套。
 */
export function listOutfits() {
  ensureOutfitTable();
  const rows = getDb()
    .prepare('SELECT id, scene, name, tags, updated_at FROM bot_outfits ORDER BY id ASC')
    .all();

  return OUTFIT_SCENES.filter((item) => item.editable).map((item) => ({
    scene: item.key,
    label: item.label,
    desc: item.desc,
    items: rows
      .filter((row) => row.scene === item.key)
      .map((row) => ({
        id: row.id,
        name: row.name || '',
        tags: row.tags || '',
        updatedAt: row.updated_at || '',
      })),
  }));
}

/** 每个场景上次挑中哪一套，用来避免连续两次穿同一身。 */
const lastPickedId = new Map();

/**
 * 随机取某个场景的一套服装。
 *
 * 多套时避开上一次穿的那套——否则随机可能连着重复，看起来像没换过。
 *
 * @param {string} scene
 * @returns {{id: number, scene: string, name: string, tags: string}|null}
 */
export function getOutfit(scene) {
  if (!EDITABLE_SCENES.includes(scene)) return null;
  ensureOutfitTable();

  const rows = getDb()
    .prepare('SELECT id, scene, name, tags FROM bot_outfits WHERE scene = ?')
    .all(scene);
  if (rows.length === 0) return null;
  if (rows.length === 1) {
    lastPickedId.set(scene, rows[0].id);
    return rows[0];
  }

  const lastId = lastPickedId.get(scene);
  const candidates = rows.filter((row) => row.id !== lastId);
  const picked = candidates[Math.floor(Math.random() * candidates.length)] || rows[0];
  lastPickedId.set(scene, picked.id);
  return picked;
}

/**
 * 新增一套服装。
 *
 * 追加而不是覆盖——同一场景可以挂多套，生图时随机穿。
 */
export function saveOutfit({ scene, name = '', tags }) {
  if (!EDITABLE_SCENES.includes(scene)) {
    throw new Error(`不支持编辑场景：${scene}`);
  }
  ensureOutfitTable();
  const result = getDb()
    .prepare('INSERT INTO bot_outfits (scene, name, tags, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
    .run(scene, String(name || '').slice(0, 20), String(tags || ''));
  log.info(`服装已添加: ${SCENE_LABEL[scene] || scene} #${result.lastInsertRowid}`);
  return Number(result.lastInsertRowid);
}

/** 按 id 删除某一套服装。 */
export function deleteOutfit(id) {
  ensureOutfitTable();
  const target = Number(id);
  if (!Number.isFinite(target)) return false;
  const result = getDb().prepare('DELETE FROM bot_outfits WHERE id = ?').run(target);
  return result.changes > 0;
}

/** 清空某个场景的所有服装。 */
export function clearSceneOutfits(scene) {
  if (!EDITABLE_SCENES.includes(scene)) return 0;
  ensureOutfitTable();
  const result = getDb().prepare('DELETE FROM bot_outfits WHERE scene = ?').run(scene);
  return result.changes;
}

/** 角色外貌推断的提示词。只写身体特征与默认穿着，不写动作。 */
const APPEARANCE_SYSTEM = `你是角色外观设定助手。依据角色人设，写出用于 AI 生图的外观描述。

要求：
- 输出一行英文 danbooru 风格 tag，逗号分隔。不要换行、不要中文、不要 markdown、不要解释。
- 先写脸与发型（发型、发色、瞳色、体型），再写服装与饰品。
- 忠于人设里已写明的外观线索；人设没写外观时，按身份与性格设计一套辨识度高的。
- 只描述静态外观：不写表情、动作、姿势、场景、画质、镜头。
- 多词 tag 用空格或下划线分隔，绝对不要连写。写 long hair 或 long_hair，不要写 longhair。
- 控制在 15~25 个 tag。

只输出那一行 tag。`;

/**
 * 取角色固定外貌（人设里的「外貌特征」字段）。
 *
 * 人设没填时自动推断一次并写回人设字段，用户之后可以直接改。
 * 这一步决定了「每次画的是不是同一个人」：外貌为空时每张图都会换脸。
 *
 * @returns {Promise<string>} 外貌 tag 行，推断失败返回空串
 */
export async function ensureAppearance() {
  let persona;
  try {
    persona = getPersona();
  } catch (error) {
    log.debug('读取人设失败:', error.message);
    return '';
  }

  const configured = String(persona.appearance || '').trim();
  if (configured) return configured;

  const name = String(persona.name || '').trim() || '角色';

  // 兼容旧版：外观推断结果曾存在 app_meta 里，搬回人设字段
  try {
    const legacy = getDb()
      .prepare('SELECT value FROM app_meta WHERE key = ?')
      .get(`image_appearance:${name}`);
    if (legacy?.value) {
      savePersona({ appearance: legacy.value });
      log.info('已把旧版外观缓存迁移到人设字段');
      return legacy.value;
    }
  } catch (error) {
    log.debug('读取旧外观缓存失败:', error.message);
  }

  const card = [persona.identity, persona.personality, persona.speakingStyle, persona.extra]
    .filter((part) => String(part || '').trim())
    .join('\n')
    .slice(0, 3000);
  if (!card) return '';

  try {
    const raw = await chatSync(
      [
        { role: 'system', content: APPEARANCE_SYSTEM },
        { role: 'user', content: `角色名：${name}\n\n人设：\n${card}` },
      ],
      { maxTokens: 2000, label: '生图外观' },
    );
    const appearance = sanitizeTags(raw, 30);
    if (!appearance) return '';

    savePersona({ appearance });
    log.info(`已从人设推断外貌并写入人设字段: ${appearance.slice(0, 100)}`);
    return appearance;
  } catch (error) {
    log.warn('推断角色外貌失败:', error.message);
    return '';
  }
}

/**
 * 解析当前该用的外观 tag。
 *
 * 顺序：该场景有自己的服装就用它；没有就回落到人设外貌特征。
 * 这样场景服装没配也能正常出图，不会因为缺数据而画不出来。
 *
 * @param {object} [params]
 * @param {string} [params.text] 消息原文，用于识别场景
 * @param {string} [params.scene] 直接指定场景，优先于文本识别
 * @param {Date} [params.now]
 * @returns {Promise<{tags: string, scene: string, source: string, label: string}>}
 */
export async function resolveOutfitTags({ text = '', scene = '', now = new Date() } = {}) {
  const appearance = await ensureAppearance();

  let finalScene = scene;
  let source = 'manual';
  if (!finalScene) {
    const picked = pickScene({ text, now });
    finalScene = picked.scene;
    source = picked.source;
  }

  if (finalScene !== 'work') {
    const outfit = getOutfit(finalScene);
    if (outfit?.tags) {
      return {
        tags: outfit.tags,
        scene: finalScene,
        source,
        label: SCENE_LABEL[finalScene] || finalScene,
        name: outfit.name || '',
      };
    }
    // 没配这套就回落到日常装，不因为缺数据而画不出来
    source = `${source}:fallback`;
  }

  return { tags: appearance, scene: 'work', source, label: SCENE_LABEL.work };
}

/**
 * 用 LLM 把选中的服装词条展开成完整 tag 行。
 *
 * @param {object} params
 * @param {string} params.scene casual | home | sleep
 * @param {string[]} params.tags 选中的服装 tag
 * @param {string} [params.brief] 额外要求
 * @returns {Promise<{tags: string, name: string}>}
 */
export async function generateOutfitTags({ scene, tags, brief = '' }) {
  if (!EDITABLE_SCENES.includes(scene)) {
    throw new Error(`不支持生成的场景：${scene}`);
  }

  const { entries, errors } = validateClothingTags(tags, scene);
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }

  const appearance = await ensureAppearance();
  if (!appearance) {
    throw new Error('人设里还没有外貌特征，请先在「人设」页填写或生成');
  }

  const messages = buildOutfitTagMessages({ appearance, entries, scene, brief });
  const raw = await chatSync(messages, { maxTokens: 2000, label: '生成服装' });
  const tagLine = sanitizeTags(raw, 45);
  if (!tagLine) {
    throw new Error('模型没有返回可用的服装 tag，请重试');
  }

  // 中文名取第一个词条的名称，作为这套服装的称呼
  const name = entries[0]?.label?.slice(0, 12) || '';
  log.info(`服装 tag 已生成: ${scene} ${tagLine.slice(0, 120)}`);
  return { tags: tagLine, name };
}
