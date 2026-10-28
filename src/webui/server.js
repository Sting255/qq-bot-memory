/**
 * WebUI 服务：管理面板的 HTTP 接口。
 *
 * 不引第三方框架，用 node:http 实现。
 *
 * 安全：只监听 127.0.0.1，不对外暴露。所有写操作都过 schema 白名单与范围校验。
 */
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config.js';
import { createLogger, getCurrentLogPath } from '../logger.js';
import {
  listConversations,
  listMemoriesForUi,
  listMidTermForUi,
  listProfilesForUi,
  listRecallAudit,
  softDeleteMemory,
  stats,
} from '../memory/store.js';
import { healthCheck } from '../memory/vector-client.js';
import { getUsageSummary } from '../memory/usage.js';
import { testConnection } from '../llm/client.js';
import { getPersona, PERSONA_FIELDS, renderSystemPrompt, savePersona } from '../chat/persona.js';
import { searchPersona } from '../chat/persona-search.js';
import {
  OUTFIT_SCENES,
  clearSceneOutfits,
  deleteOutfit,
  generateOutfitTags,
  listOutfits,
  saveOutfit,
} from '../chat/outfits.js';
import { getClothingCategories, searchClothing } from '../chat/clothing.js';
import {
  CONFIG_SCHEMA,
  RESTART_REQUIRED,
  SCHEMA_BY_PATH,
  getByPath,
  setByPath,
} from './schema.js';
import { persistConfigUpdates, rebuildFromTemplate } from './config-io.js';

const log = createLogger('webui');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 运行时状态，由 main.js 注入。 */
let runtimeState = {
  startedAt: null,
  onebotConnected: false,
  selfId: '',
  selfName: '',
  napcatManaged: false,
  vectorManaged: false,
};

export function setRuntimeState(patch) {
  runtimeState = { ...runtimeState, ...patch };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        rejectBody(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        rejectBody(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', rejectBody);
  });
}

/** 按 schema 读取当前配置快照。密钥不回显真实值。 */
function readConfigSnapshot() {
  const values = {};
  const secrets = {};
  for (const [path, spec] of SCHEMA_BY_PATH) {
    const raw = getByPath(config, path);
    if (spec.type === 'secret') {
      secrets[path] = Boolean(raw && String(raw).length > 0);
      continue;
    }
    values[path] = raw;
  }
  return { values, secrets };
}

/** 校验并规范化单个配置值。 */
function normalizeValue(spec, rawValue) {
  switch (spec.type) {
    case 'number': {
      const num = Number(rawValue);
      if (!Number.isFinite(num)) return { error: '不是合法数字' };
      if (spec.min !== undefined && num < spec.min) return { error: `不能小于 ${spec.min}` };
      if (spec.max !== undefined && num > spec.max) return { error: `不能大于 ${spec.max}` };
      return { value: num };
    }
    case 'boolean':
      return { value: rawValue === true || rawValue === 'true' || rawValue === 1 };
    case 'enum': {
      const allowed = (spec.options || []).map((opt) => opt.value);
      if (!allowed.includes(String(rawValue))) {
        return { error: `取值必须是 ${allowed.join(' / ')}` };
      }
      return { value: String(rawValue) };
    }
    case 'array': {
      const list = Array.isArray(rawValue)
        ? rawValue
        : String(rawValue ?? '').split(/[,，]/);
      const cleaned = list.map((item) => String(item).trim()).filter(Boolean);
      if (cleaned.length > 20) return { error: '最多 20 项' };
      return { value: cleaned };
    }
    case 'secret':
    case 'string': {
      const text = String(rawValue ?? '');
      if (text.length > 500) return { error: '长度超过 500' };
      return { value: text };
    }
    default:
      return { error: `未知类型 ${spec.type}` };
  }
}

/**
 * 应用一批配置更新。
 *
 * 同一批里任何一项校验失败，整批不落地——避免出现「改了一半」的状态。
 */
