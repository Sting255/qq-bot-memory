/**
 * 主入口：启动向量服务、OneBot 连接、消息处理与记忆索引。
 *
 * QQ 号自动获取：连接成功后调 get_login_info，不需要手工填 self_id。
 * 向量服务默认托管：由本进程负责拉起与退出，也可配置为外部已有服务。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { config, ensureDirs } from './config.js';
import { createLogger, cleanupOldLogs } from './logger.js';
import { OneBotClient } from './adapters/onebot-client.js';
import { MessageHandler } from './chat/handler.js';
import { getDb, stats } from './memory/store.js';
import { healthCheck } from './memory/vector-client.js';
import { migrateLegacyPrompt } from './chat/persona.js';
import { startWebUi, setRuntimeState } from './webui/server.js';

const log = createLogger('main');

/** 托管的向量服务进程。 */
let vectorProcess = null;

/** 托管的 NapCat 进程。 */
let napcatProcess = null;

/**
 * 读取 NapCat WebUI 的连接信息。
 *
 * NapCat 首次启动会生成随机 token 写入 napcat/config/webui.json，
 * 之后固定不变。面板需要带 token 才能直接登录。
 */
function readNapCatWebUiInfo() {
  const configPath = resolve(config.root, 'NapCat.Shell/napcat/config/webui.json');
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const port = Number(raw?.port) || 6099;
    const token = String(raw?.token || '');
    if (!token) return null;
    return { port, token, url: `http://127.0.0.1:${port}/webui?token=${token}` };
  } catch {
    return null;
  }
}

/**
 * 用系统默认浏览器打开一个地址。
 *
 * 用 spawn 传数组参数而不是 exec 拼字符串：
 * exec 走 shell 解析，URL 里的 & ? = 容易被转义坏掉，
 * 实测 `exec('start "" "url"')` 会报 Access is denied。
 *
 * 失败只记日志，不影响主流程。
 */
function openBrowser(url) {
  if (!url) return;
  try {
    if (process.platform === 'win32') {
      // start 的第一个参数是窗口标题（必须给空串，否则会把 URL 当标题）
      const child = spawn('cmd', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', (error) => log.debug(`打开浏览器失败: ${error.message}`));
      child.unref();
    } else if (process.platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
      child.on('error', (error) => log.debug(`打开浏览器失败: ${error.message}`));
      child.unref();
    } else {
      const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
      child.on('error', (error) => log.debug(`打开浏览器失败: ${error.message}`));
      child.unref();
    }
  } catch (error) {
    log.debug(`打开浏览器异常: ${error.message}`);
  }
}

/**
 * 启动 NapCat（QQ 协议端）。
 *
 * NapCat 自带 node.exe 与 wrapper.node，不需要外部 QQ 客户端。
 * 用 -q 传入 QQ 号走快速登录，避免每次扫码。
 */
function startNapCat() {
  const napcatDir = resolve(config.root, 'NapCat.Shell');
  const napcatNode = resolve(napcatDir, 'node.exe');
  const napcatIndex = resolve(napcatDir, 'index.js');

  if (!existsSync(napcatNode) || !existsSync(napcatIndex)) {
    log.error(`NapCat 缺失: ${napcatDir}`);
    log.error('请确认 NapCat.Shell 目录完整，或改用外部启动 NapCat');
    return null;
  }

  const args = [napcatIndex];
  if (config.onebot.selfId && config.onebot.selfId !== '0') {
    args.push('-q', String(config.onebot.selfId));
  }

  log.info(`正在启动 NapCat${args.length > 1 ? ` (快速登录 ${config.onebot.selfId})` : '（需扫码登录）'}`);

  const child = spawn(napcatNode, args, {
    cwd: napcatDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  child.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      const text = line.trim();
      if (!text) continue;
      // 二维码与登录提示直接透传，用户需要看到
      if (/二维码|扫码|登录|WebUi|Token/i.test(text)) log.info('[napcat]', text);
      else log.debug('[napcat]', text);
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (!text) return;
    if (/error|fail|异常|失败/i.test(text)) log.error('[napcat]', text);
    else log.debug('[napcat]', text);
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) log.error(`NapCat 异常退出 code=${code}`);
    else log.info('NapCat 已停止');
    napcatProcess = null;
  });

  return child;
}

