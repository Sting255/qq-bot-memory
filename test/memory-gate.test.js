import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateWriteValue,
  memoryRetention,
  gateAction,
  evaluateForgetGate,
  HALF_LIFE_BASE_DAYS,
  MAX_IMPORTANCE,
} from '../src/memory/gate.js';

// ── 写入门 ──

test('写入门：空洞短句只得基础分', () => {
  assert.equal(estimateWriteValue({ judgment: '他们聊了游戏' }), 1);
});

test('写入门：含具体数字/偏好加分', () => {
  const withFact = estimateWriteValue({ judgment: '小明喜欢吃辣，最爱重庆火锅' });
  const plain = estimateWriteValue({ judgment: '他们聊了吃饭' });
  assert.ok(withFact > plain, `${withFact} 应大于 ${plain}`);
});

test('写入门：长判断句信息量更高', () => {
  const long = estimateWriteValue({ judgment: '老王明年打算搬去成都，因为女朋友在那边工作，已经看好了房子' });
  const short = estimateWriteValue({ judgment: '老王要搬家' });
  assert.ok(long > short);
});

test('写入门：情绪类记忆加权', () => {
  const emotion = estimateWriteValue({ judgment: '他今天心情很差，被领导骂了', memoryType: 'emotion' });
  const knowledge = estimateWriteValue({ judgment: '他今天心情很差，被领导骂了', memoryType: 'knowledge' });
  assert.ok(emotion > knowledge);
});

test('写入门：分数封顶', () => {
  const v = estimateWriteValue({
    judgment: '小明今年 25 岁，喜欢吃辣，总是熬夜，住在杭州，在做程序员，每次都说要减肥但从不行动',
    memoryType: 'emotion',
  });
  assert.ok(v <= MAX_IMPORTANCE);
});

// ── 遗忘门 ──

test('遗忘门：刚写的记忆保留度高', () => {
  const r = memoryRetention({ importance: 3, ageDays: 0 });
  assert.equal(r, 3);
});

test('遗忘门：经过一个半衰期剩一半', () => {
  // importance 3 是中性基准，半衰期 = 基准 30 天 × (0.5 + 3/3) = 45 天
  const halfLife = HALF_LIFE_BASE_DAYS * 1.5;
  const r = memoryRetention({ importance: 3, recallCount: 0, ageDays: halfLife });
  assert.ok(Math.abs(r - 1.5) < 0.01, `期望 1.5，实际 ${r}`);
});

test('遗忘门：召回次数延长半衰期', () => {
  const fresh = memoryRetention({ importance: 3, recallCount: 0, ageDays: 90 });
  const recalled = memoryRetention({ importance: 3, recallCount: 3, ageDays: 90 });
  assert.ok(recalled > fresh, '常被想起的应该活得更久');
});

test('遗忘门：重要记忆比琐碎记忆活得久', () => {
  const important = memoryRetention({ importance: 5, ageDays: 120 });
  const trivial = memoryRetention({ importance: 1, ageDays: 120 });
  assert.ok(important > trivial);
});

test('gateAction 分档正确（降权用相对阈值）', () => {
  assert.equal(gateAction(2, 3), 'keep');      // 高于重要度一半
  assert.equal(gateAction(0.6, 3), 'demote');  // 跌破一半但未到退役线
  assert.equal(gateAction(0.1, 3), 'retire');  // 低于绝对退役线
  assert.equal(gateAction(0.87, 1), 'keep');   // 低分记忆不会刚写就被降权
});

test('evaluateForgetGate 按保留度分流', () => {
  const rows = [
    { memory_id: 'keep1', importance: 5, recalled_count: 2, age_days: 10 },
    { memory_id: 'demote1', importance: 1, recalled_count: 0, age_days: 30 },
    { memory_id: 'retire1', importance: 1, recalled_count: 0, age_days: 200 },
  ];
  const { keep, demote, retire } = evaluateForgetGate(rows);
  assert.equal(keep, 1);
  assert.deepEqual(demote, ['demote1']);
  assert.deepEqual(retire, ['retire1']);
});

test('evaluateForgetGate 空输入不报错', () => {
  assert.deepEqual(evaluateForgetGate([]), { retire: [], demote: [], keep: 0 });
});
