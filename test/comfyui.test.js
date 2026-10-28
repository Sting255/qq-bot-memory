import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const { applyBindings, parseSize, loadWorkflow } = await import('../src/chat/comfyui.js');

const tmpDir = mkdtempSync(resolve(tmpdir(), 'comfy-'));
test.after(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeWorkflow() {
  return {
    4: { class_type: 'CLIPTextEncode', inputs: { text: 'old positive' } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: 'old negative' } },
    7: { class_type: 'EmptySD3LatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    8: { class_type: 'KSampler', inputs: { seed: 42, steps: 8, cfg: 1 } },
  };
}

test('applyBindings 按声明写入对应节点字段', () => {
  const wf = makeWorkflow();
  applyBindings(wf, { positive: '一只猫', negative: '低质量', width: 832, height: 1216, steps: 28, cfg: 5, seed: 123 }, {
    positive: { node: '4', input: 'text' },
    negative: { node: '5', input: 'text' },
    width: { node: '7', input: 'width' },
    height: { node: '7', input: 'height' },
    steps: { node: '8', input: 'steps' },
    cfg: { node: '8', input: 'cfg' },
    seed: { node: '8', input: 'seed' },
  });
  assert.equal(wf[4].inputs.text, '一只猫');
  assert.equal(wf[5].inputs.text, '低质量');
  assert.equal(wf[7].inputs.width, 832);
  assert.equal(wf[7].inputs.height, 1216);
  assert.equal(wf[8].inputs.steps, 28);
  assert.equal(wf[8].inputs.cfg, 5);
  assert.equal(wf[8].inputs.seed, 123);
});

test('applyBindings 跳过空值，保留工作流原值', () => {
  const wf = makeWorkflow();
  applyBindings(wf, { positive: '', negative: undefined }, {
    positive: { node: '4', input: 'text' },
    negative: { node: '5', input: 'text' },
  });
  assert.equal(wf[4].inputs.text, 'old positive');
  assert.equal(wf[5].inputs.text, 'old negative');
});

test('applyBindings 遇到不存在的节点不抛错', () => {
  const wf = makeWorkflow();
  assert.doesNotThrow(() => applyBindings(wf, { positive: 'x' }, {
    positive: { node: '999', input: 'text' },
  }));
  assert.equal(wf[4].inputs.text, 'old positive');
});

test('parseSize 支持 x 与 ×', () => {
  assert.deepEqual(parseSize('832x1216'), { width: 832, height: 1216 });
  assert.deepEqual(parseSize('1024×1024'), { width: 1024, height: 1024 });
  assert.deepEqual(parseSize('乱写', { width: 1, height: 2 }), { width: 1, height: 2 });
});

test('loadWorkflow 读取 API 格式并返回独立副本', () => {
  const p = resolve(tmpDir, 'wf.json');
  writeFileSync(p, JSON.stringify(makeWorkflow()), 'utf8');
  const a = loadWorkflow(p);
  a[4].inputs.text = '被改了';
  const b = loadWorkflow(p);
  assert.equal(b[4].inputs.text, 'old positive', '第二次读取不应受上次修改影响');
});

test('loadWorkflow 拒绝不存在的文件', () => {
  assert.throws(() => loadWorkflow(resolve(tmpDir, 'nope.json')), /找不到 ComfyUI 工作流/);
});
