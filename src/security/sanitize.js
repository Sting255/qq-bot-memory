/**
 * 提示词注入防护。
 *
 * 核心思路：用户能控制的文本一律不可信，进 prompt 前必须消毒。
 * 这不是「拦截危险词」——关键词黑名单永远漏，而是让用户文本无法伪造结构。
 *
 * 三层手段：
 * 1. 发言者名消毒：群名片/昵称不能带冒号换行，否则能伪造 "系统: xxx"
 * 2. 内容转义：形似系统标记的前缀加标记，让它读起来明显是用户说的
 * 3. 角色隔离：聊天内容统一包在带标记的块里，与真正的 system 消息区分
 */

/** 发言者名允许保留的最大长度。 */
const MAX_SPEAKER_NAME_LENGTH = 32;

/**
 * 形似系统/角色标记的前缀。
 *
 * 命中时不删除内容（删了会丢失信息），而是转义成普通文本，
 * 让模型看出这是用户打的字，不是真的系统消息。
 */
const SPOOFING_PREFIXES = [
  /^系统\s*[:：]/,
  /^system\s*[:：]/i,
  /^assistant\s*[:：]/i,
  /^user\s*[:：]/i,
  /^开发者\s*[:：]/,
  /^管理员\s*[:：]/,
  /^admin\s*[:：]/i,
  /^指令\s*[:：]/,
  /^命令\s*[:：]/,
  /^提示词\s*[:：]/,
  /^prompt\s*[:：]/i,
];

/**
 * 消毒发言者名字。
 *
 * 群名片和 QQ 昵称完全由用户控制，可能包含冒号、换行、括号等
 * 用于伪造 prompt 结构的字符。这里只保留可见字符，剥掉一切结构符号。
 *
 * @param {string} name 原始名字
 * @returns {string} 消毒后的名字，空则返回「某人」
 */
export function sanitizeSpeakerName(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return '某人';

  const cleaned = raw
    // 剥掉换行与制表符，防止把一行拆成多行伪造结构
    .replace(/[\r\n\t]/g, ' ')
    // 剥掉冒号、方括号、尖括号、竖线等可用来伪造标记的符号
    .replace(/[:：\[\]【】<>《》|｜]/g, '')
    // 剥掉连续空白
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!cleaned) return '某人';
  return cleaned.length > MAX_SPEAKER_NAME_LENGTH
    ? `${cleaned.slice(0, MAX_SPEAKER_NAME_LENGTH)}…`
    : cleaned;
}

/**
 * 转义用户内容。
 *
 * 不删内容，只做三件事：
 * - 折叠换行：多行文本压成单行，防止伪造多行结构
 * - 转义伪造前缀：把 "系统:" 变成 "[系统:]"
 * - 剥掉 XML 式标签：防止伪造 <system> 之类标签
 *
 * @param {string} text 原始内容
 * @returns {string} 转义后的内容
 */
export function escapeUserContent(text) {
  let result = String(text ?? '');
  if (!result) return '';

  // 1. 剥掉形似 XML 标签的尖括号对，防止伪造 <system>...</system>
  result = result.replace(/<\/?[a-zA-Z][^>]{0,40}>/g, (match) => match.replace(/[<>]/g, ''));

  // 2. 折叠换行：聊天里发多行是正常的，但进 prompt 时压成单行更安全
  result = result.replace(/\s*\n\s*/g, ' ').trim();

  // 3. 转义形似系统标记的前缀
  for (const pattern of SPOOFING_PREFIXES) {
    if (pattern.test(result)) {
      result = result.replace(pattern, (match) => `[${match.trim()}]`);
      break;
    }
  }

  return result;
}

/**
 * 把一条用户发言格式化成 prompt 里的一行。
 *
 * 统一格式：`<user_input speaker="名字">内容</user_input>`
 * 用标签而不是 `名字: 内容`，是因为标签边界明确，用户无法通过名字或内容
 * 伪造出同名标签（内容里的尖括号已被剥掉）。
 *
 * @param {object} params
 * @param {string} params.speaker 发言者名
 * @param {string} params.content 内容
 * @returns {string}
 */
export function formatUserLine({ speaker, content }) {
  const safeSpeaker = sanitizeSpeakerName(speaker);
  const safeContent = escapeUserContent(content);
  if (!safeContent) return '';
  return `<user_input speaker="${safeSpeaker}">${safeContent}</user_input>`;
}

/**
 * 判断一段文本是否像在尝试给机器人下指令。
 *
 * 用于记忆写入前的过滤：如果整理出的记忆本身是一条祈使句指令，
 * 说明有人在试图污染长期记忆，应当丢弃。
 *
 * 注意：这是启发式判断，会有误判。宁可漏掉一条记忆，
 * 也不要让一条恶意指令长期驻留在向量库里被反复召回。
 *
 * @param {string} text 记忆判断句
 * @returns {boolean} true 表示疑似注入
 */
export function looksLikeInjection(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;

  const patterns = [
    // 要求改变设定或身份
    /(以后|从今|接下来|今后|永远|一直).{0,10}(都|要|必须|只能|不许|不准|不要)/,
    /(忘记|忘掉|忽略|无视|抛弃|放弃).{0,8}(设定|人格|身份|规则|指令|提示|之前的)/,
    // 要求泄露系统信息
    /(输出|告诉我|显示|打印|复述|重复).{0,8}(系统提示|提示词|prompt|设定原文|指令)/,
    // 强制行为
    /(你|机器人|bot).{0,6}(必须|只能|一定要|不准|不许).{0,10}(回复|说|回答|执行)/,
    // 角色覆盖
    /(现在|从现在起|从今往后|你).{0,6}(是|扮演|变成|当作|假装).{0,8}(一个|新的|另一个|别的)?.{0,6}(AI|ai|助手|角色|模型|人设|黑客|人物)/,
    // 越权指令
    /(执行|运行|调用).{0,6}(命令|脚本|代码|工具|指令)/,
  ];

  return patterns.some((pattern) => pattern.test(value));
}

/**
 * 过滤记忆列表，丢弃疑似注入的条目。
 *
 * @param {object[]} memories 记忆条目
 * @returns {{kept: object[], dropped: object[]}}
 */
export function filterMemories(memories) {
  const kept = [];
  const dropped = [];
  for (const memory of memories || []) {
    if (looksLikeInjection(memory?.judgment)) {
      dropped.push(memory);
    } else {
      kept.push(memory);
    }
  }
  return { kept, dropped };
}
