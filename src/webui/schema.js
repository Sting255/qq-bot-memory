/**
 * 配置 schema：一份定义同时驱动后端校验、前端渲染与 YAML 持久化。
 *
 * 为什么不写三份：面板、校验、配置文件三处的字段名和取值范围
 * 一旦各写一份，新增配置时必然漏改其中一个，出现「面板能改但重启丢失」
 * 或「改了不生效」这类问题。集中定义是唯一能保证一致的做法。
 *
 * 字段说明：
 * - path    配置路径，与 config.js 里的对象结构一一对应
 * - label   面板显示名
 * - type    number | boolean | string | enum | array | secret
 * - hint    面板下方的说明文字
 * - secret  值为 true 时不回显真实值，只显示是否已设置
 */

export const CONFIG_SCHEMA = [
  {
    group: 'trigger',
    title: '触发控制',
    desc: '决定机器人什么时候开口。频率越低越安静。',
    items: [
      {
        path: 'trigger.frequency',
        label: '回复频率',
        type: 'number',
        min: 0.001,
        max: 1,
        step: 0.01,
        hint: '0.05 ≈ 每小时只说 5% 的话。不能为 0，否则 @ 也不会回。',
      },
      {
        path: 'trigger.replyOnAt',
        label: '被 @ 必回',
        type: 'boolean',
        hint: '绕过频率门控直接回复。',
      },
      {
        path: 'trigger.replyOnMention',
        label: '提及名字必回',
        type: 'boolean',
        hint: 'QQ 群名片易误判，建议关闭。',
      },
      {
        path: 'trigger.nicknames',
        label: '机器人昵称',
        type: 'array',
        hint: '提及匹配用的名字列表，逗号分隔。开了「提及必回」才生效。',
      },
      {
        path: 'trigger.debounceSec',
        label: '消息防抖（秒）',
        type: 'number',
        min: 0,
        max: 30,
        step: 0.5,
        hint: '等这段时间内的消息收齐再判定，避免逐条响应。',
      },
      {
        path: 'trigger.idleBackoffStartCount',
        label: '退避起始次数',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        hint: '连续空转几次后开始指数退避。',
      },
      {
        path: 'trigger.idleBackoffBaseSec',
        label: '退避基数（秒）',
        type: 'number',
        min: 0,
        max: 600,
        step: 5,
        hint: '退避时长 = 基数 × 2^(空转次数-起始次数)。',
      },
      {
        path: 'trigger.idleBackoffCapSec',
        label: '退避上限（秒）',
        type: 'number',
        min: 0,
        max: 7200,
        step: 10,
        hint: '退避最长不超过这个值。',
      },
    ],
  },
  {
    group: 'persona',
    title: '拟人化',
    desc: '让回复像真人，而不是客服。',
    items: [
      {
        path: 'persona.typo.enabled',
        label: '错别字',
        type: 'boolean',
        hint: '同音字替换，候选按字频加权。',
      },
      {
        path: 'persona.typo.errorRate',
        label: '单字错字概率',
        type: 'number',
        min: 0,
        max: 0.5,
        step: 0.005,
        hint: '每个字被替换的概率，0.01 约等于百分之一。',
      },
      {
        path: 'persona.typo.toneErrorRate',
        label: '声调错误概率',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        hint: '允许错成不同声调的同音字。',
      },
      {
        path: 'persona.typo.wordReplaceRate',
        label: '整词替换概率',
        type: 'number',
        min: 0,
        max: 0.2,
        step: 0.002,
        hint: '整个词被同音词替换的概率。',
      },
      {
        path: 'persona.typo.correctionProbability',
        label: '发纠正消息概率',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        hint: '真人打错字后会补一条纠正。',
      },
      {
        path: 'persona.splitter.enabled',
        label: '回复分段',
        type: 'boolean',
        hint: '长回复拆成多条发送，像真人一句一句说。',
      },
      {
        path: 'persona.splitter.maxLength',
        label: '单条最大长度',
        type: 'number',
        min: 20,
        max: 2000,
        step: 10,
        hint: '超过这个长度就拆条。',
      },
      {
        path: 'persona.splitter.maxSplitNum',
        label: '最多拆几条',
        type: 'number',
        min: 1,
        max: 10,
        step: 1,
        hint: '拆太多会很烦，一般 3 条以内。',
      },
      {
        path: 'persona.typing.enabled',
        label: '打字延迟',
        type: 'boolean',
        hint: '发送前等待一段时间，秒回反而不像人。',
      },
      {
        path: 'persona.typing.speed',
        label: '打字速度档位',
        type: 'number',
        min: 0,
        max: 5,
        step: 0.5,
        hint: '0=最快无延迟，1=默认，2=更慢。',
      },
      {
        path: 'persona.quote.frequency',
        label: '引用频率',
        type: 'enum',
        options: [
          { value: 'never', label: '从不' },
          { value: 'occasionally', label: '偶尔' },
          { value: 'often', label: '经常' },
        ],
        hint: '按概率引用触发回复的那条消息。真人会指着某句话回。',
      },
      {
        path: 'persona.drift.level',
        label: '注意力漂移',
        type: 'enum',
        options: [
          { value: 'subtle', label: '轻微' },
          { value: 'active', label: '活跃' },
          { value: 'scattered', label: '明显发散' },
          { value: 'wild', label: '强烈跳跃' },
        ],
        hint: '控制回复跑题的程度。AI 永远紧扣主题，真人会被细节勾走。',
      },
      {
        path: 'persona.drift.anchorPolicy',
        label: '跑题后回钩',
        type: 'enum',
        options: [
          { value: 'strict', label: '严格回钩' },
          { value: 'balanced', label: '自然回钩' },
          { value: 'loose', label: '宽松关联' },
        ],
        hint: '跑题之后怎么拉回正题。',
      },
      {
        path: 'persona.drift.reactionStyle',
        label: '短反应风格',
        type: 'enum',
        options: [
          { value: 'reserved', label: '少量' },
          { value: 'natural', label: '自然' },
          { value: 'lively', label: '活泼' },
        ],
        hint: '开头用多短的话接住话题。',
      },
    ],
  },
  {
    group: 'memory',
    title: '记忆',
    desc: '三层记忆结构：短期上下文、中期脉络、长期事实。',
    items: [
      {
        path: 'memory.enabled',
        label: '启用记忆',
        type: 'boolean',
        hint: '关闭后不整理、不召回，纯聊天。',
      },
      {
        path: 'memory.curateEveryRounds',
        label: '整理间隔（轮）',
        type: 'number',
        min: 1,
        max: 100,
        step: 1,
        hint: '每多少轮对话整理一次长期记忆。按轮数不按条数，避免群聊饿死。',
      },
      {
        path: 'memory.maxActions',
        label: '单次最多记忆条数',
        type: 'number',
        min: 1,
        max: 30,
        step: 1,
        hint: '一次整理最多产出几条判断句。',
      },
      {
        path: 'memory.historyRounds',
        label: '短期上下文轮数',
        type: 'number',
        min: 1,
        max: 100,
        step: 1,
        hint: '注入 prompt 的最近对话轮数。太多会占 token。',
      },
      {
        path: 'memory.perUserNamespace',
        label: '按人建子语境',
        type: 'boolean',
        hint: '群聊里每个人的记忆单独存放，避免串味。',
      },
      {
        path: 'memory.midTerm.enabled',
        label: '中期记忆',
        type: 'boolean',
        hint: '把被挤出短期窗口的对话压成「摘要 + 召回线索」。',
      },
      {
        path: 'memory.midTerm.recallThreshold',
        label: '中期召回阈值',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        hint: '召回线索与当前对话的相似度阈值，越高越保守。',
      },
      {
        path: 'memory.midTerm.maxMessages',
        label: '单次摘要消息数',
        type: 'number',
        min: 5,
        max: 200,
        step: 5,
        hint: '一次压缩多少条消息。',
      },
      {
        path: 'memory.heuristic.enabled',
        label: '启发式拉起',
        type: 'boolean',
        hint: '按节流条件主动拉长期记忆，避免每轮重复查向量库。',
      },
      {
        path: 'memory.heuristic.minIntervalSec',
        label: '最小间隔（秒）',
        type: 'number',
        min: 0,
        max: 3600,
        step: 10,
        hint: '距上次拉起不足这个时间就不再查。',
      },
      {
        path: 'memory.heuristic.minNewMessages',
        label: '最少新增消息',
        type: 'number',
        min: 1,
        max: 100,
        step: 1,
        hint: '新增消息不足这个条数就不查。',
      },
      {
        path: 'memory.heuristic.cacheTtlSec',
        label: '结果缓存（秒）',
        type: 'number',
        min: 0,
        max: 3600,
        step: 30,
        hint: '缓存期间直接复用，命中时零开销。',
      },
      {
        path: 'memory.profile.enabled',
        label: '人物画像',
        type: 'boolean',
        hint: '按 QQ 号积累对每个人的认知，注入时只用活跃的人。',
      },
    ],
  },
  {
    group: 'forward',
    title: '消息处理',
    desc: '控制哪些消息参与对话。',
    items: [
      {
        path: 'forward.ignore',
        label: '忽略合并转发',
        type: 'boolean',
        hint: '转发内容通常是别人的长篇聊天记录，读进来没有意义。',
      },
      {
        path: 'forward.keepPlaceholder',
        label: '保留转发占位',
        type: 'boolean',
        hint: '丢弃内容但留一条占位记录，维持时间线连续。',
      },
    ],
  },
  {
    group: 'llm',
    title: 'LLM 模型',
    desc: '回复与记忆整理用的模型。',
    items: [
      {
        path: 'llm.baseUrl',
        label: '接口地址',
        type: 'string',
        hint: 'OpenAI 兼容接口，例如 http://127.0.0.1:7864/v1',
      },
      {
        path: 'llm.apiKey',
        label: 'API 密钥',
        type: 'secret',
        hint: '留空表示不发送 Authorization 头。',
      },
      {
        path: 'llm.model',
        label: '模型名',
        type: 'string',
        hint: '服务商提供的模型标识符。',
      },
      {
        path: 'llm.temperature',
        label: '温度',
        type: 'number',
        min: 0,
        max: 2,
        step: 0.1,
        hint: '越高越发散，聊天建议 0.7~0.9。',
      },
      {
        path: 'llm.maxTokens',
        label: '最大输出 token',
        type: 'number',
        min: 50,
        max: 8000,
        step: 50,
        hint: '单次回复上限。',
      },
      {
        path: 'llm.timeoutMs',
        label: '超时（毫秒）',
        type: 'number',
        min: 5000,
        max: 300000,
        step: 5000,
        hint: '超过这个时间视为失败。',
      },
    ],
  },
  {
    group: 'vector',
    title: '向量服务',
    desc: '嵌入与向量检索。记忆存这里。',
    items: [
      {
        path: 'vector.url',
        label: '服务地址',
        type: 'string',
        hint: '本地向量服务，默认 http://127.0.0.1:8765',
      },
      {
        path: 'vector.autoStart',
        label: '自动启动',
        type: 'boolean',
        hint: '由主程序托管启动 Python 向量服务。',
      },
      {
        path: 'vector.topK',
        label: '召回条数',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        hint: '每次检索取最相关的几条。',
      },
      {
        path: 'vector.recallTimeoutMs',
        label: '召回超时（毫秒）',
        type: 'number',
        min: 200,
        max: 30000,
        step: 100,
        hint: '超时降级到近期记忆，不阻塞回复。',
      },
      {
        path: 'vector.timeoutMs',
        label: '写入超时（毫秒）',
        type: 'number',
        min: 1000,
        max: 60000,
        step: 500,
        hint: '向量写入的宽松超时。',
      },
    ],
  },
  {
    group: 'onebot',
    title: 'QQ 连接',
    desc: 'OneBot 协议端配置。改完需要重启。',
    items: [
      {
        path: 'onebot.wsUrl',
        label: 'WebSocket 地址',
        type: 'string',
        hint: 'NapCat 监听地址，默认 ws://127.0.0.1:3001',
      },
      {
        path: 'onebot.selfId',
        label: '机器人 QQ 号',
        type: 'string',
        hint: '填了就用于 NapCat 快速登录（免扫码）。',
      },
      {
        path: 'onebot.accessToken',
        label: '访问令牌',
        type: 'secret',
        hint: 'NapCat 配置了 token 才需要填。',
      },
      {
        path: 'onebot.autoStart',
        label: '自动启动 NapCat',
        type: 'boolean',
        hint: '由主程序托管启动 NapCat。',
      },
      {
        path: 'onebot.reconnectBaseSec',
        label: '重连基础间隔（秒）',
        type: 'number',
        min: 1,
        max: 60,
        step: 1,
        hint: '断线后按指数退避重连。',
      },
      {
        path: 'onebot.reconnectMaxSec',
        label: '重连上限（秒）',
        type: 'number',
        min: 10,
        max: 600,
        step: 10,
        hint: '重连间隔最长不超过这个值。',
      },
    ],
  },
  {
    group: 'image',
    title: '生图',
    desc: '用户明确要求「画一张」时才生成。不做主动配图，避免在群里乱刷。',
    items: [
      {
        path: 'image.enabled',
        label: '启用生图',
        type: 'boolean',
        hint: '关闭后完全忽略生图请求。',
      },
      {
        path: 'image.baseUrl',
        label: '接口地址',
        type: 'string',
        hint: 'OpenAI 兼容的生图服务，例如 https://nai.rinko.ai',
      },
      {
        path: 'image.apiKey',
        label: '生图密钥',
        type: 'secret',
        hint: '形如 ynai-xxx。留空则生图不可用。',
      },
      {
        path: 'image.freeOnly',
        label: '只用免费额度',
        type: 'boolean',
        hint: '开启后只能用不消耗 Gems 的模型；选了付费模型会自动降级，不会扣费。',
      },
      {
        path: 'image.freeQuotaPer10Min',
        label: '免费额度上限',
        type: 'number',
        min: 1,
        max: 20,
        step: 1,
        hint: '服务端规则是免费 20 张 / 10 分钟，超出后每张消耗图包次数。默认 18 留点余量。',
      },
      {
        path: 'image.model',
        label: '模型',
        type: 'enum',
        options: [
          { value: 'nai-diffusion-4-5-full', label: '4-5-full（免费，推荐）' },
          { value: 'nai-diffusion-4-5-curated', label: '4-5-curated（免费）' },
          { value: 'nai-diffusion-4-full', label: '4-full（免费，画风偏扁平）' },
          { value: 'nai-diffusion-4-curated', label: '4-curated（免费）' },
          { value: 'nai-diffusion-5-full', label: '5-full（付费，2 Gems/张）' },
          { value: 'nai-diffusion-5-curated', label: '5-curated（付费，2 Gems/张）' },
        ],
        hint: '4 系列走免费额度（每 10 分钟 20 张），5 系列每张扣 2 Gems。开着「只用免费额度」时付费模型会被换成 4-5-full。',
      },
      {
        path: 'image.negativePrompt',
        label: '负向提示词',
        type: 'string',
        hint: '留空则用内置默认值（已含 nsfw、畸形、水印等约束）。改空会有走光风险。',
      },
      {
        path: 'image.size',
        label: '尺寸',
        type: 'enum',
        options: [
          { value: '832x1216', label: '832×1216 竖图（人物半身最稳）' },
          { value: '1216x832', label: '1216×832 横图' },
          { value: '1024x1024', label: '1024×1024 方图' },
        ],
        hint: '再大只是更慢，832×1216 已经能保证脸和手不崩。',
      },
      {
        path: 'image.steps',
        label: '采样步数',
        type: 'number',
        min: 1,
        max: 28,
        step: 1,
        hint: '4-5 与 5 系列上限都是 28，再多无效。',
      },
      {
        path: 'image.scale',
        label: '提示词遵循度',
        type: 'number',
        min: 1,
        max: 10,
        step: 0.5,
        hint: '越高越贴提示词但画面越僵。4~7 之间，5 比较平衡。',
      },
      {
        path: 'image.cooldownSec',
        label: '生图冷却（秒）',
        type: 'number',
        min: 0,
        max: 600,
        step: 5,
        hint: '同一会话两次生图的最小间隔，防止被人反复要图刷配额。',
      },
    ],
  },
  {
    group: 'webui',
    title: '控制面板',
    desc: '本面板自身的设置。',
    items: [
      {
        path: 'webui.enabled',
        label: '启用面板',
        type: 'boolean',
        hint: '关闭后无法访问本页面。',
      },
      {
        path: 'webui.port',
        label: '面板端口',
        type: 'number',
        min: 1024,
        max: 65535,
        step: 1,
        hint: '改完需要重启生效。',
      },
      {
        path: 'webui.autoOpen',
        label: '启动时自动打开',
        type: 'boolean',
        hint: '开机自动弹出面板与 NapCat 控制台。',
      },
      {
        path: 'log.level',
        label: '日志级别',
        type: 'enum',
        options: [
          { value: 'debug', label: 'debug（最详细）' },
          { value: 'info', label: 'info（默认）' },
          { value: 'warn', label: 'warn（只看警告）' },
          { value: 'error', label: 'error（只看错误）' },
        ],
        hint: 'debug 会输出大量细节，排查问题用。',
      },
    ],
  },
];

/** 需要重启才能生效的配置路径前缀。 */
export const RESTART_REQUIRED = ['webui.port', 'webui.enabled', 'onebot.wsUrl', 'onebot.accessToken'];

/** 按路径读取对象值。 */
export function getByPath(obj, path) {
  const parts = String(path).split('.');
  let cursor = obj;
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/** 按路径写入对象值，中间层级不存在则创建。 */
export function setByPath(obj, path, value) {
  const parts = String(path).split('.');
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (typeof cursor[part] !== 'object' || cursor[part] === null) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

/** 按 schema 索引的字段定义。 */
export const SCHEMA_BY_PATH = new Map(
  CONFIG_SCHEMA.flatMap((group) => group.items.map((item) => [item.path, { ...item, group: group.group }])),
);
