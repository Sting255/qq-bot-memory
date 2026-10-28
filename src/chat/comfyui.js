/**
 * ComfyUI 生图后端。
 *
 * 为什么单独一个文件：ComfyUI 用的是「提交工作流 JSON → 轮询历史 → 下载图片」
 * 这套异步协议，和云端那种一次请求直接返图的接口完全不同，混在 image.js 里
 * 会把两条路径绞在一起。
 *
 * 工作流用 ComfyUI 的 **API 格式**（节点 id 为键的 JSON），
 * 也就是「Save (API Format)」导出的那种，不是 UI 格式。
 *
 * 参数怎么塞进工作流：靠 bindings 声明「哪个节点的哪个字段」，
 * 而不是硬编码节点 id——不同工作流的节点编号完全不同。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '../logger.js';
import { config } from '../config.js';

const log = createLogger('comfyui');

/** 工作流缓存：路径 -> { mtimeMs, data }。文件改了自动重载。 */
let cache = { path: '', mtimeMs: 0, data: null };

/**
 * 读取 API 格式工作流（带缓存）。
 * @param {string} workflowPath
 * @returns {object}
 */
export function loadWorkflow(workflowPath) {
  const abs = resolve(workflowPath);
  if (!existsSync(abs)) {
    throw new Error(`找不到 ComfyUI 工作流: ${workflowPath}`);
  }
  const stat = readFileSync(abs);
  const data = JSON.parse(stat.toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('工作流必须是 API 格式（节点 id 为键的对象），不能用 UI 格式');
  }
  cache = { path: abs, mtimeMs: 0, data };
  return JSON.parse(JSON.stringify(data)); // 深拷贝，避免改动污染缓存
}

/**
 * 按 bindings 把参数写进工作流。
 *
 * @param {object} workflow API 格式工作流（会被原地修改）
 * @param {object} params 待写入的值，例如 { positive, negative, width, height, steps, cfg, seed }
 * @param {object} bindings { positive: { node: '4', input: 'text' }, ... }
 * @returns {object} 同一个 workflow
 */
export function applyBindings(workflow, params, bindings = {}) {
  for (const [key, target] of Object.entries(bindings)) {
    if (!target?.node || !target?.input) continue;
    const value = params[key];
    if (value === undefined || value === null || value === '') continue;
    const node = workflow[String(target.node)];
    if (!node) {
      log.warn(`bindings.${key} 指向的节点 ${target.node} 不存在，跳过`);
      continue;
    }
    node.inputs = node.inputs || {};
    node.inputs[target.input] = value;
  }
  return workflow;
}

/** 从 size 字符串（832x1216）解析宽高。 */
export function parseSize(size, fallback = { width: 1024, height: 1024 }) {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(String(size || '').trim());
  if (!m) return fallback;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * 提交工作流并等待出图。
 *
 * @param {object} params
 * @param {string} params.prompt 正向提示词
 * @param {string} [params.negativePrompt]
 * @param {object} cfg config.image.comfyui
 * @param {number} [params.steps]
 * @param {number} [params.cfgScale]
 * @param {string} [params.size]
 * @returns {Promise<Buffer>} 图片数据
 */
export async function generateWithComfyUI({ prompt, negativePrompt = '', cfg, steps, cfgScale, size }) {
  const base = String(cfg.baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '');
  const timeoutMs = Number(cfg.timeoutMs) || 180000;

  const workflow = loadWorkflow(cfg.workflow);
  const { width, height } = parseSize(size, parseSize(cfg.size, { width: 1024, height: 1024 }));
  const seed = Number.isFinite(cfg.seed) && cfg.seed >= 0 ? cfg.seed : Math.floor(Math.random() * 1e15);

  applyBindings(workflow, {
    positive: prompt,
    negative: negativePrompt || cfg.negativePrompt || '',
    width,
    height,
    steps: steps ?? cfg.steps ?? 20,
    cfg: cfgScale ?? cfg.scale ?? 5,
    seed,
  }, cfg.bindings);

  const clientId = `qq-bot-${Date.now()}`;
  const startedAt = Date.now();

  // 1. 提交任务
  const submit = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal: AbortSignal.timeout(15000),
  }).catch((error) => {
    throw new Error(`ComfyUI 连接失败（${base}）: ${error.message}`);
  });

  if (!submit.ok) {
    const body = await submit.text().catch(() => '');
    throw new Error(`ComfyUI 提交失败 ${submit.status}: ${body.slice(0, 300)}`);
  }
  const submitted = await submit.json();
  const promptId = submitted?.prompt_id;
  if (!promptId) {
    throw new Error(`ComfyUI 未返回 prompt_id: ${JSON.stringify(submitted).slice(0, 200)}`);
  }
  log.info(`ComfyUI 任务已提交 ${promptId}`);

  // 2. 轮询历史直到出图（ComfyUI 没有推送，只能轮）
  const deadline = startedAt + timeoutMs;
  let imageMeta = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    let history;
    try {
      const res = await fetch(`${base}/history/${promptId}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      history = await res.json();
    } catch {
      continue; // 单次查询失败不算任务失败，继续等
    }
    const entry = history?.[promptId];
    if (!entry) continue;

    const status = entry.status?.status_str;
    if (status === 'error') {
      const msg = entry.status?.messages?.find((m) => m[0] === 'execution_error')?.[1];
      throw new Error(`ComfyUI 执行出错: ${String(msg?.exception_message || '未知错误').slice(0, 200)}`);
    }

    const outputs = entry.outputs || {};
    for (const nodeOut of Object.values(outputs)) {
      const img = nodeOut?.images?.[0];
      if (img?.filename) {
        imageMeta = img;
        break;
      }
    }
    if (imageMeta) break;
  }

  if (!imageMeta) {
    throw new Error(`ComfyUI 出图超时（${timeoutMs}ms）`);
  }

  // 3. 下载图片
  const viewUrl = `${base}/view?filename=${encodeURIComponent(imageMeta.filename)}`
    + `&subfolder=${encodeURIComponent(imageMeta.subfolder || '')}`
    + `&type=${encodeURIComponent(imageMeta.type || 'output')}`;
  const imgRes = await fetch(viewUrl, { signal: AbortSignal.timeout(30000) });
  if (!imgRes.ok) {
    throw new Error(`ComfyUI 图片下载失败 ${imgRes.status}`);
  }
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error('ComfyUI 返回空图片');
  }
  log.info(`ComfyUI 出图完成 ${buffer.length}B 耗时=${Date.now() - startedAt}ms`);
  return buffer;
}

/** 当前是否走 ComfyUI 后端。 */
export function isComfyUIEnabled() {
  return config.image?.provider === 'comfyui' && Boolean(config.image?.comfyui?.workflow);
}
