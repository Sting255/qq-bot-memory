import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const tmpDir = mkdtempSync(resolve(tmpdir(), 'bot-recent-'));
process.env.BOT_DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

const { getDb, insertMidTermMemory, latestMidTermMemory } = await import('../src/memory/store.js');
const { recallRecentNotes, formatRecentNotesBlock, formatMidTermBlock } = await import('../src/memory/mid-term.js');

test.after(() => {
  // WAL 文件在 Windows 下可能仍被占用，忽略清理失败（临时目录系统会回收）
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('latestMidTermMemory 取最近一条', () => {
  getDb();
  insertMidTermMemory({
    conversationId: 'g1',
    summary: '第一段',
    recallCues: [],
    cueEmbeddings: [],
    participants: '',
    timeRange: '今天 10:00',
  });
  insertMidTermMemory({
    conversationId: 'g1',
    summary: '第二段',
    recallCues: [],
    cueEmbeddings: [],
    participants: '',
    timeRange: '今天 11:00',
  });
  const latest = latestMidTermMemory('g1');
  assert.equal(latest.summary, '第二段');
});

test('latestMidTermMemory 会话隔离', () => {
  assert.equal(latestMidTermMemory('g-other'), null);
});

test('recallRecentNotes 返回最近脉络', () => {
  const note = recallRecentNotes('g1');
  assert.ok(note);
  assert.equal(note.summary, '第二段');
});

test('formatRecentNotesBlock 含脉络与参考说明', () => {
  const block = formatRecentNotesBlock({ summary: '聊了猫和游戏', timeRange: '今天 11:00' });
  assert.match(block, /<recent_context time="今天 11:00">/);
  assert.match(block, /聊了猫和游戏/);
  assert.match(block, /不需要回应/);
});

test('formatRecentNotesBlock 长摘要折叠到 200 字', () => {
  const long = '字'.repeat(800);
  const block = formatRecentNotesBlock({ summary: long });
  const body = block.split('\n')[1];
  assert.ok(body.length <= 202);
  assert.ok(body.endsWith('…'));
});

test('formatRecentNotesBlock 空输入返回空串', () => {
  assert.equal(formatRecentNotesBlock(null), '');
  assert.equal(formatRecentNotesBlock({}), '');
});

test('recent 块与召回块格式不同，可并存去重', () => {
  const recall = formatMidTermBlock({ summary: 'x', timeRange: 't', cue: 'c' });
  const recent = formatRecentNotesBlock({ summary: 'x', timeRange: 't' });
  assert.match(recall, /<chat_recall/);
  assert.match(recent, /<recent_context/);
});
