import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmartDebouncer, QUIET_THRESHOLD_SEC } from '../src/trigger/debounce.js';

const W = { quietSec: 2, activeSec: 5, sameAuthorSec: 2, differentAuthorSec: 0.5, mentionLimitSec: 1, batchLimitSec: 8, bareImageSec: 4 };

test('安静开批：等 quietSec', () => {
  const d = new SmartDebouncer(W);
  const r = d.observe({ author: 'a', now: 100 });
  assert.equal(r.deadline, 102);
  assert.match(r.reason, /安静开批 2s/);
});

test('活跃开批：上一条距今 ≤ 阈值时等 activeSec', () => {
  const d = new SmartDebouncer(W);
  d.observe({ author: 'a', now: 100 });
  d.consume();
  const r = d.observe({ author: 'b', now: 100 + QUIET_THRESHOLD_SEC });
  assert.equal(r.deadline, 100 + QUIET_THRESHOLD_SEC + 5);
  assert.match(r.reason, /活跃开批 5s/);
});

test('同人续发等更久，换人等更短', () => {
  const d = new SmartDebouncer(W);
  d.observe({ author: 'a', now: 100 });
  const same = d.observe({ author: 'a', now: 101 });
  assert.equal(same.deadline, 103); // 101 + 2
  const diff = d.observe({ author: 'b', now: 101.5 });
  assert.equal(diff.deadline, 102); // 101.5 + 0.5
  assert.match(diff.reason, /换人 0\.5s/);
});

test('@ 机器人压缩整批截止到 1 秒', () => {
  const d = new SmartDebouncer(W);
  d.observe({ author: 'a', now: 100 }); // deadline 102（未到期）
  const r = d.observe({ author: 'c', atBot: true, now: 101 });
  // urgent = 101+1 = 102；换人候选 101.5；min(101.5, 102, 108) = 101.5
  assert.equal(r.deadline, 101.5);
});

test('整批 8 秒硬上限', () => {
  const d = new SmartDebouncer(W);
  let r = d.observe({ author: 'a', now: 100 }); // 批起点 100，上限 108
  assert.equal(r.deadline, 102);
  // 批到期前（102 > 101）同人续发：候选 101+2=103
  r = d.observe({ author: 'a', now: 101 });
  assert.equal(r.deadline, 103);
  r = d.observe({ author: 'a', now: 103 }); // deadline 103 已到期 → 本批封在 103
  assert.equal(r.deadline, 103);
  assert.match(r.reason, /已到期/);
  d.consume();
  // 新批验证上限：起点 200，上限 208（续发需在到期前推进）
  r = d.observe({ author: 'a', now: 200 });   // deadline 202
  r = d.observe({ author: 'a', now: 201 });   // 候选 203
  assert.equal(r.deadline, 203);
  r = d.observe({ author: 'a', now: 202.5 }); // 候选 204.5
  assert.equal(r.deadline, 204.5);
  r = d.observe({ author: 'a', now: 204 });   // 候选 206
  r = d.observe({ author: 'a', now: 205.9 }); // 候选 207.9
  r = d.observe({ author: 'a', now: 207.5 }); // 候选 209.5 > 208 → 封顶
  assert.equal(r.deadline, 208);
  assert.match(r.reason, /上限/);
});

test('裸图开批至少 4 秒', () => {
  const d = new SmartDebouncer(W);
  const r = d.observe({ author: 'a', isBareImage: true, now: 100 });
  assert.equal(r.deadline, 104);
});

test('纯表情只提前不推迟', () => {
  const d = new SmartDebouncer(W);
  d.observe({ author: 'a', now: 100 }); // deadline 102
  const r = d.observe({ author: 'a', isPureEmoji: true, now: 100.2 });
  // 同人续发候选 100.2+2=102.2 > 已有 102 → 不延长
  assert.equal(r.deadline, 102);
});

test('批次到期后新消息不再延长', () => {
  const d = new SmartDebouncer(W);
  d.observe({ author: 'a', now: 100 }); // deadline 102
  const r = d.observe({ author: 'a', now: 103 });
  assert.equal(r.deadline, 102);
  assert.match(r.reason, /已到期/);
});

test('consume 后重开新批且保留活跃/同人信息', () => {
  const d = new SmartDebouncer(W);
  d.observe({ author: 'a', now: 100 });
  d.consume();
  assert.equal(d.hasBatch, false);
  const r = d.observe({ author: 'a', now: 101 });
  assert.match(r.reason, /活跃开批/); // 上一条 1 秒前，活跃
});

test('due 判定', () => {
  const d = new SmartDebouncer(W);
  assert.equal(d.due(100), false);
  d.observe({ author: 'a', now: 100 });
  assert.equal(d.due(101.9), false);
  assert.equal(d.due(102), true);
});
