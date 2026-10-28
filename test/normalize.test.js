import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSegments, normalizeEvent, shouldSkipMessage, FORWARD_PLACEHOLDER } from '../src/adapters/normalize.js';

const SELF_ID = '10001';

test('@ 机器人只靠结构化字段识别，不依赖文本', () => {
  const result = normalizeSegments(
    [
      { type: 'at', data: { qq: SELF_ID, name: '小夏' } },
      { type: 'text', data: { text: ' 在吗' } },
    ],
    { selfId: SELF_ID },
  );
  assert.equal(result.isAt, true);
  assert.ok(result.text.includes('在吗'));
});

test('@ 别人不算 @ 机器人', () => {
  const result = normalizeSegments(
    [
      { type: 'at', data: { qq: '99999', name: '小明' } },
      { type: 'text', data: { text: ' 你看' } },
    ],
    { selfId: SELF_ID },
  );
  assert.equal(result.isAt, false);
});

test('文本里出现 @ 字样不会被误判为 @ 机器人', () => {
  const result = normalizeSegments([{ type: 'text', data: { text: '@小夏的狗 你好' } }], { selfId: SELF_ID });
  assert.equal(result.isAt, false, '群名片含机器人名字不应算 @');
});

test('@全体成员 不被当作 @ 机器人', () => {
  const result = normalizeSegments(
    [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: ' 开会' } }],
    { selfId: SELF_ID },
  );
  assert.equal(result.isAt, false);
});

test('合并转发默认被丢弃并留占位', () => {
  const result = normalizeSegments(
    [
      { type: 'forward', data: { id: 'abc' } },
      { type: 'text', data: { text: ' 你看这个' } },
    ],
    { selfId: SELF_ID, ignoreForward: true },
  );
  assert.equal(result.hasForward, true);
  assert.ok(result.text.includes(FORWARD_PLACEHOLDER));
  assert.ok(result.text.includes('你看这个'));
  assert.equal(result.forwardOnly, false, '带文字时不算纯转发');
});

test('纯转发消息被标记 forwardOnly', () => {
  const result = normalizeSegments([{ type: 'forward', data: { id: 'abc' } }], {
    selfId: SELF_ID,
    ignoreForward: true,
  });
  assert.equal(result.hasForward, true);
  assert.equal(result.forwardOnly, true);
});

test('图片只留占位并收集 url', () => {
  const result = normalizeSegments(
    [{ type: 'image', data: { url: 'https://example.com/a.jpg' } }],
    { selfId: SELF_ID },
  );
  assert.equal(result.text, '[图片]');
  assert.deepEqual(result.images, ['https://example.com/a.jpg']);
});

test('引用回复的原消息不展开', () => {
  const result = normalizeSegments(
    [
      { type: 'reply', data: { id: '123' } },
      { type: 'text', data: { text: '对' } },
    ],
    { selfId: SELF_ID },
  );
  assert.equal(result.text, '对');
});

test('群聊事件生成正确会话 ID 与发言者', () => {
  const message = normalizeEvent(
    {
      post_type: 'message',
      message_type: 'group',
      group_id: 55555,
      user_id: 77777,
      message_id: 1234,
      time: 1700000000,
      sender: { card: '群昵称', nickname: '真名' },
      message: [{ type: 'text', data: { text: '大家好' } }],
    },
    { selfId: SELF_ID },
  );
  assert.equal(message.conversationId, 'qq_group_55555');
  assert.equal(message.senderName, '群昵称', '优先用群名片');
  assert.equal(message.isGroup, true);
  assert.equal(message.isSelf, false);
});

test('私聊事件生成正确会话 ID', () => {
  const message = normalizeEvent(
    {
      post_type: 'message',
      message_type: 'private',
      user_id: 77777,
      message_id: 1235,
      sender: { nickname: '小明' },
      message: [{ type: 'text', data: { text: '在吗' } }],
    },
    { selfId: SELF_ID },
  );
  assert.equal(message.conversationId, 'qq_private_77777');
  assert.equal(message.isGroup, false);
});

test('自己发的消息被标记 isSelf 并跳过', () => {
  const message = normalizeEvent(
    {
      post_type: 'message',
      message_type: 'group',
      group_id: 55555,
      user_id: Number(SELF_ID),
      message_id: 1236,
      sender: { card: '我自己' },
      message: [{ type: 'text', data: { text: '我说的' } }],
    },
    { selfId: SELF_ID },
  );
  assert.equal(message.isSelf, true);
  assert.equal(shouldSkipMessage(message), true);
});

test('纯转发消息应被跳过处理', () => {
  const message = normalizeEvent(
    {
      post_type: 'message',
      message_type: 'group',
      group_id: 55555,
      user_id: 77777,
      message_id: 1237,
      sender: { card: '小明' },
      message: [{ type: 'forward', data: { id: 'x' } }],
    },
    { selfId: SELF_ID, ignoreForward: true },
  );
  assert.equal(shouldSkipMessage(message), true);
});

test('非消息事件返回 null', () => {
  assert.equal(normalizeEvent({ post_type: 'notice' }, { selfId: SELF_ID }), null);
  assert.equal(normalizeEvent(null, { selfId: SELF_ID }), null);
});
