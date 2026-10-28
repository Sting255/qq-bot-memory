import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cosineSimilarity,
  parseSummaryResponse,
  summarizeParticipants,
  summarizeTimeRange,
  formatMidTermBlock,
  RECALL_THRESHOLD,
} from '../src/memory/mid-term.js';

test('余弦相似度：相同向量为 1', () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
});

test('余弦相似度：正交向量为 0', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('余弦相似度：相反向量为 -1', () => {
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
});

test('余弦相似度：长度不等返回 0', () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
});

test('余弦相似度：空向量或非数组返回 0', () => {
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity(null, [1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
});

test('解析标准摘要 JSON', () => {
  const raw = JSON.stringify({
    summary: '讨论了周末去哪玩，最后决定去爬山',
    recall_cues: ['周末计划去哪里玩', '爬山相关的话题'],
  });
  const parsed = parseSummaryResponse(raw);
  assert.equal(parsed.summary, '讨论了周末去哪玩，最后决定去爬山');
  assert.equal(parsed.recallCues.length, 2);
});

test('解析被 Markdown 包裹的摘要', () => {
  const raw = '```json\n{"summary":"某段摘要","recall_cues":["线索一"]}\n```';
  const parsed = parseSummaryResponse(raw);
  assert.equal(parsed.summary, '某段摘要');
  assert.equal(parsed.recallCues.length, 1);
});

test('解析前后有多余文字的摘要', () => {
  const raw = '好的，结果如下：\n{"summary":"摘要内容","recall_cues":["cue"]}\n以上。';
  const parsed = parseSummaryResponse(raw);
  assert.equal(parsed.summary, '摘要内容');
});

test('非法或空摘要返回 null', () => {
  assert.equal(parseSummaryResponse(''), null);
  assert.equal(parseSummaryResponse(null), null);
  assert.equal(parseSummaryResponse('不是 JSON'), null);
  assert.equal(parseSummaryResponse('{"summary":""}'), null);
  assert.equal(parseSummaryResponse('{"recall_cues":[]}'), null);
});

test('recall_cues 超过 5 个时截断', () => {
  const raw = JSON.stringify({
    summary: '摘要',
    recall_cues: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  });
  const parsed = parseSummaryResponse(raw);
  assert.equal(parsed.recallCues.length, 5);
});

test('缺失 recall_cues 时返回空数组', () => {
  const raw = JSON.stringify({ summary: '只有摘要' });
  const parsed = parseSummaryResponse(raw);
  assert.equal(parsed.summary, '只有摘要');
  assert.deepEqual(parsed.recallCues, []);
});

test('提取参与者名字，去重且限制数量', () => {
  const rows = [
    { role: 'user', speaker_name: '小明' },
    { role: 'assistant', speaker_name: null },
    { role: 'user', speaker_name: '小红' },
    { role: 'user', speaker_name: '小明' },
  ];
  const names = summarizeParticipants(rows);
  assert.deepEqual(names, ['小明', '小红']);
});

test('参与者超过 8 个时截断', () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ role: 'user', speaker_name: `用户${i}` }));
  assert.equal(summarizeParticipants(rows).length, 8);
});

test('时间范围取首尾消息时间', () => {
  const rows = [
    { created_at: '2026-10-22 10:00:00' },
    { created_at: '2026-10-22 12:00:00' },
  ];
  assert.equal(summarizeTimeRange(rows), '2026-10-22 10:00:00 ~ 2026-10-22 12:00:00');
});

test('空消息列表时间范围为空', () => {
  assert.equal(summarizeTimeRange([]), '');
});

test('格式化中期记忆块', () => {
  const block = formatMidTermBlock({
    summary: '讨论了周末计划',
    cue: '周末去哪玩',
    timeRange: '2026-10-22 10:00 ~ 12:00',
  });
  assert.ok(block.includes('<chat_recall'));
  assert.ok(block.includes('讨论了周末计划'));
  assert.ok(block.includes('周末去哪玩'));
  assert.ok(block.includes('</chat_recall>'));
});

test('空中期记忆返回空字符串', () => {
  assert.equal(formatMidTermBlock(null), '');
  assert.equal(formatMidTermBlock({}), '');
});

test('召回阈值在合理范围内', () => {
  assert.ok(RECALL_THRESHOLD > 0.5 && RECALL_THRESHOLD <= 1, `实际 ${RECALL_THRESHOLD}`);
});
