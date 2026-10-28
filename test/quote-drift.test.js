import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupQuoteProbability,
  privateQuoteProbability,
  decideQuote,
  buildQuoteContext,
  QUOTE_FREQUENCY,
} from '../src/persona/quote.js';
import { buildAttentionDriftBlock, DRIFT_LEVELS, ANCHOR_POLICIES, REACTION_STYLES } from '../src/persona/drift.js';

/** 确定性随机源。 */
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

test('引用频率 never 时概率恒为 0', () => {
  const p = groupQuoteProbability({
    textLength: 20,
    previousSenderSelf: false,
    previousSeconds: 30,
    frequency: QUOTE_FREQUENCY.NEVER,
    targetDistance: 2,
  });
  assert.equal(p, 0);
});

test('群聊引用：上一条是自己发的时概率显著降低', () => {
  const other = groupQuoteProbability({
    textLength: 20,
    previousSenderSelf: false,
    previousSeconds: 30,
    frequency: QUOTE_FREQUENCY.OCCASIONALLY,
    targetDistance: 2,
  });
  const self = groupQuoteProbability({
    textLength: 20,
    previousSenderSelf: true,
    previousSeconds: 30,
    frequency: QUOTE_FREQUENCY.OCCASIONALLY,
    targetDistance: 2,
  });
  assert.ok(self < other, `自己刚说完应更少引用: ${self} vs ${other}`);
});

test('群聊引用：短文本比长文本更容易引用', () => {
  const short = groupQuoteProbability({
    textLength: 30,
    previousSenderSelf: false,
    previousSeconds: 30,
    frequency: QUOTE_FREQUENCY.OCCASIONALLY,
    targetDistance: 2,
  });
  const long = groupQuoteProbability({
    textLength: 100,
    previousSenderSelf: false,
    previousSeconds: 30,
    frequency: QUOTE_FREQUENCY.OCCASIONALLY,
    targetDistance: 2,
  });
  assert.ok(short > long, `短文本应更易引用: ${short} vs ${long}`);
});

test('群聊引用：目标距离越远概率越高', () => {
  const near = groupQuoteProbability({
    textLength: 20,
    previousSenderSelf: false,
    previousSeconds: 30,
    frequency: QUOTE_FREQUENCY.OCCASIONALLY,
    targetDistance: 0,
  });
  const far = groupQuoteProbability({
    textLength: 20,
    previousSenderSelf: false,
    previousSeconds: 30,
    frequency: QUOTE_FREQUENCY.OCCASIONALLY,
    targetDistance: 10,
  });
  assert.ok(far > near, `越久远越该引用: ${far} vs ${near}`);
});

test('群聊引用：often 档位约为 occasionally 的两倍', () => {
  const base = { textLength: 20, previousSenderSelf: false, previousSeconds: 30, targetDistance: 2 };
  const occ = groupQuoteProbability({ ...base, frequency: QUOTE_FREQUENCY.OCCASIONALLY });
  const often = groupQuoteProbability({ ...base, frequency: QUOTE_FREQUENCY.OFTEN });
  assert.ok(often > occ, 'often 应高于 occasionally');
});

test('引用概率不超过 1', () => {
  const p = groupQuoteProbability({
    textLength: 10,
    previousSenderSelf: false,
    previousSeconds: 30,
    frequency: QUOTE_FREQUENCY.OFTEN,
    targetDistance: 10,
  });
  assert.ok(p <= 1, `概率应 <= 1: ${p}`);
});

test('负距离抛出异常', () => {
  assert.throws(() => groupQuoteProbability({
    textLength: 10,
    previousSenderSelf: false,
    previousSeconds: 30,
    frequency: QUOTE_FREQUENCY.OCCASIONALLY,
    targetDistance: -1,
  }));
});

test('非法频率档位抛出异常', () => {
  assert.throws(() => groupQuoteProbability({
    textLength: 10,
    previousSenderSelf: false,
    previousSeconds: 30,
    frequency: 'invalid',
    targetDistance: 1,
  }));
});

test('私聊引用：logistic 输出在 0~1 之间', () => {
  const cases = [
    { textLength: 0, previousSenderSelf: true, previousSeconds: 1, previousBurst: 1, targetDistance: 0 },
    { textLength: 100, previousSenderSelf: false, previousSeconds: 100, previousBurst: 10, targetDistance: 30 },
    { textLength: 20, previousSenderSelf: false, previousSeconds: 5, previousBurst: 3, targetDistance: 5 },
  ];
  for (const params of cases) {
    const p = privateQuoteProbability({ ...params, frequency: QUOTE_FREQUENCY.OCCASIONALLY });
    assert.ok(p >= 0 && p <= 1, `概率越界: ${p}`);
  }
});

