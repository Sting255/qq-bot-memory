import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DynamicReplyGate, REPLY_WINDOW_SECONDS } from '../src/trigger/dynamic-gate.js';

test('频率为 1 时阈值恒为 0，任何概率都放行', () => {
  const gate = new DynamicReplyGate();
  gate.recordProactiveDemand(0.1, 1000);
  const decision = gate.evaluate(0.05, 1, 1001);
  assert.equal(decision.threshold, 0);
  assert.equal(decision.shouldTrigger, true);
});

test('频率为 0 时阈值恒为 1，任何概率都不放行', () => {
  const gate = new DynamicReplyGate();
  gate.recordProactiveDemand(0.9, 1000);
  const decision = gate.evaluate(0.99, 0, 1001);
  assert.equal(decision.threshold, 1);
  assert.equal(decision.shouldTrigger, false);
});

test('已回复次数超过目标时收紧阈值', () => {
  const gate = new DynamicReplyGate();
  const now = 1000;
  // 造 30 个高概率轮次，累计预计回复数
  for (let i = 0; i < 30; i += 1) {
    gate.recordProactiveDemand(0.9, now + i * 50);
    gate.closeRound();
  }
  const before = gate.evaluate(0.5, 0.05, now + 2000);

  // 模拟实际回复远超目标
  for (let i = 0; i < 20; i += 1) {
    gate.recordReply(now + 2100 + i);
  }
  const after = gate.evaluate(0.5, 0.05, now + 2200);

  assert.ok(after.keepRatio <= before.keepRatio, '超出目标后保留比例应收紧');
  assert.ok(after.threshold >= before.threshold, '阈值应上升');
});

test('只收紧不放宽：预计数上升但实际未跟上时不会放宽', () => {
  const gate = new DynamicReplyGate();
  const now = 5000;
  gate.recordProactiveDemand(0.8, now);
  const first = gate.evaluate(0.8, 0.1, now + 1);

  // 再来一批高概率消息，实际回复没增加
  gate.recordProactiveDemand(0.9, now + 50);
  const second = gate.evaluate(0.9, 0.1, now + 51);

  assert.ok(second.threshold >= first.threshold - 1e-9, '阈值不应因新需求而下降');
});

test('@ 强制触发默认不计入回复额度', () => {
  const gate = new DynamicReplyGate();
  const now = 8000;
  gate.recordProactiveDemand(0.5, now);
  gate.recordForcedTurn(now + 10);
  const decision = gate.evaluate(0.5, 0.05, now + 20);
  assert.equal(decision.expectedReplies, decision.expectedReplies);
  // expectedForced 为 0，所以预计回复数只来自主动需求
  assert.ok(Math.abs(decision.expectedReplies - 0.5) < 1e-9, `预计回复应只含主动部分，实际 ${decision.expectedReplies}`);
});

test('开启 countForcedTurns 后 @ 计入额度', () => {
  const gate = new DynamicReplyGate({ countForcedTurns: true });
  const now = 9000;
  gate.recordProactiveDemand(0.5, now);
  gate.recordForcedTurn(now + 10);
  const decision = gate.evaluate(0.5, 0.05, now + 20);
  assert.ok(decision.expectedReplies > 0.5, '应包含强制触发预期');
});

test('窗口外的旧记录会被清理', () => {
  const gate = new DynamicReplyGate();
  const now = 20000;
  gate.recordProactiveDemand(0.9, now);
  gate.recordReply(now + 1);
  const fresh = gate.evaluate(0.5, 0.5, now + 10);
  const later = gate.evaluate(0.5, 0.5, now + REPLY_WINDOW_SECONDS + 100);
  assert.equal(later.actualReplies, 0, '窗口外回复记录应被清理');
  assert.ok(later.expectedReplies < fresh.expectedReplies, '窗口外需求应被清理');
});

test('消息 ID 去重：同一批只计入一次', () => {
  const gate = new DynamicReplyGate();
  const first = gate.takeUncountedMessageIds(['a', 'b', 'c']);
  assert.deepEqual(first, ['a', 'b', 'c']);
  const second = gate.takeUncountedMessageIds(['a', 'b', 'd']);
  assert.deepEqual(second, ['d'], '已计入的消息不应重复返回');
});
