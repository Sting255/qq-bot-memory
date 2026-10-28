/**
 * 生图：用户明确要求时才画。
 *
 * 三件事——识别「画一张」这类请求、把自然语言翻成 danbooru tag、调云端 NAI 出图。
 *
 * 为什么不做主动判断配图：每轮都让 LLM 判断该不该画，要多一次 2 秒的调用，
 * 而且容易在群里乱刷图。被动触发的预期最明确，成本也只在真要图时才付出。
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { chatSync } from '../llm/client.js';
import { selectRecentMessages, getDb } from '../memory/store.js';
import { fetchWebContext } from './web-tools.js';
import { sanitizeTags } from './clothing.js';
import { resolveOutfitTags } from './outfits.js';

const log = createLogger('image');

/**
 * 这些词里带「画」或「图」，但不是生图请求。
 *
 * 两个坑：
 * - 不要加「图片」：会把「发图片」这种正经请求一起挡掉
 * - 「画风」要用后行断言：只排除独立的「这个画风」，
 *   不能把「插·画风格」一起误杀——那是在说想看插画。
 */
const EXCLUDE_WORDS = /(动画|漫画|(?<!插)画风|画质|画面|笔画|规划|计划|企划|谋划|比划|刻画|示意图|流程图|构图|配图|头像框|截图|截个图|录屏|画得|画家|画师|画法|画笔|画板|画画|不会画|不喜欢画|不擅长画)/;

/** 图像类的宾语。 */
const IMAGE_NOUN = '(图|画|照片|插画|立绘|头像|壁纸|表情包|人物像|形象)';

/** 数量词 + 量词，两者都可能省略。 */
const QUANT = '(?:一|两|几)?\\s*(?:个|张|幅|只|条|位)?\\s*';

/**
 * 剥掉消息开头的 @ 提及标记。
 *
 * 群聊里 @ 机器人时，归一化会在正文前留下 "@你 " 这样的前缀。
 * 带着它，「画一下」就不在句首了，正则全部失配，只能靠 LLM 兜底——
 * 而兜底是异步的，文字回复往往已经先说出「画不了」。
 */
function stripMentions(text) {
  return String(text || '')
    .replace(/^(\s*@[^\s@]+\s*)+/, '')
    .trim();
}

/**
 * 判断是否在要求生图。
 *
 * 覆盖的句式：
 * - 画/生成 + 量词 + 图 → 「画一张图」「生成张插画」
 * - 来/给 + 量词 + 图 → 「来张图」「给我一张图」
 * - 句首就是画/绘 → 「画一只猫」「画她在吃饭」
 * - 帮忙类 → 「帮我画个」「帮忙生成一张」
 * - 能力询问 → 「你能画吗」「可以生成吗」
 * - 结果类 → 「画出来」「生成出来看看」
 * - 发图类 → 「发张图」「上图」「发个照片」
 *
 * @param {string} text 消息原文
 * @returns {{matched: boolean, scene?: string}}
 */
