import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const tmpDir = mkdtempSync(resolve(tmpdir(), 'bot-decay-'));
process.env.BOT_DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

const { getDb, insertMemory, getMemory } = await import('../src/memory/store.js');
const { decayMemories } = await import('../src/memory/recall.js');

test.after(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function insert({ conversationId = 'g1', judgment, importance = 3, lastRecalledDaysAgo = null }) {
  getDb();
  insertMemory({
    conversationId,
    memoryType: 'knowledge',
    judgment,
    reasoning: '',
    tags: [],
    importance,
  });
  const memoryId = getDb().prepare('SELECT memory_id FROM memory_fragments WHERE judgment = ? ORDER BY id DESC LIMIT 1').get(judgment).memory_id;
  if (lastRecalledDaysAgo !== null) {
    getDb().prepare(`UPDATE memory_fragments SET last_recalled_at = datetime('now', ?) WHERE memory_id = ?`)
      .run(`-${lastRecalledDaysAgo} days`, memoryId);
  }
  return memoryId;
}

test('遗忘门：久未召回的低价值记忆被退役', () => {
  // importance 1、200 天没想起：保留度远低于退役线
  const id = insert({ judgment: '很久没人提的事', importance: 1, lastRecalledDaysAgo: 200 });
  const result = decayMemories({ conversationId: 'g1' });
  assert.ok(result.decayed >= 1);
  assert.equal(getMemory(id).status, 'decayed');
});

test('遗忘门：高价值记忆扛得住时间', () => {
  // importance 5 相当于写入门给了满分，同样 200 天仍应保留
  const id = insert({ conversationId: 'g-strong', judgment: '最重要的事', importance: 5, lastRecalledDaysAgo: 200 });
  decayMemories({ conversationId: 'g-strong' });
  assert.equal(getMemory(id).status, 'active');
});

test('遗忘门：常被召回的记忆衰减更慢', () => {
  // 同样 60 天，召回 5 次的半衰期被拉长，保留度更高
  const recalled = insert({ conversationId: 'g-recall', judgment: '经常被想起的事', importance: 2, lastRecalledDaysAgo: 60 });
  getDb().prepare('UPDATE memory_fragments SET recalled_count = 5 WHERE memory_id = ?').run(recalled);

  const ignored = insert({ conversationId: 'g-recall', judgment: '从没被想起的事', importance: 2, lastRecalledDaysAgo: 60 });

  decayMemories({ conversationId: 'g-recall' });
  assert.equal(getMemory(recalled).status, 'active');
  const ignoredRow = getMemory(ignored);
  assert.ok(ignoredRow.status === 'decayed' || ignoredRow.importance < 2);
});

test('近期记忆不参与遗忘门', () => {
  const id = insert({ conversationId: 'g-fresh', judgment: '刚记下的', importance: 1, lastRecalledDaysAgo: 2 });
  decayMemories({ conversationId: 'g-fresh' });
  const row = getMemory(id);
  assert.equal(row.status, 'active');
  assert.equal(row.importance, 1);
});

test('从未被召回的记忆按创建时间计算年龄', () => {
  // 老实现里 NULL 永远不衰减，导致记忆只增不减；新实现按 created_at 起算
  const id = insert({ conversationId: 'g-null', judgment: '写完就没人管的老记忆', importance: 1 });
  getDb().prepare(`UPDATE memory_fragments SET created_at = datetime('now', '-200 days') WHERE memory_id = ?`).run(id);
  decayMemories({ conversationId: 'g-null' });
  assert.equal(getMemory(id).status, 'decayed');
});

test('24 小时节流：第二次调用跳过', () => {
  decayMemories({ conversationId: 'g2' });
  const after = decayMemories({ conversationId: 'g2' });
  assert.equal(after.skipped, 'throttled');
});