/** 等待 OneBot WebSocket 端口就绪。 */
async function waitForNapCat(timeoutMs = 120000) {
  const { default: net } = await import('node:net');
  const url = new URL(config.onebot.wsUrl);
  const host = url.hostname || '127.0.0.1';
  const port = Number(url.port || 3001);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const reachable = await new Promise((resolveCheck) => {
      const socket = net.connect({ host, port });
      socket.setTimeout(1000);
      socket.once('connect', () => { socket.destroy(); resolveCheck(true); });
      socket.once('timeout', () => { socket.destroy(); resolveCheck(false); });
      socket.once('error', () => { socket.destroy(); resolveCheck(false); });
    });
    if (reachable) {
      log.info(`NapCat 就绪 (${Date.now() - startedAt}ms)`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/**
 * 启动向量服务（托管模式）。
 *
 * 复用 vector-service 目录下的 Python 环境与 ONNX 模型，
 * 不需要外部先手动启动。
 */
function startVectorService() {
  const serviceDir = resolve(config.root, 'vector-service');
  const pythonExe = resolve(serviceDir, 'python/python.exe');
  const serverPy = resolve(serviceDir, 'server.py');

  if (!existsSync(pythonExe)) {
    log.error(`向量服务 Python 环境缺失: ${pythonExe}`);
    return null;
  }
  if (!existsSync(serverPy)) {
    log.error(`向量服务代码缺失: ${serverPy}`);
    return null;
  }

  const port = new URL(config.vector.url).port || '8765';
  log.info(`正在启动向量服务 (port=${port})`);

  const child = spawn(
    pythonExe,
    ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', port],
    {
      cwd: serviceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1' },
    },
  );

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) log.debug('[vector]', text);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    // uvicorn 把启动日志写 stderr，只在出错时提级
    if (/error|traceback|exception/i.test(text)) log.error('[vector]', text);
    else log.debug('[vector]', text);
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) log.error(`向量服务异常退出 code=${code}`);
    else log.info('向量服务已停止');
    vectorProcess = null;
  });

  return child;
}

/**
 * 检测是否已有本程序实例在运行。
 *
 * 查 WebUI 的 /api/status 接口：只有本程序才有这个响应结构。
 * 返回实例描述（如「WebUI :3099」），没有则返回 null。
 */
async function detectRunningInstance() {
  const port = config.webui.port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // 用响应里的独有字段确认是本程序，而不是别的服务占了同端口
    if (data?.runtime && data?.stats && data?.trigger) {
      const selfId = data.runtime.selfId || '未登录';
      return `WebUI :${port}，账号 ${selfId}`;
    }
  } catch {
    // 连不上说明没在跑
  }
  return null;
}