export function detectImageRequest(text) {
  const raw = stripMentions(text);
  if (!raw || raw.length > 200) return { matched: false };
  if (EXCLUDE_WORDS.test(raw)) return { matched: false };

  if (new RegExp(`(画|绘|生成|整|搞|做|创建|制作|设计)\\s*${QUANT}${IMAGE_NOUN}`).test(raw)) {
    return { matched: true, scene: extractScene(raw) };
  }
  if (new RegExp(`(来|给|要|出)\\s*(?:我)?\\s*(?:一|两|几)?\\s*(?:个|张|幅)?\\s*${IMAGE_NOUN}`).test(raw)) {
    return { matched: true, scene: extractScene(raw) };
  }
  // 句首直接是绘制动词
  if (/^(帮我|给我|帮忙|能不能|可以|麻烦|请)?\s*(画|绘|生成)/.test(raw)) {
    return { matched: true, scene: extractScene(raw) };
  }
  // 帮忙类：不一定带宾语，例如「帮我画个」「帮忙生成一张」
  if (/(帮我|帮忙|给我)\s*(画|绘|生成|做|整)/.test(raw)) {
    return { matched: true, scene: extractScene(raw) };
  }
  // 能力询问：「你能画吗」「可以生成一张吗」
  if (/(能|可以|会|能不能|可否)\s*(画|生成|画图|作图)/.test(raw)) {
    return { matched: true, scene: extractScene(raw) };
  }
  // 结果类：「画出来」「生成出来看看」
  if (/(画|生成)\s*(出来|一个出来)/.test(raw)) {
    return { matched: true, scene: extractScene(raw) };
  }
  // 发图类：「发张图」「发个照片」「上图」「发来看看」
  if (new RegExp(`(发|上|放)\\s*(?:一|两|几)?\\s*(?:个|张|幅)?\\s*${IMAGE_NOUN}`).test(raw)) {
    return { matched: true, scene: extractScene(raw) };
  }
  if (/(发图|上图|发出来看看)/.test(raw)) {
    return { matched: true, scene: extractScene(raw) };
  }
  return { matched: false };
}

/**
 * 弱信号词。
 *
 * 正则没命中、但句子里明显在聊「画/图/照片」时，交给 LLM 判断一下，
 * 覆盖「你能画出来当时的场景吗」这种没有明确量词的说法。
 *
 * 这是兜底层，不是每轮都跑——只有出现这些词才多一次判断，
 * 闲聊时零开销。
 */
const WEAK_SIGNAL = /(画|图|照片|插画|立绘|形象|样子|看看|瞧瞧|展示|生成)/;

/**
 * 是否值得让 LLM 再过一遍。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasImageSignal(text) {
  const raw = stripMentions(text);
  if (!raw || raw.length > 200) return false;
  if (EXCLUDE_WORDS.test(raw)) return false;
  return WEAK_SIGNAL.test(raw);
}

/**
 * 让 LLM 判断这条消息到底是不是在要图。
 *
 * 借鉴邻舍的 JUDGE_PROMPT，但只保留「用户在要图」这一条判断，
 * 不含「角色自己想发图」——本项目是被动触发，不主动配图。
 *
 * @param {object} params
 * @param {string} params.text 用户消息
 * @returns {Promise<boolean>}
 */
export async function judgeImageIntent({ text }) {
  const raw = String(text || '').trim();
  if (!raw) return false;

  try {
    const answer = await chatSync(
      [
        {
          role: 'system',
          content:
            '你是一个判断助手。阅读用户说的话，判断他是不是想让对方画一张图或发一张图片给他看。\n' +
            '只回答一个字：是 或 否。不要解释。\n' +
            '注意区分：聊到绘画、图片、照片本身不算；只有明确希望「生成/画出来/发给他看」才算。',
        },
        { role: 'user', content: raw },
      ],
      { maxTokens: 1000, temperature: 0, label: '生图意图判断' },
    );
    const verdict = String(answer || '').trim();
    // 模型可能回「是。」「是的」「YES」，都按是处理
    return /^(是|对|yes|y)/i.test(verdict);
  } catch (error) {
    log.debug('生图意图判断失败:', error.message);
    return false;
  }
}

/**
 * 纯请求词构成的字符串，不含任何画面内容。
 *
 * 「发张图」「你能画吗」这类被识别为生图请求后，剩下的全是请求虚词，
 * 不是画面描述。传下去会让模型困惑，所以直接当空场景处理，
 * 交给上下文取景。
 */
const NOISE_ONLY = /^[帮给我你他她它能可以会想要看瞧展示发生出做整搞创建制作设计绘图画照片片插立像张幅个只一两几下来上放忙么吗吧呢的了啊呀呗\s]+$/;

/**
 * 从请求里剥出画面描述。
 *
 * 「画一张她在吃东西」→「她在吃东西」
 * 「来张图」→「」（空场景，交给 LLM 按上下文编一个）
 */
