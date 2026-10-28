import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const { generateWithComfyUI } = await import('../src/chat/comfyui.js');

const tmpDir = mkdtempSync(resolve(tmpdir(), 'comfy-e2e-'));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * 起一个假的 ComfyUI：只实现本项目用到的三个接口。
 * 目的是验证真实客户端代码的协议流程（提交 → 轮询 → 下载），
 * 不涉及模型推理本身。
 */
async function startFakeComfy({ failOnSubmit = false, neverFinish = false } = {}) {
  const state = { submitted: null, polls: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'POST' && url.pathname === '/prompt') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (failOnSubmit) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad workflow' }));
          return;
        }
        state.submitted = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ prompt_id: 'test-prompt-1', number: 1 }));
      });
      return;
    }

    if (url.pathname === '/history/test-prompt-1') {
      state.polls += 1;
      // 第一次查询故意返回空，模拟「任务还在跑」，验证轮询逻辑
      if (neverFinish || state.polls === 1) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        'test-prompt-1': {
          status: { status_str: 'success', completed: true },
          outputs: { 10: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
        },
      }));
      return;
    }

    if (url.pathname === '/view') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG);
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { server, port, state, close: () => new Promise((r) => server.close(r)) };
}

function writeWorkflow(name, obj) {
  const p = resolve(tmpDir, name);
  writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}

const BINDINGS = {
  positive: { node: '4', input: 'text' },
  negative: { node: '5', input: 'text' },
  width: { node: '7', input: 'width' },
  height: { node: '7', input: 'height' },
  steps: { node: '8', input: 'steps' },
  cfg: { node: '8', input: 'cfg' },
  seed: { node: '8', input: 'seed' },
};

const WORKFLOW = () => ({
  4: { class_type: 'CLIPTextEncode', inputs: { text: '' } },
  5: { class_type: 'CLIPTextEncode', inputs: { text: '' } },
  7: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  8: { class_type: 'KSampler', inputs: { seed: 1, steps: 8, cfg: 1 } },
  10: { class_type: 'SaveImage', inputs: { filename_prefix: 'test' } },
});

test.after(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('端到端：提交工作流 → 轮询 → 下载图片', async () => {
  const fake = await startFakeComfy();
  try {
    const workflow = writeWorkflow('ok.api.json', WORKFLOW());
    const buf = await generateWithComfyUI({
      prompt: '一只橘猫',
      negativePrompt: '低质量',
      cfg: {
        baseUrl: `http://127.0.0.1:${fake.port}`,
        workflow,
        bindings: BINDINGS,
        timeoutMs: 15000,
      },
      steps: 28,
      cfgScale: 5,
      size: '832x1216',
    });

    assert.ok(Buffer.isBuffer(buf), '应返回 Buffer');
    assert.ok(buf.length > 0, '图片不应为空');
    assert.equal(buf.subarray(1, 4).toString(), 'PNG', '应是 PNG 数据');

    // 提交出去的工作流参数要对
    const sent = fake.state.submitted.prompt;
    assert.equal(sent[4].inputs.text, '一只橘猫', '正向提示词应写入节点 4');
    assert.equal(sent[5].inputs.text, '低质量', '负向提示词应写入节点 5');
    assert.equal(sent[7].inputs.width, 832, '宽度应写入节点 7');
    assert.equal(sent[7].inputs.height, 1216, '高度应写入节点 7');
    assert.equal(sent[8].inputs.steps, 28, '步数应写入节点 8');
    assert.equal(sent[8].inputs.cfg, 5, 'cfg 应写入节点 8');
    assert.ok(Number.isInteger(sent[8].inputs.seed), 'seed 应是整数');
    assert.equal(fake.state.submitted.client_id.startsWith('qq-bot-'), true, '应带 client_id');
    assert.ok(fake.state.polls >= 2, '空 history 后应继续轮询');
  } finally {
    await fake.close();
  }
});

test('ComfyUI 提交失败时报错清晰', async () => {
  const fake = await startFakeComfy({ failOnSubmit: true });
  try {
    const workflow = writeWorkflow('bad.api.json', WORKFLOW());
    await assert.rejects(
      () => generateWithComfyUI({
        prompt: 'x',
        cfg: {
          baseUrl: `http://127.0.0.1:${fake.port}`,
          workflow,
          bindings: BINDINGS,
          timeoutMs: 5000,
        },
      }),
      /ComfyUI 提交失败 400/
    );
  } finally {
    await fake.close();
  }
});

test('出图超时给出明确提示', async () => {
  const fake = await startFakeComfy({ neverFinish: true });
  try {
    const workflow = writeWorkflow('slow.api.json', WORKFLOW());
    await assert.rejects(
      () => generateWithComfyUI({
        prompt: 'x',
        cfg: {
          baseUrl: `http://127.0.0.1:${fake.port}`,
          workflow,
          bindings: BINDINGS,
          timeoutMs: 2500,
        },
      }),
      /ComfyUI 出图超时/
    );
  } finally {
    await fake.close();
  }
});

test('ComfyUI 未启动时提示连接失败', async () => {
  const workflow = writeWorkflow('nf.api.json', WORKFLOW());
  await assert.rejects(
    () => generateWithComfyUI({
      prompt: 'x',
      cfg: {
        baseUrl: 'http://127.0.0.1:1', // 必然连不上
        workflow,
        bindings: BINDINGS,
        timeoutMs: 3000,
      },
    }),
    /ComfyUI 连接失败/
  );
});