function applyUpdates(payload) {
  const applied = [];
  const errors = [];
  const pending = [];

  for (const [path, rawValue] of Object.entries(payload || {})) {
    const spec = SCHEMA_BY_PATH.get(path);
    if (!spec) {
      errors.push({ path, message: '不在可编辑白名单内' });
      continue;
    }
    const result = normalizeValue(spec, rawValue);
    if (result.error) {
      errors.push({ path, message: result.error });
      continue;
    }
    pending.push({ path, value: result.value, spec });
  }

  if (errors.length > 0) {
    return { applied, errors, restartRequired: [] };
  }

  const restartRequired = [];
  for (const { path, value, spec } of pending) {
    setByPath(config, path, value);
    applied.push(path);
    if (spec.type === 'enum' && path === 'log.level') {
      // 日志级别改了立即生效（logger 每次写都读 config）
      continue;
    }
    if (RESTART_REQUIRED.includes(path)) restartRequired.push(path);
  }

  // 持久化到 config.yaml
  if (applied.length > 0) {
    try {
      persistConfigUpdates(pending.map(({ path, value }) => ({ path, value })));
    } catch (error) {
      log.error('配置持久化失败:', error.message);
    }
  }

  return { applied, errors, restartRequired };
}

/** 读取日志文件尾部。 */
function readLogTail(maxLines = 300) {
  // 日志按天分文件，读当天那个
  const logPath = getCurrentLogPath();
  try {
    const stat = statSync(logPath);
    // 最多读尾部 512KB，避免大文件拖死面板
    const readBytes = Math.min(stat.size, 512 * 1024);
    const fd = readFileSync(logPath);
    const tail = fd.subarray(Math.max(0, fd.length - readBytes)).toString('utf8');
    const lines = tail.split('\n');
    if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
    return { lines, size: stat.size, path: config.log.file };
  } catch (error) {
    return { lines: [], size: 0, path: config.log.file, error: error.message };
  }
}