export function extractScene(raw) {
  let scene = stripMentions(raw);

  // 剥掉客套前缀
  scene = scene.replace(/^(求你|帮我|给我|帮忙|能不能|可以|麻烦|请|稍微)\s*/g, '');
  // 剥掉绘制动词
  scene = scene.replace(/^(画|绘|生成|整|搞|做|创建|制作|设计|来|出|给|要|发|上|放)\s*/, '');

  // 剥掉残留的量词与通用名词。可能叠着来（「一张图」剥两轮才干净），
  // 所以循环到不再变化为止。「下」也算量词——「画一下」里它是补语。
  const STRIP = /^(?:一|两|三|几)?(?:个|张|幅|只|条|位|名|辆|次|些|下)?(?:图|画|照片|插画|立绘|头像|壁纸|表情包|形象)?\s*/;
  for (let i = 0; i < 3; i += 1) {
    const next = scene.replace(STRIP, '');
    if (next === scene) break;
    scene = next;
  }

  scene = scene
    .replace(/^[，,、。.：:的了吧啊呀呗\s]+/, '')
    .trim();

  // 剩下的如果全是请求虚词，说明压根没描述画面
  if (!scene || NOISE_ONLY.test(scene)) return '';
  return scene;
}

/**
 * 把场景翻成 danbooru tag。
 *
 * 用 LLM 而不是关键词映射：中文场景转英文 tag 需要理解语义，
 * 「她在窗边发呆」要落成 `sitting, by window, dazed, looking outside`，
 * 关键词表做不到。这一次调用的成本换来提示词质量，值得。
 */
const TAG_SYSTEM = `你是 NovelAI 生图提示词编写者。先判断要画谁，再写 tag。

【第一步：判断主体】
注意人称：说「你」「你自己」「人家」指的是**机器人这个角色**；
说「我」「画我」「画一个我」指的是**正在说话的用户本人**，属于 other。

- subject: self   —— 画机器人自己。只有明确说「你」或者模糊说「画一张」没指明谁时才算。
- subject: other  —— 画其他任何东西：用户本人、其他角色、动物、风景、物品、建筑、抽象画面。

【第二步：输出 tag】
只写这几类：动作、表情、环境场景、构图、光线氛围。

当 subject 是 self：
- 绝对不要写服装、鞋袜、发色、瞳色、五官、体型、人数。这些由系统另外提供，
  写了会和外貌打架，画面出现两套衣服。

当 subject 是 other：
- 完整描述画面上的一切：主体外观、服装、环境。
- 画用户本人时，务必从【最近的对话】里找他自己说过的外貌特征
  （比如「我是蓝白毛水母头假小子」），照那个画，不要凭空编一个陌生人。
- 对方点名了某部作品的角色时，直接写该角色的 danbooru 角色 tag，例如
  raiden_shogun_(genshin_impact)、nahida_(genshin_impact)、hatsune_miku、frieren，
  再补发型瞳色服装细节。
- 画动物、风景、物品时照常描述，不要硬塞一个人进去。

【通用规则】
- 不要角色设定图那种构图：不写 character sheet、reference sheet、concept art、
  white background、simple background、full body standing facing viewer。
- 不写任何色情、裸露、血腥内容。
- 8~16 个 tag，多词用空格或下划线分隔，不要连写。
- 用 danbooru 常见写法。

【输出格式】严格两行，不要解释：
subject: self
1girl, sitting, smile, indoors, sunlight, upper body`;

/**
 * 把当前时段说成人话，让画面光线符合真实时间。
 *
 * 深夜画出来的图不该是正午的阳光——用户问「你现在的样子」时，
 * 这个差异很明显。
 */
function describeTime(now = new Date()) {
  const hour = now.getHours();
  let period = '深夜';
  if (hour >= 5 && hour < 8) period = '清晨';
  else if (hour >= 8 && hour < 11) period = '上午';
  else if (hour >= 11 && hour < 14) period = '中午';
  else if (hour >= 14 && hour < 18) period = '下午';
  else if (hour >= 18 && hour < 23) period = '晚上';

  return `现在是${period}（${hour}点）`;
}

