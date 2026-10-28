import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PipelineContext, runPipeline } from '../src/pipeline/index.js';

function makeCtx(overrides = {}) {
  return new PipelineContext({
    message: { conversationId: 'g1', isGroup: true, text: 'hi', messageId: 'm1', senderId: 'u1', ...overrides },
    client: { selfId: '10000' },
    ...overrides.client ? { client: overrides.client } : {},
    options: {},
  });
}

test('空 stage 数组直接返回 ctx', async () => {
  const ctx = makeCtx();
  const out = await runPipeline(ctx, []);
  assert.equal(out, ctx);
});

test('stage 按顺序执行并通过 state 传数据', async () => {
  const order = [];
  const stages = [
    { name: 'a', run: (ctx) => { order.push('a'); ctx.state.foo = 1; } },
    { name: 'b', run: async (ctx) => { order.push('b'); ctx.state.bar = ctx.state.foo + 1; } },
  ];
  const ctx = makeCtx();
  await runPipeline(ctx, stages);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(ctx.state.bar, 2);
});

test('skip 为 true 的 stage 被跳过', async () => {
  const order = [];
  const stages = [
    { name: 'a', skip: () => true, run: () => order.push('a') },
    { name: 'b', run: () => order.push('b') },
  ];
  await runPipeline(makeCtx(), stages);
  assert.deepEqual(order, ['b']);
});

test('stage 抛错中断后续 stage', async () => {
  const order = [];
  const stages = [
    { name: 'a', run: () => { order.push('a'); throw new Error('boom'); } },
    { name: 'b', run: () => order.push('b') },
  ];
  await assert.rejects(() => runPipeline(makeCtx(), stages), /boom/);
  assert.deepEqual(order, ['a']);
});

test('aborted 后不再执行任何 stage', async () => {
  const order = [];
  const stages = [
    { name: 'a', run: (ctx) => { order.push('a'); ctx.aborted = true; } },
    { name: 'b', run: () => order.push('b') },
  ];
  await runPipeline(makeCtx(), stages);
  assert.deepEqual(order, ['a']);
});

test('timings 记录每个 stage 耗时', async () => {
  const stages = [{ name: 'slow', run: async () => { await new Promise((r) => setTimeout(r, 20)); } }];
  const ctx = makeCtx();
  await runPipeline(ctx, stages);
  assert.ok(ctx.timings.slow >= 15);
});
