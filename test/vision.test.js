import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatImageBlock } = await import('../src/chat/vision.js');

test('单图描述渲染成 image_context 块', () => {
  const block = formatImageBlock(['一群人围着火锅']);
  assert.match(block, /<image_context>/);
  assert.match(block, /一群人围着火锅/);
  assert.match(block, /<\/image_context>/);
});

test('多图描述带序号', () => {
  const block = formatImageBlock(['一只猫', '一张截图：明天开会']);
  assert.match(block, /1\. 一只猫/);
  assert.match(block, /2\. 一张截图/);
});

test('空描述返回空串', () => {
  assert.equal(formatImageBlock([]), '');
  assert.equal(formatImageBlock(['']), '');
  assert.equal(formatImageBlock(null), '');
});

test('过滤失败项只保留有效描述', () => {
  const block = formatImageBlock(['', '有效描述', '']);
  assert.match(block, /当前消息附带一张图片/);
  assert.match(block, /有效描述/);
});