/** 剥掉联网结果里的 XML 标签，只留给人看的文本。 */
function stripWebTags(context) {
  return String(context || '')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 收集这次生图要遵守的现实条件。
 *
 * 两部分：当前时段（本地算，零成本），以及场景涉及实时信息时的联网数据
 * （天气、新闻这类，取了整理成一句干净的话再交给提示词）。
 *
 * 这样「画一张现在的样子」才会是深夜的暗光，而不是凭空的正午。
 *
 * @param {object} params
 * @param {string} params.scene 场景描述
 * @param {Date} [params.now]
 * @returns {Promise<string>} 现实条件文本，可能只有时间
 */
export async function collectSceneFacts({ scene, now = new Date() }) {
  const parts = [describeTime(now)];

  if (config.webTools.enabled) {
    try {
      const web = await fetchWebContext(scene);
      if (web?.context) {
        const clean = stripWebTags(web.context);
        if (clean) {
          parts.push(clean);
          log.info(`生图前取到实时信息(${web.type}): ${clean.slice(0, 80)}`);
        }
      }
    } catch (error) {
      log.debug('生图联网查询失败:', error.message);
    }
  }

  return parts.filter(Boolean).join('\n');
}

/**
 * 解析场景判断结果。
 *
 * 模型输出两行：第一行 subject，第二行 tag。
 * 解析不到 subject 时按 self 处理——保持「画角色自己」这个原有行为，
 * 不至于因为模型漏写就画出个没人的空场景。
 *
 * @param {string} raw
 * @returns {{subject: 'self'|'other', tags: string}}
 */
export function parseSceneResult(raw) {
  const text = String(raw || '');
  const match = /subject\s*[:：]\s*(self|other)/i.exec(text);
  const subject = match?.[1]?.toLowerCase() === 'other' ? 'other' : 'self';
  // 去掉 subject 那一行，剩下的才是 tag
  const tagPart = text.replace(/^[\s\S]*?subject\s*[:：]\s*(?:self|other)[^\n]*/i, '');
  return { subject, tags: sanitizeTags(tagPart) };
}

/**
 * 让 LLM 生成场景 tag，并判断这次画的是「自己」还是「别的」。
 *
 * @param {object} params
 * @param {string} params.scene 场景描述，可能为空
 * @param {string} params.conversationId 会话 ID，用于取上下文
 * @param {string} [params.facts] 现实条件（时间、实时信息）
 * @returns {Promise<{subject: 'self'|'other', tags: string}>}
 */
/**
 * 从长期记忆里找当前说话人描述过的外貌。
 *
 * 群里刷得快，「我是蓝白毛水母头假小子」这种自我描述几分钟就滑出近期窗口了，
 * 但它会被记忆整理提取成一条长期记忆。画「我」的时候要来这里找，
 * 否则只能凭空编一个陌生人。
 *
 * @param {string} conversationId
 * @param {string} speakerName
 * @returns {string} 该用户的外貌线索，没有则空串
 */
export function loadSpeakerLook(conversationId, speakerName) {
  if (!conversationId || !speakerName) return '';
  try {
    const rows = getDb()
      .prepare(`SELECT judgment FROM memory_fragments
                WHERE conversation_id = ? AND subject = ? AND status = 'active'
                  AND (judgment LIKE '%外貌%' OR judgment LIKE '%形象%' OR judgment LIKE '%发型%'
                       OR judgment LIKE '%头发%' OR judgment LIKE '%发色%' OR judgment LIKE '%瞳%'
                       OR judgment LIKE '%眼睛%' OR judgment LIKE '%身高%' OR judgment LIKE '%体型%'
                       OR judgment LIKE '%胡子%' OR judgment LIKE '%辫%' OR judgment LIKE '%毛%')
                ORDER BY id DESC LIMIT 4`)
      .all(conversationId, speakerName);
    return rows
      .map((row) => String(row.judgment || '').trim())
      .filter(Boolean)
      .join('\n');
  } catch (error) {
    log.debug('读取说话人外貌记忆失败:', error.message);
    return '';
  }
}

export async function buildSceneTags({ scene, conversationId, facts = '', speakerName = '' }) {
  const messages = [{ role: 'system', content: TAG_SYSTEM }];

  if (facts) {
    messages.push({
      role: 'system',
      content: `【现实条件】\n${facts}\n` +
        '画面要符合这些条件：深夜就用夜景和暗光，下雨就画雨和湿地面，晴天才有阳光。' +
        '不要把条件直接写成文字，转成对应的画面元素。',
    });
  }

  // 带上最近的对话：用户常在里面顺口描述自己的样子（「我是蓝白毛水母头假小子」），
  // 要画「我」的时候这是唯一的依据。群聊里多人发言，「我」指谁必须标出来。
  let context = '';
  try {
    // 群聊刷得快，窗口开大一些，否则那句自我描述很快就滑出去了
    const history = selectRecentMessages(conversationId, 30);
    context = history
      .filter((row) => row.role !== 'assistant')
      .map((row) => {
        const content = String(row.content || '').slice(0, 90);
        if (!content) return '';
        const isCurrent = speakerName && row.speaker_name === speakerName;
        return isCurrent ? `【本人】${content}` : content;
      })
      .filter(Boolean)
      .join('\n');
  } catch (error) {
    log.debug('取上下文失败:', error.message);
  }

  if (context) {
    messages.push({
      role: 'system',
      content: `【最近的对话】\n${context}\n\n` +
        '标了【本人】的是正在跟你说话的人。他说「我」「画我」时指的是他自己。',
    });
  }

  // 这人以前说过自己长什么样吗？说过就照那个画，别编陌生人
  const look = loadSpeakerLook(conversationId, speakerName);
  if (look) {
    messages.push({
      role: 'system',
      content: `【这个人的外貌印象】\n${look}\n\n` +
        '画「他/她/我」的时候要按这些特征来，不要用别人的外貌，也不要凭空编。',
    });
  }

  if (scene) {
    messages.push({ role: 'user', content: `画面：${scene}` });
  } else {
    messages.push({
      role: 'user',
      content: context
        ? '用户只说「画一张」，没说画什么。结合上面的对话挑一个适合画的场景。'
        : '用户只说「画一张」，没说画什么。画一个安静坐着的日常场景。',
    });
  }

  // maxTokens 不能设小：这个模型先写 reasoning 再写正文，配额小了正文会被截空
  const raw = await chatSync(messages, { maxTokens: 1200, label: '生图提示词' });
  return parseSceneResult(raw);
}

/**
 * 默认负面提示词。
 *
 * 通用项参考了邻舍那套动画模型的负面词，但去掉了 score_1/2/3 这类模型专属评分 tag
 * 和 shadows/highlights 系列——后者会压制光影层次，NAI 反而需要这些。
 */
const DEFAULT_NEGATIVE =
  'nsfw, nude, cleavage, large breasts, revealing clothes, exposed skin, ' +
  'bad anatomy, bad proportions, deformed anatomy, deformed face, deformed eyes, ' +
  'bad hands, extra fingers, fewer fingers, multiple fingers, ' +
  'text, watermark, signature, artist name, logo, username, censor, mosaic, ' +
  'lowres, worst quality, low quality, jpeg artifacts, blurry';

/**
 * 实测不消耗 Gems 的模型白名单。
 *
 * 4 系列全部实测 0 Gems（走每 10 分钟 20 张的免费额度），5 系列每张 2 Gems。
 * 3 系列需要管理员单独映射，本服务不可直接用。
 */
const FREE_MODELS = new Set([
  'nai-diffusion-4-5-full',
  'nai-diffusion-4-5-curated',
  'nai-diffusion-4-full',
  'nai-diffusion-4-curated',
]);

/** 免费模式下强制使用的模型。 */
const FREE_FALLBACK_MODEL = 'nai-diffusion-4-5-full';

/**
 * 决定这次用哪个模型。
 *
 * 开启「只用免费额度」时，任何不在白名单里的模型都会被降级到免费模型，
 * 而不是直接报错——配置写错了也不该让用户彻底没有图。
 *
 * @returns {string} 实际要用的模型名
 */
export function resolveModel() {
  const configured = String(config.image.model || '').trim();
  if (!config.image.freeOnly) return configured;
  if (FREE_MODELS.has(configured)) return configured;

  log.warn(
    `模型 ${configured} 不在免费白名单内，已降级为 ${FREE_FALLBACK_MODEL}。` +
    `如需使用该模型，请关闭「只用免费额度」。`,
  );
  return FREE_FALLBACK_MODEL;
}

/**
 * 调云端 NAI 生成一张图。
 *
 * @param {object} params
 * @param {string} params.prompt 正向提示词
 * @param {string} [params.negativePrompt] 临时覆盖负向提示词，不传则用配置或默认值
 * @returns {Promise<Buffer>} PNG 数据
 */
export async function generateImage({ prompt, negativePrompt = '' }) {
  const imageConfig = config.image;

  // 本地 ComfyUI 后端：不需要 apiKey，走「提交工作流 + 轮询」那套协议
  if (imageConfig.provider === 'comfyui') {
    if (!imageConfig.comfyui?.workflow) {
      throw new Error('image.provider=comfyui 但未配置 image.comfyui.workflow');
    }
    const { generateWithComfyUI } = await import('./comfyui.js');
    return generateWithComfyUI({
      prompt,
      negativePrompt: negativePrompt || imageConfig.comfyui.negativePrompt || imageConfig.negativePrompt || '',
      cfg: imageConfig.comfyui,
      steps: imageConfig.steps,
      cfgScale: imageConfig.scale,
      size: imageConfig.size,
    });
  }

  if (!imageConfig.apiKey) {
    throw new Error('未配置生图密钥');
  }

  const model = resolveModel();
  const body = {
    model,
    prompt,
    size: imageConfig.size,
    n: 1,
    response_format: 'b64_json',
    nai: {
      steps: imageConfig.steps,
      scale: imageConfig.scale,
      negative_prompt: negativePrompt || imageConfig.negativePrompt || DEFAULT_NEGATIVE,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), imageConfig.timeoutMs);
  const startedAt = Date.now();

  let response;
  try {
    response = await fetch(`${imageConfig.baseUrl.replace(/\/+$/, '')}/v1/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${imageConfig.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') {
      throw new Error(`生图超时（${imageConfig.timeoutMs}ms）`);
    }
    throw new Error(`生图请求失败: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`生图接口 ${response.status}: ${detail.slice(0, 200)}`);
  }

  const payload = await response.json();
  const b64 = payload?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error(`生图返回无图片数据: ${JSON.stringify(payload).slice(0, 200)}`);
  }

  const buffer = Buffer.from(b64, 'base64');
  log.info(
    `生图完成 耗时=${Date.now() - startedAt}ms 尺寸=${imageConfig.size} ` +
    `模型=${model} 字节=${buffer.length}`,
  );
  return buffer;
}

