/**
 * 中期记忆端到端验证：真实数据库读写 + 相似度召回。
 *
 * 不依赖 LLM 与向量服务：摘要内容直接构造，验证存储、召回与阈值逻辑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const tmpDir = mkdtempSync(resolve(tmpdir(), 'bot-mid-'));
process.env.BOT_DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

const {
  getDb,
  insertUserMessage,
  insertMidTermMemory,
  listMidTermMemory,
  markMidTermRecalled,
  selectRawMessagesBetween,
} = await import('../src/memory/store.js');
const { cosineSimilarity, formatMidTermBlock } = await import('../src/memory/mid-term.js');

test('中期记忆表可写入与读取', () => {
  const id = insertMidTermMemory({
    conversationId: 'qq_group_100',
    summary: '讨论了周末去爬山，小明提议早上七点出发',
    recallCues: ['周末计划', '爬山安排', '几点出发'],
    cueEmbeddings: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    participants: '小明、小红',
    timeRange: '2026-10-22 10:00 ~ 12:00',
    sourceRawStartId: 1,
    sourceRawEndId: 20,
  });
  assert.ok(id > 0);

  const rows = listMidTermMemory('qq_group_100');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].summary, '讨论了周末去爬山，小明提议早上七点出发');
  assert.deepEqual(JSON.parse(rows[0].recall_cues), ['周末计划', '爬山安排', '几点出发']);
  assert.equal(JSON.parse(rows[0].cue_embeddings).length, 3);
  assert.equal(rows[0].participants, '小明、小红');
});

test('不同会话的中期记忆互相隔离', () => {
  insertMidTermMemory({
    conversationId: 'qq_group_200',
    summary: '另一个群的事',
    recallCues: ['别的话题'],
    cueEmbeddings: [[0, 0, 1]],
    participants: '小李',
    timeRange: '',
    sourceRawStartId: 1,
    sourceRawEndId: 5,
  });

  const group100 = listMidTermMemory('qq_group_100');
  const group200 = listMidTermMemory('qq_group_200');
  assert.equal(group100.length, 1);
  assert.equal(group200.length, 1);
  assert.ok(group100[0].summary.includes('爬山'));
  assert.ok(group200[0].summary.includes('另一个群'));
});

test('召回计数递增', () => {
  const rows = listMidTermMemory('qq_group_100');
  const target = rows[0];
  assert.equal(target.recalled_count, 0);

  markMidTermRecalled(target.id);
  const after = listMidTermMemory('qq_group_100')[0];
  assert.equal(after.recalled_count, 1);
});

test('相似度召回：命中正确线索', () => {
  const rows = listMidTermMemory('qq_group_100');
  const candidate = rows[0];
  const embeddings = JSON.parse(candidate.cue_embeddings);

  // 查询向量接近「周末计划」那条线索
  const query = [0.95, 0.05, 0];
  let best = { score: 0, index: -1 };
  embeddings.forEach((vec, i) => {
    const score = cosineSimilarity(query, vec);
    if (score > best.score) best = { score, index: i };
  });

  assert.equal(best.index, 0, '应命中第 0 条线索');
  assert.ok(best.score > 0.8, `相似度应超过阈值: ${best.score}`);
});

test('相似度召回：不相关查询不命中', () => {
  const rows = listMidTermMemory('qq_group_100');
  const embeddings = JSON.parse(rows[0].cue_embeddings);
  // 与所有线索都正交的查询
  const query = [0, 0, 0, 1];
  const maxScore = Math.max(...embeddings.map((vec) => cosineSimilarity(query, vec)));
  assert.ok(maxScore < 0.8, `不相关查询不应命中: ${maxScore}`);
});

test('原始消息区间查询', () => {
  const db = getDb();
  for (let i = 1; i <= 5; i += 1) {
    insertUserMessage({
      conversationId: 'qq_group_300',
      content: `消息${i}`,
      speakerId: '111',
      speakerName: '小明',
      clientMsgId: `mid-${i}`,
    });
  }
  const all = db
    .prepare(`SELECT id FROM raw_messages WHERE conversation_id = ? ORDER BY id`)
    .all('qq_group_300');
  const from = all[1].id;
  const to = all[3].id;

  const rows = selectRawMessagesBetween('qq_group_300', from, to);
  assert.equal(rows.length, 3, '应包含两端共 3 条');
  assert.equal(rows[0].content, '消息2');
  assert.equal(rows[2].content, '消息4');
});

test('格式化注入块包含时间与线索', () => {
  const block = formatMidTermBlock({
    summary: '讨论了周末去爬山',
    cue: '周末计划',
    timeRange: '2026-10-22 10:00 ~ 12:00',
  });
  assert.ok(block.includes('2026-10-22 10:00 ~ 12:00'));
  assert.ok(block.includes('讨论了周末去爬山'));
  assert.ok(block.includes('周末计划'));
});

test('清理临时数据库', () => {
  getDb().close();
  rmSync(tmpDir, { recursive: true, force: true });
  assert.ok(true);
});