/** 等待向量服务就绪。 */
async function waitForVectorService(timeoutMs = 90000) {  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const health = await healthCheck();
    if (health.reachable) {
      log.info(`向量服务就绪 (${Date.now() - startedAt}ms)`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function validateConfig() {
  const problems = [];
  if (!config.llm.baseUrl) problems.push('llm.base_url 未配置');
  if (!config.llm.model) problems.push('llm.model 未配置');

  // 频率为 0 会导致静默消费排在强制触发之前，@ 也不会回
  if (config.trigger.frequency <= 0) {
    problems.push('trigger.frequency 不能为 0：频率为 0 时 @ 和提及也不会回复，建议至少 0.01');
  }
  if (config.trigger.frequency > 1) {
    problems.push('trigger.frequency 不能大于 1');
  }
  return problems;
}

async function main() {
  ensureDirs();
  // 日志按天切分，启动时清掉 7 天前的，顺便把旧的单文件迁移到当天
  const removedLogs = cleanupOldLogs();
  log.info('=== qq-bot-memory 启动 ===');
  if (removedLogs > 0) log.info(`已清理 ${removedLogs} 个过期日志`);
  // 单实例检查：已经有本程序在跑就不重复启动。
  // 多实例会同时消费同一条消息，导致重复回复和唯一约束冲突。
  const alreadyRunning = await detectRunningInstance();
  if (alreadyRunning) {
    log.error(`检测到已有实例在运行（${alreadyRunning}）`);
    log.error('如需重启，请先关闭已有窗口，或结束占用该端口的进程');
    process.exit(1);
  }

  const problems = validateConfig();
  if (problems.length > 0) {
    for (const problem of problems) log.error('配置问题:', problem);
    log.error('请修改 config.yaml 后重新启动');
    process.exit(1);
  }

  // 数据库
  getDb();
  const initialStats = stats();
  log.info(`数据库: 消息 ${initialStats.rawMessages} 条, 记忆 ${initialStats.memories} 条, 待索引 ${initialStats.pendingJobs}`);

  // 首次运行时把旧 prompt.md 的内容迁进人设表
  try {
    const migration = migrateLegacyPrompt();
    if (migration.migrated) log.info('已迁移旧人设到数据库');
  } catch (error) {
    log.warn('人设迁移跳过:', error.message);
  }

  // 向量服务：托管启动或复用已运行的实例
  const existing = await healthCheck();
  if (existing.reachable) {
    log.info(`检测到已运行的向量服务，直接复用 (count=${existing.collection_count ?? 0})`);
  } else if (config.vector.autoStart) {
    vectorProcess = startVectorService();
    const ready = await waitForVectorService();
    if (ready) {
      const health = await healthCheck();
      log.info(`向量服务已连接 (count=${health.collection_count ?? 0})`);
    } else {
      log.warn('向量服务启动超时，记忆召回将降级到近期记忆');
    }
  } else {
    log.warn(`向量服务不可达 (${config.vector.url})，记忆召回将降级到近期记忆`);
  }

  // OneBot 客户端
  const client = new OneBotClient({
    wsUrl: config.onebot.wsUrl,
    accessToken: config.onebot.accessToken,
    reconnectBaseSec: config.onebot.reconnectBaseSec,
    reconnectMaxSec: config.onebot.reconnectMaxSec,
  });

  // NapCat：托管启动或复用已运行的实例
  if (config.onebot.autoStart) {
    const { default: net } = await import('node:net');
    const url = new URL(config.onebot.wsUrl);
    const probeHost = url.hostname || '127.0.0.1';
    const probePort = Number(url.port || 3001);
    const already = await new Promise((resolveCheck) => {
      const socket = net.connect({ host: probeHost, port: probePort });
      socket.setTimeout(800);
      socket.once('connect', () => { socket.destroy(); resolveCheck(true); });
      socket.once('timeout', () => { socket.destroy(); resolveCheck(false); });
      socket.once('error', () => { socket.destroy(); resolveCheck(false); });
    });

    if (already) {
      log.info(`检测到 NapCat 已在运行 (${probeHost}:${probePort})，直接复用`);
    } else {
      napcatProcess = startNapCat();
      if (napcatProcess) {
        const ready = await waitForNapCat();
        if (!ready) {
          log.warn('NapCat 启动超时，请检查 NapCat 窗口是否有报错或需要扫码');
        }
      }
    }
  } else {
    log.info('NapCat 由外部管理，直接连接');
  }

  const handler = new MessageHandler({ client });
  handler.start();

  // WebUI 管理面板
  let webuiServer = null;
  if (config.webui.enabled) {
    try {
      webuiServer = await startWebUi({ port: config.webui.port });
      setRuntimeState({
        startedAt: Date.now(),
        vectorManaged: Boolean(vectorProcess),
        napcatManaged: Boolean(napcatProcess),
      });
    } catch (error) {
      log.error(`WebUI 启动失败 (port=${config.webui.port}):`, error.message);
      log.error('端口可能被占用，改 config.yaml 里的 webui.port 或设 webui.enabled=false');
    }
  }

  // 连接就绪后自动获取 QQ 号
  client.onReady(async () => {
    try {
      const info = await client.getLoginInfo();
      const selfId = String(info?.user_id ?? '');
      if (!selfId) throw new Error('get_login_info 未返回 user_id');
      handler.setSelfId(selfId);
      setRuntimeState({
        onebotConnected: true,
        selfId,
        selfName: String(info?.nickname ?? ''),
      });
      log.info(`已连接账号: ${info?.nickname ?? '未知昵称'} (${selfId})`);
      log.info(`回复频率=${config.trigger.frequency} @必回=${config.trigger.replyOnAt} 提及必回=${config.trigger.replyOnMention}`);
    } catch (error) {
      log.error('获取登录账号失败:', error.message);
      log.error('请检查 NapCat 是否已登录 QQ，或手工在 config.yaml 填 onebot.self_id');
    }
  });

  client.onMessage((event) => handler.handleEvent(event));
  client.connect();

  // 服务全部就绪后自动打开面板
  if (config.webui.enabled && config.webui.autoOpen) {
    setTimeout(() => {
      const panelUrl = `http://127.0.0.1:${config.webui.port}`;
      log.info(`自动打开管理面板: ${panelUrl}`);
      openBrowser(panelUrl);

      // NapCat WebUI 需要 token，从它自己的配置里读
      const napcatUi = readNapCatWebUiInfo();
      if (napcatUi) {
        setTimeout(() => {
          log.info(`自动打开 NapCat 控制台: http://127.0.0.1:${napcatUi.port}/webui`);
          openBrowser(napcatUi.url);
        }, 800);
      } else {
        log.debug('未读到 NapCat WebUI token，跳过自动打开');
      }
    }, 3000);
  }

  const shutdown = (signal) => {
    log.info(`收到 ${signal}，正在退出`);
    handler.stop();
    client.close();
    setRuntimeState({ onebotConnected: false });
    if (webuiServer) {
      webuiServer.close();
      webuiServer = null;
    }
    if (napcatProcess) {
      log.info('正在停止 NapCat');
      napcatProcess.kill();
      napcatProcess = null;
    }
    if (vectorProcess) {
      log.info('正在停止向量服务');
      vectorProcess.kill();
      vectorProcess = null;
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error('未处理的 Promise 拒绝:', reason instanceof Error ? reason.message : String(reason));
  });
  process.on('uncaughtException', (error) => {
    log.error('未捕获异常:', error.message);
  });
}

main().catch((error) => {
  log.error('启动失败:', error.message);
  if (vectorProcess) vectorProcess.kill();
  process.exit(1);
});