/** 正在生图的会话，避免同一会话并发占资源。 */
const running = new Set();

/**
 * 免费额度滑动窗口。
 *
 * 服务端的免费标准渲染是「每 10 分钟 20 张」，超出的部分要消耗图包次数。
 * 这里自己记一份，把请求挡在超额之前——否则撞上服务端限额时，
 * 用户只会看到生图失败，却不知道为什么。
 */
const FREE_WINDOW_MS = 10 * 60 * 1000;
const recentRenders = [];

/**
 * 占用一次免费额度。
 *
 * @returns {{ok: boolean, retryAfterSec?: number, used?: number, limit?: number}}
 */
export function consumeFreeQuota() {
  // 只有免费额度机制才需要限流；关掉开关走 Gems 计费时不受这条约束
  if (!config.image.freeOnly) return { ok: true };

  const limit = Math.max(1, Number(config.image.freeQuotaPer10Min) || 20);
  const now = Date.now();

  while (recentRenders.length > 0 && now - recentRenders[0] > FREE_WINDOW_MS) {
    recentRenders.shift();
  }

  if (recentRenders.length >= limit) {
    const retryAfterSec = Math.ceil((FREE_WINDOW_MS - (now - recentRenders[0])) / 1000);
    return { ok: false, retryAfterSec, used: recentRenders.length, limit };
  }

  recentRenders.push(now);
  return { ok: true, used: recentRenders.length, limit };
}

