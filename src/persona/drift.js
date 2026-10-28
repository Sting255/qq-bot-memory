/**
 * 注意力漂移：控制回复「跑题」的程度，让说话不像 AI。
 *
 * 移植自 MaiBot v1.3.14 的 src/maisaka/attention_drift.py。
 *
 * 为什么需要这个：AI 的典型特征是「永远紧扣主题、逻辑完整」。
 * 真人聊天会突然被某个细节勾走、说句无关的联想、再绕回正题。
 * 这四档就是控制「被勾走的程度」。
 *
 * 纯提示词片段，零运行时开销。
 */

/** 漂移档位。 */
export const DRIFT_LEVELS = {
  SUBTLE: 'subtle',
  ACTIVE: 'active',
  SCATTERED: 'scattered',
  WILD: 'wild',
};

/** 回钩策略：跑题之后怎么拉回来。 */
export const ANCHOR_POLICIES = {
  STRICT: 'strict',
  BALANCED: 'balanced',
  LOOSE: 'loose',
};

/** 短反应风格：开头用多短的话接住话题。 */
export const REACTION_STYLES = {
  RESERVED: 'reserved',
  NATURAL: 'natural',
  LIVELY: 'lively',
};

const DRIFT_RULES = {
  [DRIFT_LEVELS.SUBTLE]:
    '漂移档位：轻微漂移。只在最近消息里出现非常自然的触发点时，轻轻联想一句；大多数时候继续当前话题。',
  [DRIFT_LEVELS.ACTIVE]:
    '漂移档位：活跃联想。可以主动抓住新鲜、好笑、反差强或熟悉的细节接话，但回复仍要清楚、短促、能被最近消息解释。',
  [DRIFT_LEVELS.SCATTERED]:
    '漂移档位：明显发散。你可以明显地被支线、关键词、熟人语气或反差点勾走，先接住那个点再回到正题；回复里允许出现一次可理解的突然拐弯。',
  [DRIFT_LEVELS.WILD]:
    '漂移档位：强烈跳跃。你可以先被最有趣的细节劫走一下，出现短促插话、突然联想或半路拐弯；但每轮最多一次明显跳跃，不能无视明确提问，最后要让人看得出你在接哪条消息。',
};

const ANCHOR_RULES = {
  [ANCHOR_POLICIES.STRICT]:
    '回钩策略：严格回钩。联想或短反应之后，要立刻回到当前正在聊的主题或被回复对象。',
  [ANCHOR_POLICIES.BALANCED]:
    '回钩策略：自然回钩。可以短暂沿着支线说一句，但通常要让结尾或主要意思回到当前聊天。',
  [ANCHOR_POLICIES.LOOSE]:
    '回钩策略：宽松关联。可以保留更自由的相关联想，但不能凭空换话题，也不能无视明确提问。',
};

const REACTION_RULES = {
  [REACTION_STYLES.RESERVED]:
    '短反应风格：少量短反应。只有特别适合接话时，才用一句很短的反应开头。',
  [REACTION_STYLES.NATURAL]:
    '短反应风格：自然短反应。可以偶尔先用短句、吐槽或语气词接住话题，再继续正常回复。',
  [REACTION_STYLES.LIVELY]:
    '短反应风格：活泼短反应。更容易先用短促反应开头，但不要把回复拆得太碎，也不要每次都这样。',
};

/**
 * 构造注意力漂移提示词块。
 *
 * @param {object} options
 * @param {string} options.driftLevel 漂移档位
 * @param {string} options.anchorPolicy 回钩策略
 * @param {string} options.reactionStyle 短反应风格
 * @returns {string} 可注入 prompt 的文本，配置非法时返回空串
 */
export function buildAttentionDriftBlock({
  driftLevel = DRIFT_LEVELS.SUBTLE,
  anchorPolicy = ANCHOR_POLICIES.BALANCED,
  reactionStyle = REACTION_STYLES.NATURAL,
} = {}) {
  const drift = DRIFT_RULES[driftLevel];
  const anchor = ANCHOR_RULES[anchorPolicy];
  const reaction = REACTION_RULES[reactionStyle];

  // 任一档位非法则不注入，避免拼出半截提示词
  if (!drift || !anchor || !reaction) return '';

  return ['<chat_style>', drift, anchor, reaction, '</chat_style>'].join('\n');
}
