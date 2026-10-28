import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateReplyProbability,
  summarizePendingTexts,
  MAX_PENDING_COUNT,
} from '../src/trigger/reply-likelihood.js';

const baseInput = {
  mentionBot: false,
  atOther: false,
  hasQuestionMark: false,
  placeholderOnly: false,
  recentSelfRatio: 0,
  recentMessageCount: 10,
  secondsSinceBotMessage: 3600,
  pendingCount: 3,
};

test('概率始终落在 0~1 之间', () => {
  const cases = [
    baseInput,
    { ...baseInput, pendingCount: 100, recentMessageCount: 1000 },
    { ...baseInput, mentionBot: true, pendingCount: 20 },
    { ...baseInput, recentSelfRatio: 1, recentMessageCount: 0 },
  ];
  for (const input of cases) {
    const p = estimateReplyProbability(input);
    assert.ok(p >= 0 && p <= 1, `概率越界: ${p}`);
  }
});

test('@ 了别人会降低开口概率', () => {
  const without = estimateReplyProbability(baseInput);
  const withAtOther = estimateReplyProbability({ ...baseInput, atOther: true });
  assert.ok(withAtOther < without, `atOther 应降权: ${withAtOther} vs ${without}`);
});

test('提及自己会显著提高开口概率', () => {
  const without = estimateReplyProbability(baseInput);
  const withMention = estimateReplyProbability({ ...baseInput, mentionBot: true });
  assert.ok(withMention > without, `mentionBot 应提权: ${withMention} vs ${without}`);
  assert.ok(withMention - without > 0.2, '提权幅度应明显');
});

test('纯媒体占位会降低开口概率', () => {
  const normal = estimateReplyProbability(baseInput);
  const placeholder = estimateReplyProbability({ ...baseInput, placeholderOnly: true });
  assert.ok(placeholder < normal, '纯占位应降权');
});

test('自己发言占比越高，后续开口概率越高（未闭环时的原始倾向）', () => {
  const low = estimateReplyProbability({ ...baseInput, recentSelfRatio: 0 });
  const high = estimateReplyProbability({ ...baseInput, recentSelfRatio: 1 });
  assert.ok(high > low, '原始概率随自己发言占比上升');
});

test('待处理消息数按上限截断，不会无限放大', () => {
  const atCap = estimateReplyProbability({ ...baseInput, pendingCount: MAX_PENDING_COUNT });
  const overCap = estimateReplyProbability({ ...baseInput, pendingCount: MAX_PENDING_COUNT + 50 });
  assert.equal(atCap, overCap, '超过上限后概率应相同');
});

test('summarizePendingTexts 识别 @ 别人、问号与纯占位', () => {
  assert.deepEqual(
    summarizePendingTexts(['@小明 你在吗'], { hasAtBot: false }),
    { atOther: true, hasQuestionMark: false, placeholderOnly: false },
  );

  assert.deepEqual(
    summarizePendingTexts(['这个怎么弄?'], { hasAtBot: false }),
    { atOther: false, hasQuestionMark: true, placeholderOnly: false },
  );

  assert.deepEqual(
    summarizePendingTexts(['[图片]', '[表情包]'], { hasAtBot: false }),
    { atOther: false, hasQuestionMark: false, placeholderOnly: true },
  );

  // 有 @ 机器人时不把整批算作 atOther
  assert.deepEqual(
    summarizePendingTexts(['@机器人 看看'], { hasAtBot: true }),
    { atOther: false, hasQuestionMark: false, placeholderOnly: false },
  );
});

test('空文本批次不产生 atOther 与占位判定', () => {
  assert.deepEqual(
    summarizePendingTexts([], { hasAtBot: false }),
    { atOther: false, hasQuestionMark: false, placeholderOnly: false },
  );
});
