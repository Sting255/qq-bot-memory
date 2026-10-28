import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const tmpDir = mkdtempSync(resolve(tmpdir(), 'bot-expr-'));
process.env.BOT_DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

const { getDb } = await import('../src/memory/store.js');
const { buildStyleBlock, recallStyleBlock } = await import('../src/memory/expression.js');

test.after(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function seedExpression(conversationId, expression, useCount = 1) {
  getDb().prepare(
    `INSERT INTO expression_habits (conversation_id, expression, kind, use_count) VALUES (?, ?, 'phrase', ?)`,
  ).run(conversationId, expression, useCount);
}

function seedJargon(conversationId, term, meaning) {
  getDb().prepare(
    `INSERT INTO jargon_terms (conversation_id, term, meaning) VALUES (?, ?, ?)`,
  ).run(conversationId, term, meaning);
}

test('风格块包含表达与黑话', () => {
  seedExpression('g1', '绝绝子');
  seedJargon('g1', 'yyds', '永远的神');
  const block = buildStyleBlock('g1');
  assert.match(block, /这个群里常这么说/);
  assert.match(block, /绝绝子/);
  assert.match(block, /yyds：永远的神/);
});

test('use_count 高的表达排前', () => {
  seedExpression('g2', '低频词', 1);
  seedExpression('g2', '高频词', 9);
  const block = buildStyleBlock('g2');
  assert.ok(block.indexOf('高频词') < block.indexOf('低频词'));
});

test('无内容返回空串', () => {
  assert.equal(buildStyleBlock('g-empty'), '');
});

test('会话隔离', () => {
  seedExpression('g3', '只有g3有的');
  assert.equal(buildStyleBlock('g4'), '');
});

test('recallStyleBlock 无嵌入时降级为热度版', async () => {
  seedExpression('g5', '热度表达', 5);
  const block = await recallStyleBlock('g5', '随便什么');
  assert.match(block, /热度表达/);
});
