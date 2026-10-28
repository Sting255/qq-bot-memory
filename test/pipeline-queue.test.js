import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationQueue } from '../src/pipeline/queue.js';
import { friendlyError } from '../src/pipeline/errors.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('会话空闲时任务立即执行', async () => {
  const q = new ConversationQueue();
  let ran = false;
  q.submit('g1', async () => { ran = true; });
  await tick();
  assert.ok(ran);
});

test('同会话任务串行：前一个完成才跑下一个', async () => {
  const order = [];
  const q = new ConversationQueue();
  q.submit('g1', async () => { await tick(); order.push(1); });
  q.submit('g1', async () => { order.push(2); });
  q.submit('g1', async () => { order.push(3); });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(order, [1, 2, 3]);
});

test('不同会话互不阻塞', async () => {
  const order = [];
  const q = new ConversationQueue();
  q.submit('a', async () => { await tick(); order.push('a'); });
  q.submit('b', async () => { order.push('b'); });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(order, ['b', 'a']);
});

test('超过 maxPending 的任务被丢弃并返回 false', async () => {
  const q = new ConversationQueue({ maxPending: 1 });
  const ran = [];
  const ok1 = q.submit('g', async () => { await tick(); ran.push(1); });
  const ok2 = q.submit('g', async () => { ran.push(2); });
  const ok3 = q.submit('g', async () => { ran.push(3); });
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(ok1 && ok2);
  assert.equal(ok3, false);
  assert.deepEqual(ran, [1, 2]);
});

test('任务抛错不影响后续任务', async () => {
  const q = new ConversationQueue();
  const ran = [];
  q.submit('g', async () => { throw new Error('boom'); });
  q.submit('g', async () => { ran.push(2); });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(ran, [2]);
});

test('队列跑空后清理会话条目', async () => {
  const q = new ConversationQueue();
  q.submit('g', async () => {});
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(q._entries.size, 0);
});

test('friendlyError 翻译超时类错误', () => {
  assert.match(friendlyError('g1', 'request timeout after 30s'), /卡了|忙/);
});

test('friendlyError 未知错误返回空串', () => {
  assert.equal(friendlyError('g1', 'some weird error'), '');
});

test('friendlyError 60 秒频控：同会话第二次返回空', () => {
  assert.ok(friendlyError('g2', 'ETIMEDOUT').length > 0);
  assert.equal(friendlyError('g2', 'fetch failed'), '');
  // 不同会话不受影响
  assert.ok(friendlyError('g3', 'fetch failed').length > 0);
});
