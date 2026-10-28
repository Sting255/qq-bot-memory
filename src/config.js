/**
 * 配置加载：读取 config.yaml，缺失时从 config.example.yaml 复制一份。
 * 环境变量优先级高于配置文件，便于临时覆盖。
 */
import { existsSync, copyFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envStr(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw !== 'false' && raw !== '0';
}

function loadYaml() {
  const target = resolve(ROOT, 'config.yaml');
  const example = resolve(ROOT, 'config.example.yaml');
  if (!existsSync(target)) {
    copyFileSync(example, target);
    console.log('[config] 已从 config.example.yaml 生成 config.yaml，请按需修改后重启');
  }
  return yaml.load(readFileSync(target, 'utf8')) || {};
}

const raw = loadYaml();

export /**
 * 组装识图模型配置。
 *
 * 读取顺序：llm.vision（推荐）→ 顶层 vision（旧配置兼容）
 * 地址与密钥未单独填写时复用主 llm 的，方便同网关多模型部署。
 */
function buildVisionConfig(raw) {
  const v = raw.llm?.vision ?? raw.vision ?? {};
  const baseUrl = envStr('VISION_BASE_URL', v.base_url || '') || raw.llm?.base_url || '';
  const apiKey = envStr('VISION_API_KEY', v.api_key || '') || raw.llm?.api_key || '';
  return {
    enabled: envBool('VISION_ENABLED', v.enabled ?? true),
    baseUrl,
    apiKey,
    model: envStr('VISION_MODEL', v.model ?? '') || 'Qwen3-VL-235B',
    // 接口路径：默认 OpenAI 兼容的 /chat/completions。
    // 换供应商如果路径不同（如 /v1/chat/completions、/responses），在这里改。
    path: v.path ?? '/chat/completions',
    timeoutMs: Number(v.timeout_ms ?? 40000),
    maxImages: Number(v.max_images ?? 2),
  };
}

export const config = {
  root: ROOT,
  dataDir: process.env.BOT_DATA_DIR ? resolve(process.env.BOT_DATA_DIR) : resolve(ROOT, 'data'),
  logDir: resolve(ROOT, 'logs'),

  onebot: {
    wsUrl: envStr('ONEBOT_WS_URL', raw.onebot?.ws_url ?? 'ws://127.0.0.1:3001'),
    accessToken: envStr('ONEBOT_ACCESS_TOKEN', raw.onebot?.access_token ?? ''),
    selfId: String(envNum('ONEBOT_SELF_ID', raw.onebot?.self_id ?? 0)),
    /** 是否由本进程托管启动 NapCat。 */
    autoStart: raw.onebot?.auto_start ?? true,
    reconnectBaseSec: raw.onebot?.reconnect_base_sec ?? 3,
    reconnectMaxSec: raw.onebot?.reconnect_max_sec ?? 60,
  },

  llm: {
    baseUrl: envStr('LLM_BASE_URL', raw.llm?.base_url ?? ''),
    apiKey: envStr('LLM_API_KEY', raw.llm?.api_key ?? ''),
    model: envStr('LLM_MODEL', raw.llm?.model ?? ''),
    temperature: raw.llm?.temperature ?? 0.8,
    maxTokens: raw.llm?.max_tokens ?? 800,
    timeoutMs: raw.llm?.timeout_ms ?? 60000,
  },

  vector: {
    url: envStr('VECTOR_SERVICE_URL', raw.vector?.url ?? 'http://127.0.0.1:8765'),
    corpus: raw.vector?.corpus ?? 'memory_fragments',
    timeoutMs: raw.vector?.timeout_ms ?? 8000,
    recallTimeoutMs: raw.vector?.recall_timeout_ms ?? 2500,
    topK: raw.vector?.top_k ?? 12,
    /** 是否由本进程托管启动向量服务。 */
    autoStart: raw.vector?.auto_start ?? true,
  },

  webui: {
    enabled: raw.webui?.enabled ?? true,
    port: Number(raw.webui?.port ?? 3099),
    /** 启动后是否自动打开管理面板与 NapCat 控制台。 */
    autoOpen: envBool('WEBUI_AUTO_OPEN', raw.webui?.auto_open ?? true),
  },

  trigger: {
    frequency: Number(raw.trigger?.frequency ?? 0.05),
    replyOnAt: envBool('REPLY_ON_AT', raw.trigger?.reply_on_at ?? true),
    replyOnMention: envBool('REPLY_ON_MENTION', raw.trigger?.reply_on_mention ?? false),
    nicknames: raw.trigger?.nicknames ?? [],
    debounceSec: raw.trigger?.debounce_sec ?? 1.5,
    // 防抖状态机（借鉴 MaiBot）：安静/活跃开批、同人/换人续发、@提速、整批上限
    debounce: {
      quietSec: Number(raw.trigger?.debounce?.quiet_sec ?? raw.trigger?.debounce_sec ?? 2),
      activeSec: Number(raw.trigger?.debounce?.active_sec ?? 5),
      sameAuthorSec: Number(raw.trigger?.debounce?.same_author_sec ?? 2),
      differentAuthorSec: Number(raw.trigger?.debounce?.different_author_sec ?? 0.5),
      mentionLimitSec: Number(raw.trigger?.debounce?.mention_limit_sec ?? 1),
      batchLimitSec: Number(raw.trigger?.debounce?.batch_limit_sec ?? 8),
      bareImageSec: Number(raw.trigger?.debounce?.bare_image_sec ?? 4),
    },
    idleBackoffBaseSec: raw.trigger?.idle_backoff_base_sec ?? 30,
    idleBackoffCapSec: raw.trigger?.idle_backoff_cap_sec ?? 600,
    idleBackoffStartCount: raw.trigger?.idle_backoff_start_count ?? 3,
    // 主动插话阈值的校准系数：越小越爱说话（0.3 很活跃 / 0.4 适中 / 0.6 很沉默）
    thresholdScale: Number(raw.trigger?.threshold_scale ?? 0.55),
    // 心跳主动性（借鉴 Cortico heartbeat）：默认关闭，测试群验证后再开
    heartbeat: {
      enabled: envBool('HEARTBEAT_ENABLED', raw.trigger?.heartbeat?.enabled ?? false),
      baselineSec: Number(raw.trigger?.heartbeat?.baseline_sec ?? 1800),
      dailyLimit: Number(raw.trigger?.heartbeat?.daily_limit ?? 3),
      cooldownSec: Number(raw.trigger?.heartbeat?.cooldown_sec ?? 3600),
    },
  },

  persona: {
    typo: {
      enabled: raw.persona?.typo?.enabled ?? true,
      errorRate: raw.persona?.typo?.error_rate ?? 0.01,
      toneErrorRate: raw.persona?.typo?.tone_error_rate ?? 0.1,
      wordReplaceRate: raw.persona?.typo?.word_replace_rate ?? 0.006,
      correctionProbability: raw.persona?.typo?.correction_probability ?? 0.5,
    },
    splitter: {
      enabled: raw.persona?.splitter?.enabled ?? true,
      maxLength: raw.persona?.splitter?.max_length ?? 200,
      maxSplitNum: raw.persona?.splitter?.max_split_num ?? 3,
    },
    typing: {
      enabled: raw.persona?.typing?.enabled ?? true,
      speed: raw.persona?.typing?.speed ?? 1,
      chineseCharSec: raw.persona?.typing?.chinese_char_sec ?? 0.09,
      englishCharSec: raw.persona?.typing?.english_char_sec ?? 0.045,
    },
    quote: {
      // never | occasionally | often
      frequency: raw.persona?.quote?.frequency ?? 'occasionally',
    },
    drift: {
      // subtle | active | scattered | wild
      level: raw.persona?.drift?.level ?? 'subtle',
      // strict | balanced | loose
      anchorPolicy: raw.persona?.drift?.anchor_policy ?? 'balanced',
      // reserved | natural | lively
      reactionStyle: raw.persona?.drift?.reaction_style ?? 'natural',
    },
  },

  memory: {
    enabled: envBool('MEMORY_ENABLED', raw.memory?.enabled ?? true),
    curateEveryRounds: raw.memory?.curate_every_rounds ?? 10,
    curateEveryMessages: raw.memory?.curate_every_messages ?? 40,
    maxActions: raw.memory?.max_actions ?? 12,
    perUserNamespace: raw.memory?.per_user_namespace ?? true,
    historyRounds: raw.memory?.history_rounds ?? 10,
    midTerm: {
      enabled: raw.memory?.mid_term?.enabled ?? true,
      recallThreshold: raw.memory?.mid_term?.recall_threshold ?? 0.8,
      maxMessages: raw.memory?.mid_term?.max_messages ?? 60,
    },
    heuristic: {
      enabled: raw.memory?.heuristic?.enabled ?? true,
      minIntervalSec: raw.memory?.heuristic?.min_interval_sec ?? 60,
      minNewMessages: raw.memory?.heuristic?.min_new_messages ?? 5,
      cacheTtlSec: raw.memory?.heuristic?.cache_ttl_sec ?? 180,
    },
    profile: {
      enabled: raw.memory?.profile?.enabled ?? true,
    },
  },

  // 表达习惯与黑话学习（借鉴 MaiBot learners）：默认开启，挖掘 12h 一次
  expression: {
    enabled: envBool('EXPRESSION_ENABLED', raw.expression?.enabled ?? true),
  },
  // 辅助识图模型：配在 llm.vision 下，地址与接口独立于主聊天模型。
  // 为什么必须独立：主模型 deepseek-v4.1-flash 在上游不是多模态，
  // 带图请求会 502「The request model is not multimodal」并触发账号
  // 10 分钟冷却，等于把机器人打死。
  // 兼容旧配置：顶层 vision 段仍可用，但 llm.vision 优先。
  vision: buildVisionConfig(raw),

  webTools: {
    enabled: envBool('WEB_TOOLS_ENABLED', raw.web_tools?.enabled ?? true),
  },

  tts: {
    enabled: envBool('TTS_ENABLED', raw.tts?.enabled ?? true),
    /** 小米 MiMo，OpenAI 兼容协议。 */
    baseUrl: envStr('TTS_BASE_URL', raw.tts?.base_url ?? 'https://api.xiaomimimo.com/v1'),
    /** MiMo 密钥。没配的话语音功能不可用。 */
    apiKey: envStr('MIMO_API_KEY', raw.tts?.api_key ?? ''),
    model: envStr('TTS_MODEL', raw.tts?.model ?? 'mimo-v2.5-tts-voiceclone'),
    /** 音色参考音频，相对项目根目录。mp3 或 wav，20 秒以内最佳。 */
    samplePath: raw.tts?.sample_path ?? 'resources/voice/cyrene-sample.mp3',
    /** 默认风格指令，会放进 user 消息。 */
    style: raw.tts?.style ?? '用轻快甜软的少女声线说话，语气自然，像在和朋友聊天',
    /** 合成超时。超过这个时间就放弃发语音，只留文字回复。 */
    timeoutMs: Number(raw.tts?.timeout_ms ?? 30000),
  },

  image: {
    // 生图后端：openai = 云端 OpenAI 兼容接口；comfyui = 本地 ComfyUI
    provider: raw.image?.provider ?? 'openai',
    // ComfyUI 后端配置（provider=comfyui 时生效）
    comfyui: {
      baseUrl: raw.image?.comfyui?.base_url ?? 'http://127.0.0.1:8188',
      // API 格式工作流（ComfyUI 里 Save (API Format) 导出的 JSON）
      workflow: raw.image?.comfyui?.workflow ?? '',
      // 参数写进工作流的哪个节点哪个字段
      bindings: raw.image?.comfyui?.bindings ?? {},
      negativePrompt: raw.image?.comfyui?.negative_prompt ?? '',
      size: raw.image?.comfyui?.size ?? '1024x1024',
      steps: Number(raw.image?.comfyui?.steps ?? 20),
      scale: Number(raw.image?.comfyui?.scale ?? 5),
      seed: Number.isFinite(raw.image?.comfyui?.seed) ? Number(raw.image.comfyui.seed) : -1,
      timeoutMs: Number(raw.image?.comfyui?.timeout_ms ?? 180000),
    },
    enabled: envBool('IMAGE_ENABLED', raw.image?.enabled ?? true),
    /** 云端生图服务地址，OpenAI 兼容的 /v1/images/generations。 */
    baseUrl: envStr('IMAGE_BASE_URL', raw.image?.base_url ?? 'https://nai.rinko.ai'),
    /** 生图密钥。优先取环境变量，写在配置文件里也不会进版本库。 */
    apiKey: envStr('IMAGE_API_KEY', raw.image?.api_key ?? ''),
    model: envStr('IMAGE_MODEL', raw.image?.model ?? 'nai-diffusion-4-5-full'),
    /** 只允许用不消耗 Gems 的免费模型。开启后付费模型会被强制降级。 */
    freeOnly: envBool('IMAGE_FREE_ONLY', raw.image?.free_only ?? true),
    /**
     * 免费额度：每 10 分钟最多画多少张。
     *
     * 服务端规则是免费 20 张 / 10 分钟，超出后每张消耗一次图包次数。
     * 默认留 2 张余量，避免机器人把额度吃干净后手动测试画不出来。
     */
    freeQuotaPer10Min: Number(raw.image?.free_quota_per_10min ?? 18),
    /** 负向提示词，留空则用内置的安全默认值。 */
    negativePrompt: raw.image?.negative_prompt ?? '',
    size: raw.image?.size ?? '832x1216',
    steps: Number(raw.image?.steps ?? 28),
    scale: Number(raw.image?.scale ?? 5),
    timeoutMs: Number(raw.image?.timeout_ms ?? 90000),
    /** 同一会话两次生图的最小间隔（秒），防止被人反复要图。 */
    cooldownSec: Number(raw.image?.cooldown_sec ?? 30),
  },

  forward: {
    ignore: raw.forward?.ignore ?? true,
    keepPlaceholder: raw.forward?.keep_placeholder ?? true,
  },

  log: {
    level: envStr('LOG_LEVEL', raw.log?.level ?? 'info'),
    file: raw.log?.file ?? 'data/bot.log',
  },
};

export function ensureDirs() {
  for (const dir of [config.dataDir, config.logDir]) {
    mkdirSync(dir, { recursive: true });
  }
}