/** 当前窗口内已用掉多少免费额度。 */
export function getFreeQuotaUsage() {
  const now = Date.now();
  while (recentRenders.length > 0 && now - recentRenders[0] > FREE_WINDOW_MS) {
    recentRenders.shift();
  }
  return {
    used: recentRenders.length,
    limit: Math.max(1, Number(config.image.freeQuotaPer10Min) || 20),
    windowMin: 10,
  };
}

/** 某会话是否正在生图。 */
export function isGenerating(conversationId) {
  return running.has(conversationId);
}

/**
 * 完整流程：场景 → tag → 按场景取装扮 → 出图。
 *
 * @param {object} params
 * @param {string} params.conversationId 会话 ID
 * @param {string} params.scene 用户描述的画面
 * @param {string} [params.requestText] 原始消息，用于识别该穿哪套衣服
 * @param {string} [params.outfitScene] 直接指定服装场景，优先于文本识别
 * @param {string} [params.speakerName] 当前说话人的昵称，用于判断「我」指谁
 * @returns {Promise<{buffer: Buffer|null, message: string}>}
 */
export async function createImage({
  conversationId,
  scene,
  requestText = '',
  outfitScene = '',
  speakerName = '',
}) {
  if (running.has(conversationId)) {
    log.debug(`会话 ${conversationId} 已有生图任务，跳过`);
    return { buffer: null, message: '' };
  }

  // 速查表登记过的角色用核对好的外观；没登记的交回模型用角色 tag 画。
  // NAI 对老角色的把握是可靠的，不能因为表里没有就一律拒绝。
  // 额度先占：没额度就别再花一次 LLM 调用去提炼提示词了
  const quota = consumeFreeQuota();
  if (!quota.ok) {
    log.warn(`免费额度已用尽 ${quota.used}/${quota.limit}，还需 ${quota.retryAfterSec}s`);
    const minutes = Math.max(1, Math.ceil(quota.retryAfterSec / 60));
    return { buffer: null, message: `画得有点多了，等${minutes}分钟` };
  }

  running.add(conversationId);

  try {
    // 现实条件（当前时段 + 按需联网）与装扮互不依赖，并行取
    const [facts, outfit] = await Promise.all([
      collectSceneFacts({ scene }),
      resolveOutfitTags({ text: requestText, scene: outfitScene }),
    ]);

    const sceneResult = await buildSceneTags({ scene, conversationId, facts, speakerName });
    const useSelf = sceneResult.subject === 'self';
    if (!sceneResult.tags) {
      log.warn('场景提示词为空，使用兜底');
    }

    const quality = 'masterpiece, best quality, highly detailed';
    // 画别的东西时不套角色 tag 与服装——否则画什么都变成昔涟
    const prompt = [
      useSelf ? outfit.tags : '',
      sceneResult.tags || '1girl, solo, sitting, indoors, soft light',
      quality,
    ]
      .filter(Boolean)
      .join(', ');

    log.info(
      `生图 主体=${useSelf ? '自己' : '其他'} ` +
      (useSelf ? `装扮=${outfit.label}${outfit.name ? `「${outfit.name}」` : ''} ` : '') +
      `提示词: ${prompt.slice(0, 180)}`,
    );
    const buffer = await generateImage({ prompt });
    return { buffer, message: '' };
  } catch (error) {
    log.error(`生图失败: ${error.message}`);
    return { buffer: null, message: '画不出来，等会儿再试' };
  } finally {
    running.delete(conversationId);
  }
}