async function handleApi(req, res, pathname, query) {
  // 概览
  if (pathname === '/api/status' && req.method === 'GET') {
    const vector = await healthCheck();
    json(res, 200, {
      runtime: {
        ...runtimeState,
        uptimeSec: runtimeState.startedAt
          ? Math.floor((Date.now() - runtimeState.startedAt) / 1000)
          : 0,
      },
      stats: stats(),
      vector: {
        reachable: vector.reachable,
        count: vector.collection_count ?? 0,
        url: config.vector.url,
      },
      trigger: {
        frequency: config.trigger.frequency,
        replyOnAt: config.trigger.replyOnAt,
        replyOnMention: config.trigger.replyOnMention,
      },
      llm: {
        model: config.llm.model,
        baseUrl: config.llm.baseUrl,
      },
      webui: { port: config.webui.port },
      usage: getUsageSummary(),
    });
    return true;
  }

  // 配置 schema（前端据此渲染）
  if (pathname === '/api/config/schema' && req.method === 'GET') {
    json(res, 200, { groups: CONFIG_SCHEMA, restartRequired: RESTART_REQUIRED });
    return true;
  }

  // 配置读取
  if (pathname === '/api/config' && req.method === 'GET') {
    json(res, 200, readConfigSnapshot());
    return true;
  }

  // 配置更新
  if (pathname === '/api/config' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const result = applyUpdates(body);
      const ok = result.errors.length === 0;
      log.info(`配置更新 applied=${result.applied.length} errors=${result.errors.length}`);
      json(res, ok ? 200 : 400, { ...result, ...readConfigSnapshot() });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return true;
  }

  // 从模板重建配置文件
  if (pathname === '/api/config/reset' && req.method === 'POST') {
    try {
      rebuildFromTemplate();
      json(res, 200, { ok: true, message: '已从模板重建，需重启生效' });
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return true;
  }

  // 连通性测试
  if (pathname === '/api/test/llm' && req.method === 'POST') {
    const result = await testConnection();
    json(res, 200, result);
    return true;
  }

  if (pathname === '/api/test/vector' && req.method === 'POST') {
    const health = await healthCheck();
    json(res, 200, health);
    return true;
  }

  // 日志
  if (pathname === '/api/logs' && req.method === 'GET') {
    const lines = Math.min(2000, Math.max(50, Number(query.get('lines')) || 300));
    json(res, 200, readLogTail(lines));
    return true;
  }

  // 人设读取
  if (pathname === '/api/persona' && req.method === 'GET') {
    json(res, 200, {
      persona: getPersona(),
      fields: PERSONA_FIELDS,
      preview: renderSystemPrompt(),
    });
    return true;
  }

  // 人设保存
  if (pathname === '/api/persona' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const saved = savePersona(body);
      json(res, 200, { ok: true, persona: saved, preview: renderSystemPrompt(saved) });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return true;
  }

  // 人设搜索：从网上抓角色资料并生成草稿（不保存）
  if (pathname === '/api/persona/search' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const result = await searchPersona(body.query, { mode: body.mode || 'web' });
      json(res, result.ok ? 200 : 502, result);
    } catch (error) {
      json(res, 500, { ok: false, error: error.message });
    }
    return true;
  }

  // 人设预览（不保存，只渲染）
  if (pathname === '/api/persona/preview' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      json(res, 200, { preview: renderSystemPrompt({ ...getPersona(), ...body }) });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return true;
  }

  // 场景服装列表
  if (pathname === '/api/outfits' && req.method === 'GET') {
    json(res, 200, {
      scenes: OUTFIT_SCENES,
      outfits: listOutfits(),
      appearance: getPersona().appearance || '',
    });
    return true;
  }

  // 场景服装保存。这里不校验 tag 是否在库里——允许直接手填 tag，
  // 严格校验放在生成流程，因为生成必须依赖词条的中文描述。
  if (pathname === '/api/outfits' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      saveOutfit({ scene: body.scene, name: body.name, tags: body.tags });
      json(res, 200, { ok: true, outfits: listOutfits() });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return true;
  }

  // 场景服装删除：带 id 删单套，带 scene 清空整个场景
  if (pathname === '/api/outfits' && req.method === 'DELETE') {
    try {
      const id = query.get('id');
      if (id) {
        const removed = deleteOutfit(id);
        json(res, 200, { ok: true, removed, outfits: listOutfits() });
        return true;
      }
      const scene = query.get('scene') || '';
      const removed = clearSceneOutfits(scene);
      json(res, 200, { ok: true, removed, outfits: listOutfits() });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return true;
  }

  // 用选中的服装词条生成完整 tag
  if (pathname === '/api/outfits/generate' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const tags = Array.isArray(body.tags) ? body.tags : [];
      const result = await generateOutfitTags({
        scene: body.scene,
        tags,
        brief: String(body.brief || ''),
      });
      json(res, 200, { ok: true, ...result });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return true;
  }

  // 服装库搜索与分类
  if (pathname === '/api/clothing' && req.method === 'GET') {
    json(res, 200, {
      categories: getClothingCategories(),
      items: searchClothing(query.get('q') || '', {
        category: query.get('category') || '',
        limit: Number(query.get('limit') || 60),
      }),
    });
    return true;
  }

  // 会话列表
  if (pathname === '/api/conversations' && req.method === 'GET') {
    json(res, 200, { conversations: listConversations() });
    return true;
  }

  // 记忆列表
  if (pathname === '/api/memories' && req.method === 'GET') {
    const conversationId = query.get('conversation_id') || '';
    const limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 50));
    const offset = Math.max(0, Number(query.get('offset')) || 0);
    json(res, 200, listMemoriesForUi({ conversationId, limit, offset }));
    return true;
  }

  // 删除记忆
  if (pathname === '/api/memories' && req.method === 'DELETE') {
    const memoryId = query.get('memory_id') || '';
    if (!memoryId) {
      json(res, 400, { error: 'memory_id 必填' });
      return true;
    }
    const ok = softDeleteMemory(memoryId);
    json(res, ok ? 200 : 404, { ok });
    return true;
  }

  // 中期记忆
  if (pathname === '/api/mid-term' && req.method === 'GET') {
    const rows = listMidTermForUi(30).map((row) => ({
      ...row,
      recall_cues: safeParseArray(row.recall_cues),
    }));
    json(res, 200, { rows });
    return true;
  }

  // 人物画像
  if (pathname === '/api/profiles' && req.method === 'GET') {
    json(res, 200, { rows: listProfilesForUi(30) });
    return true;
  }

  // 召回审计
  if (pathname === '/api/recall-audit' && req.method === 'GET') {
    json(res, 200, { rows: listRecallAudit(30) });
    return true;
  }

  return false;
}

function safeParseArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 启动 WebUI 服务。
 *
 * @param {object} options
 * @param {number} options.port 监听端口
 */
export function startWebUi({ port = config.webui.port } = {}) {
  const htmlPath = resolve(ROOT, 'src/webui/index.html');

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const pathname = url.pathname;

      if (pathname === '/' || pathname === '/index.html') {
        const html = readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      if (pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, pathname, url.searchParams);
        if (!handled) json(res, 404, { error: '未知接口' });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (error) {
      log.error('请求处理异常:', error.message);
      if (!res.headersSent) json(res, 500, { error: error.message });
    }
  });

  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(port, '127.0.0.1', () => {
      log.info(`WebUI 已启动: http://127.0.0.1:${port}`);
      resolveStart(server);
    });
  });
}
