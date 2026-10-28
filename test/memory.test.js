import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMemories, buildTranscript, shouldCurate } from '../src/memory/curate.js';
import { formatMemoryBlock } from '../src/memory/recall.js';

test('解析标准 JSON 格式的记忆', () => {
  const raw = JSON.stringify({
    memories: [
      { judgment: '喜欢猫', type: 'preference', reasoning: '多次提到', tags: ['宠物', '猫'], subject: '小明' },
      { judgment: '住在杭州', type: 'knowledge', reasoning: '', tags: ['地点'], subject: '小明' },
    ],
  });
  const result = parseMemories(raw);
  assert.equal(result.length, 2);
  assert.equal(result[0].judgment, '喜欢猫');
  assert.equal(result[0].memoryType, 'preference');
  assert.deepEqual(result[0].tags, ['宠物', '猫']);
});

test('解析被 Markdown 代码块包裹的 JSON', () => {
  const raw = '```json\n{"memories":[{"judgment":"养了两只猫","type":"knowledge"}]}\n```';
  const result = parseMemories(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].judgment, '养了两只猫');
});

test('解析前后有多余文字的 JSON', () => {
  const raw = '好的，这是结果：\n{"memories":[{"judgment":"喜欢下雨天","type":"preference"}]}\n以上。';
  const result = parseMemories(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].judgment, '喜欢下雨天');
});

test('非法 JSON 返回空数组而不抛异常', () => {
  assert.deepEqual(parseMemories('这不是 JSON'), []);
  assert.deepEqual(parseMemories(''), []);
  assert.deepEqual(parseMemories(null), []);
  assert.deepEqual(parseMemories('{"memories": "不是数组"}'), []);
});

test('未知 type 回退到 knowledge', () => {
  const raw = JSON.stringify({ memories: [{ judgment: '某件事', type: '不存在的类型' }] });
  const result = parseMemories(raw);
  assert.equal(result[0].memoryType, 'knowledge');
});

test('空 judgment 条目被丢弃', () => {
  const raw = JSON.stringify({
    memories: [
      { judgment: '', type: 'knowledge' },
      { judgment: '   ', type: 'knowledge' },
      { judgment: '有效记忆', type: 'knowledge' },
    ],
  });
  const result = parseMemories(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].judgment, '有效记忆');
});

test('tags 超过 4 个时截断', () => {
  const raw = JSON.stringify({
    memories: [{ judgment: '某事', type: 'knowledge', tags: ['a', 'b', 'c', 'd', 'e', 'f'] }],
  });
  const result = parseMemories(raw);
  assert.equal(result[0].tags.length, 4);
});

test('buildTranscript 区分发言者', () => {
  const rows = [
    { role: 'user', content: '你好', speaker_name: '小明' },
    { role: 'assistant', content: '你好呀' },
    { role: 'user', content: '在干嘛', speaker_name: '小红' },
  ];
  const transcript = buildTranscript(rows, { assistantLabel: '我' });
  assert.ok(transcript.includes('[小明] 你好'));
  assert.ok(transcript.includes('[我] 你好呀'));
  assert.ok(transcript.includes('[小红] 在干嘛'));
});

test('buildTranscript 跳过空内容', () => {
  const rows = [
    { role: 'user', content: '', speaker_name: '小明' },
    { role: 'user', content: '有内容', speaker_name: '小明' },
  ];
  const transcript = buildTranscript(rows);
  assert.equal(transcript, '[小明] 有内容');
});

test('formatMemoryBlock 生成可注入的文本块', () => {
  const block = formatMemoryBlock([
    { judgment: '喜欢猫', memoryType: 'preference' },
    { judgment: '住在杭州', memoryType: 'knowledge' },
  ]);
  assert.ok(block.startsWith('<memory>'));
  assert.ok(block.includes('[preference] 喜欢猫'));
  assert.ok(block.includes('[knowledge] 住在杭州'));
});

test('空记忆返回空字符串', () => {
  assert.equal(formatMemoryBlock([]), '');
  assert.equal(formatMemoryBlock(null), '');
});
