/**
 * LLM 客户端：OpenAI 兼容接口，支持流式与非流式。
 *
 * 不引第三方 SDK，直接用 fetch。理由是本项目只用 chat completions 一个端点，
 * 为它加一个依赖不值得。
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { recordUsage } from '../memory/usage.js';

const log = createLogger('llm');

/**
 * 全局 LLM 并发闸门（借鉴 LangBot query pool 思想）。
 *
 * 实测：聊天回复与后台任务（记忆整理/中期摘要/表达挖掘）同时打同一个上游，
 * 上游排队导致聊天首字从 1s 涨到 40s+。聊天回复是用户能感知的，必须优先。
 *
 * 策略：聊天回复（priority=0）不排队，直接放行；后台任务（priority=1）
 * 最多同时跑 maxBackground 个，超出的排队等空位。这样后台再忙也不阻塞聊天。
 */
const BACKGROUND_MAX_CONCURRENT = 1;
let backgroundRunning = 0;
const backgroundQueue = [];

async function acquireSlot(priority) {
  if (priority === 0) return () => {}; // 聊天永不排队
  if (backgroundRunning < BACKGROUND_MAX_CONCURRENT) {
    backgroundRunning += 1;
    return () => {
      backgroundRunning -= 1;
      const next = backgroundQueue.shift();
      if (next) next();
    };
  }
  // 排队等空位
  await new Promise((resolve) => backgroundQueue.push(resolve));
  backgroundRunning += 1;
  return () => {
    backgroundRunning -= 1;
    const next = backgroundQueue.shift();
    if (next) next();
  };
}

function buildHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (config.llm.apiKey) headers.Authorization = `Bearer ${config.llm.apiKey}`;
  return headers;
}

function buildBody(messages, opts) {
  const body = {
    model: opts.model ?? config.llm.model,
    messages,
    temperature: opts.temperature ?? config.llm.temperature,
    max_tokens: opts.maxTokens ?? config.llm.maxTokens,
    stream: opts.stream === true,
  };
  // 流式时要求上游在最后一个分片里带上用量，否则统计不到
  if (body.stream) body.stream_options = { include_usage: true };
  return JSON.stringify(body);
}

/**
 * 判断是否为可重试的临时性错误。
 *
 * 上游中转服务经常返回 503 upstream_timeout（池子里没健康账号），
 * 这类错误等几秒重试往往就好了。而 401/404 这种立刻重试也没用。
 *
 * 另外把「空内容」也算可重试：这个模型偶尔只输出推理不给正文，
 * 重试一次通常就有内容了。
 */
function isRetryableError(error) {
  const message = String(error?.message || '');
  if (message.includes('LLM empty')) return true;
  const status = Number((/LLM (\d{3})/.exec(message) || [])[1]);
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** 退避等待。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 非流式调用（带退避重试）。
 *
 * @param {{role: string, content: string}[]} messages
 * @param {object} opts
 * @returns {Promise<string>} 回复文本
 */
export async function chatSync(messages, opts = {}) {
  const label = opts.label ?? 'chat';
  const maxAttempts = opts.maxAttempts ?? 3;
  // 后台任务（记忆整理/摘要/挖掘）走闸门，避免与聊天回复争上游；
  // 传 priority: 0 可强制不排队（兜底回复等用户可感知的路径）
  const release = await acquireSlot(opts.priority ?? 1);
  try {
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await chatSyncOnce(messages, opts);
      } catch (error) {
        lastError = error;
        // 只对临时性错误重试
        if (!isRetryableError(error)) throw error;
        if (attempt === maxAttempts - 1) break;

        const waitMs = Math.min(8000, 800 * 2 ** attempt);
        log.warn(`LLM 临时错误，${waitMs}ms 后重试 (${attempt + 1}/${maxAttempts - 1}, ${label}): ${error.message.slice(0, 80)}`);
        await sleep(waitMs);
      }
    }
    throw lastError;
  } finally {
    release();
  }
}

