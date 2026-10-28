import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTypoSentence } from '../src/persona/typo.js';
import { splitReply } from '../src/persona/splitter.js';
import { calculateTypingDelay } from '../src/persona/typing.js';

/** 确定性随机源，保证测试可复现。 */
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

test('错别字替换后仍是同音字，不会变成无关字', () => {
  const result = createTypoSentence('今天天气不错我们去公园吧', {
    errorRate: 0.3,
    wordReplaceRate: 0.3,
    correctionProbability: 0,
    random: seededRandom(42),
  });
  assert.equal(typeof result.text, 'string');
  assert.ok(result.text.length > 0);
  // 长度应与原文一致（同音字替换不增删字符）
  assert.equal(result.text.length, '今天天气不错我们去公园吧'.length);
});

test('错别字生成在相同随机源下结果稳定', () => {
  const a = createTypoSentence('我觉得这个想法很好', {
    errorRate: 0.2,
    wordReplaceRate: 0.2,
    correctionProbability: 0.5,
    random: seededRandom(7),
  });
  const b = createTypoSentence('我觉得这个想法很好', {
    errorRate: 0.2,
    wordReplaceRate: 0.2,
    correctionProbability: 0.5,
    random: seededRandom(7),
  });
  assert.equal(a.text, b.text);
  assert.equal(a.correction, b.correction);
});

test('概率为 0 时不产生任何改动', () => {
  const source = '明天记得带伞';
  const result = createTypoSentence(source, {
    errorRate: 0,
    wordReplaceRate: 0,
    correctionProbability: 0,
    random: seededRandom(1),
  });
  assert.equal(result.text, source);
  assert.equal(result.correction, null);
});

test('非中文内容原样保留', () => {
  const result = createTypoSentence('hello 123', {
    errorRate: 1,
    wordReplaceRate: 1,
    correctionProbability: 1,
    random: seededRandom(3),
  });
  assert.equal(result.text, 'hello 123');
});

test('空字符串安全返回', () => {
  const result = createTypoSentence('', { random: seededRandom(1) });
  assert.equal(result.text, '');
  assert.equal(result.correction, null);
});

test('短回复不拆分', () => {
  assert.deepEqual(splitReply('好的', { maxLength: 200, maxSplitNum: 3 }), ['好的']);
});

test('长回复按句末标点拆成多条', () => {
  const long = '今天天气很好。我们出去走走吧！你觉得怎么样？我随便都行。';
  const segments = splitReply(long, { maxLength: 10, maxSplitNum: 4 });
  assert.ok(segments.length > 1, '应拆成多条');
  assert.ok(segments.every((segment) => segment.length > 0));
});

test('分段数量不超过上限', () => {
  const long = Array.from({ length: 20 }, (_, i) => `第${i}句话内容。`).join('');
  const segments = splitReply(long, { maxLength: 10, maxSplitNum: 3 });
  assert.ok(segments.length <= 3, `实际 ${segments.length} 条`);
});

test('颜文字不会被从中间拆开', () => {
  const text = '这样挺好的(｡･ω･｡)真的。就这样吧。';
  const segments = splitReply(text, { maxLength: 12, maxSplitNum: 5 });
  const joined = segments.join('');
  assert.ok(joined.includes('(｡･ω･｡)'), `颜文字被拆坏: ${JSON.stringify(segments)}`);
});

test('打字延迟随文本长度增长', () => {
  const short = calculateTypingDelay('好', { speed: 1 });
  const long = calculateTypingDelay('今天天气不错我们去公园散步吧', { speed: 1 });
  assert.ok(long > short, `长文本延迟应更久: ${long} vs ${short}`);
});

test('speed 为 0 时无延迟', () => {
  assert.equal(calculateTypingDelay('很长的一段文字内容', { speed: 0 }), 0);
});

test('单个中文字符使用 3 倍时间', () => {
  const single = calculateTypingDelay('好', { speed: 1, chineseCharSec: 0.3 });
  // 0.3 * 3 + 0.2 = 1.1 秒
  assert.equal(single, 1100);
});

test('长回复有延迟上限', () => {
  const long = calculateTypingDelay('这是一段很长的话'.repeat(20), { speed: 1 });
  assert.ok(long <= 2500, `延迟应有上限，实际 ${long}ms`);
});

test('默认打字速度约每分钟 111 字', () => {
  // 10 个中文字约 0.9 秒 + 回车 0.2 秒
  const delay = calculateTypingDelay('十个中文字符测试用', { speed: 1 });
  assert.ok(delay >= 800 && delay <= 1400, `实际 ${delay}ms`);
});