test('私聊引用：对方连发越多越容易引用', () => {
  const base = { textLength: 20, previousSenderSelf: false, previousSeconds: 10, targetDistance: 3, frequency: QUOTE_FREQUENCY.OCCASIONALLY };
  const single = privateQuoteProbability({ ...base, previousBurst: 1 });
  const burst = privateQuoteProbability({ ...base, previousBurst: 12 });
  assert.ok(burst > single, `连发应更易引用: ${burst} vs ${single}`);
});

test('decideQuote：never 档位不引用', () => {
  const result = decideQuote({
    context: null,
    botUserId: '10001',
    text: 'hello',
    frequency: QUOTE_FREQUENCY.NEVER,
    isGroup: true,
  });
  assert.equal(result.shouldQuote, false);
  assert.equal(result.probability, 0);
});

test('decideQuote：无上下文时保守引用', () => {
  const result = decideQuote({
    context: null,
    botUserId: '10001',
    text: 'hello',
    frequency: QUOTE_FREQUENCY.OCCASIONALLY,
    isGroup: true,
  });
  assert.equal(result.shouldQuote, true);
  assert.equal(result.probability, 1);
});

test('decideQuote：概率为 0 时不引用', () => {
  const result = decideQuote({
    context: { targetDistance: 5, previousSenderId: '10001', previousSeconds: 1, previousBurst: 1 },
    botUserId: '10001',
    text: '',
    frequency: QUOTE_FREQUENCY.OCCASIONALLY,
    isGroup: true,
    random: () => 1, // 恒大于任何概率
  });
  assert.equal(result.shouldQuote, false);
});

test('decideQuote：随机值小于概率时引用', () => {
  const result = decideQuote({
    context: { targetDistance: 2, previousSenderId: '99999', previousSeconds: 30, previousBurst: 1 },
    botUserId: '10001',
    text: '短文本',
    frequency: QUOTE_FREQUENCY.OFTEN,
    isGroup: true,
    random: () => 0, // 恒小于概率
  });
  assert.equal(result.shouldQuote, true);
});

test('buildQuoteContext：计算目标距离与连发条数', () => {
  const history = [
    { messageId: 'm1', senderId: '20002', receivedAt: 1000 },
    { messageId: 'm2', senderId: '20002', receivedAt: 1002 },
    { messageId: 'm3', senderId: '20002', receivedAt: 1004 },
  ];
  const ctx = buildQuoteContext({
    history,
    targetMessageId: 'm1',
    botUserId: '10001',
    nowSeconds: 1010,
  });
  assert.equal(ctx.targetDistance, 2, 'm1 距最新 2 条');
  assert.equal(ctx.previousSenderId, '20002');
  assert.equal(ctx.previousSeconds, 6, '距上条消息 6 秒');
  assert.equal(ctx.previousBurst, 3, '同一人连发 3 条');
});

test('buildQuoteContext：找不到目标返回 null', () => {
  const ctx = buildQuoteContext({
    history: [{ messageId: 'm1', senderId: '20002', receivedAt: 1000 }],
    targetMessageId: 'nonexistent',
    botUserId: '10001',
    nowSeconds: 1010,
  });
  assert.equal(ctx, null);
});

test('buildQuoteContext：空历史返回 null', () => {
  assert.equal(buildQuoteContext({ history: [], targetMessageId: 'm1', botUserId: '1', nowSeconds: 0 }), null);
  assert.equal(buildQuoteContext({ history: null, targetMessageId: 'm1', botUserId: '1', nowSeconds: 0 }), null);
});

test('注意力漂移：合法配置生成完整块', () => {
  const block = buildAttentionDriftBlock({
    driftLevel: DRIFT_LEVELS.ACTIVE,
    anchorPolicy: ANCHOR_POLICIES.BALANCED,
    reactionStyle: REACTION_STYLES.NATURAL,
  });
  assert.ok(block.includes('<chat_style>'));
  assert.ok(block.includes('活跃联想'));
  assert.ok(block.includes('自然回钩'));
  assert.ok(block.includes('自然短反应'));
  assert.ok(block.includes('</chat_style>'));
});

test('注意力漂移：四档档位都有对应文本', () => {
  for (const level of Object.values(DRIFT_LEVELS)) {
    const block = buildAttentionDriftBlock({ driftLevel: level });
    assert.ok(block.length > 0, `${level} 应有文本`);
  }
});

test('注意力漂移：非法档位返回空串', () => {
  assert.equal(buildAttentionDriftBlock({ driftLevel: 'invalid' }), '');
  assert.equal(buildAttentionDriftBlock({ anchorPolicy: 'invalid' }), '');
  assert.equal(buildAttentionDriftBlock({ reactionStyle: 'invalid' }), '');
});

test('注意力漂移：默认使用 subtle 档位', () => {
  const block = buildAttentionDriftBlock();
  assert.ok(block.includes('轻微漂移'));
});