/** 单次非流式调用。 */
async function chatSyncOnce(messages, opts = {}) {
  const label = opts.label ?? 'chat';
  const timeoutMs = opts.timeoutMs ?? config.llm.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(),
      body: buildBody(messages, opts),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    // 先记用量：即使正文为空也算消耗，不然后面抛错就漏统计了
    recordUsage(data.usage);
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? '';
    const finishReason = choice?.finish_reason;

    // 空内容视为临时故障：这个模型偶尔只输出 reasoning_content、正文为空，
    // 表现为「调用成功但没内容」。不抛错的话上层会当成正常空回复，静默失败。
    // 例外：调用方显式允许空（比如只探连通性）。
    if (!String(content).trim() && !opts.allowEmpty) {
      throw new Error(`LLM empty: 返回空内容（finish_reason=${finishReason || 'unknown'}）`);
    }

    return String(content);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`LLM 调用超时（${timeoutMs}ms, ${label}）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 流式调用，逐块产出文本增量。
 *
 * @param {{role: string, content: string}[]} messages
 * @param {object} opts
 * @returns {AsyncGenerator<string>}
 */
export async function* chatStream(messages, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? config.llm.timeoutMs;
  const maxAttempts = opts.maxAttempts ?? 3;
  // 首字熔断：连接建立但上游迟迟不出首 token（实测卡过 52s）。
  // 注意：这个上游是「生成完首 token 才返回 response」，首字延迟 = 模型思考时间，
  // reasoning 模型正常也要 20s+。所以阈值必须大于正常思考时间，只用来杀真死连接。
  // 定得太小（如 15s）会把正常思考误杀，重试同一个模型只会再想一遍，反而更慢。
  const firstTokenTimeoutMs = opts.firstTokenTimeoutMs ?? 45000;

  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let firstTokenTimer = null;
    let gotFirstToken = false;

    try {
      // 首字计时器必须在 fetch 之前启动：
      // 上游是「生成完首 token 才返回 response」的实现，卡在 await fetch
      // 期间（实测 23~52s）计时器如果晚启动，就永远等不到触发时机。
      firstTokenTimer = setTimeout(() => controller.abort(), firstTokenTimeoutMs);

      const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: buildHeaders(),
        body: buildBody(messages, { ...opts, stream: true }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
      }

      // 首字已拿到（response 已返回），计时器在收到第一个 delta 时再清除；
      // 这里不清，因为流式 body 读取本身也可能卡住
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') return;
          try {
            const parsed = JSON.parse(payload);
            // 流式用量在最后一个带 usage 的分片里，收到就记
            if (parsed.usage) recordUsage(parsed.usage);
            const deltaObj = parsed.choices?.[0]?.delta || {};

            // 关键：这个上游是 reasoning 模型，会先持续推 reasoning_content 分片，
            // 正文 content 在思考结束后才出现。只要收到任何分片（含思考），
            // 就说明上游活着，必须清掉首字熔断计时器——
            // 否则 15 秒一到就 abort，重试后模型再想一遍，白白多花一倍时间。
            if (deltaObj.reasoning_content) {
              if (!gotFirstToken) {
                gotFirstToken = true;
                clearTimeout(firstTokenTimer);
                firstTokenTimer = null;
              }
            }

            const delta = deltaObj.content;
            if (delta) {
              if (!gotFirstToken) {
                gotFirstToken = true;
                clearTimeout(firstTokenTimer);
                firstTokenTimer = null;
              }
              yield delta;
            }
          } catch {
            // 不完整的分片，等下一轮
          }
        }
      }
      return;
    } catch (error) {
      lastError = error;
      // 已经发出去内容就不能重来，否则用户会看到重复文本
      if (gotFirstToken) {
        const aborted = error.name === 'AbortError' || /abort/i.test(String(error.message || ''));
        throw aborted ? new Error(`LLM 流式调用超时（${timeoutMs}ms）`) : error;
      }

      // 首字前失败（含 abort）：归一成可重试错误
      const aborted = error.name === 'AbortError' || /abort/i.test(String(error.message || ''));
      const normalized = aborted
        ? new Error(`LLM 首字超时（${firstTokenTimeoutMs}ms，连接已建立但上游无输出）`)
        : error;

      if (!isRetryableError(normalized) || attempt === maxAttempts - 1) throw normalized;

      const waitMs = Math.min(8000, 800 * 2 ** attempt);
      log.warn(`流式 LLM 首字前失败，${waitMs}ms 后重试 (${attempt + 1}/${maxAttempts - 1}): ${String(normalized.message).slice(0, 80)}`);
      await sleep(waitMs);
    } finally {
      clearTimeout(timer);
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
    }
  }

  throw lastError || new Error('流式调用失败');
}

/** 连通性测试。 */
export async function testConnection() {
  try {
    const reply = await chatSync([{ role: 'user', content: '回复"ok"两个字母即可' }], {
      maxTokens: 60,
      temperature: 0,
      timeoutMs: 15000,
      allowEmpty: true,
      label: 'connectivity',
    });
    return { ok: true, reply: reply.trim().slice(0, 50) };
  } catch (error) {
    log.warn('LLM 连通性测试失败:', error.message);
    return { ok: false, error: error.message };
  }
}
