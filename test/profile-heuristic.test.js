import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const tmpDir = mkdtempSync(resolve(tmpdir(), 'bot-prof-'));
process.env.BOT_DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

const {
  getDb,
  insertMemory,
  getPersonProfile,
  listActiveMemoriesByPerson,
  getMessageCount,
  insertUserMessage,
} = await import('../src/memory/store.js');
const {
  renderProfileText,
  refreshPersonProfile,
  loadActiveProfiles,
  formatProfileBlock,
  collectActivePersonIds,
  MIN_FACTS_FOR_PROFILE,
} = await import('../src/memory/profile.js');
const { shouldRecall, getState, getCached, pullHeuristicMemory } = await import('../src/memory/heuristic.js');

test('渲染画像文本：按类型分组', () => {
  const memories = [
    { judgment: '住在杭州', memory_type: 'knowledge' },
    { judgment: '喜欢猫', memory_type: 'preference' },
    { judgment: '最近心情不错', memory_type: 'emotion' },
    { judgment: '做前端开发', memory_type: 'knowledge' },
  ];
  const text = renderProfileText(memories);
  assert.ok(text.includes('已知：住在杭州；做前端开发'));
  assert.ok(text.includes('偏好：喜欢猫'));
  assert.ok(text.includes('情绪：最近心情不错'));
});

test('渲染画像文本：空输入返回空串', () => {
  assert.equal(renderProfileText([]), '');
  assert.equal(renderProfileText(null), '');
});

test('渲染画像文本：超长截断', () => {
  const memories = Array.from({ length: 100 }, (_, i) => ({
    judgment: `这是第${i}条很长的记忆内容描述`,
    memory_type: 'knowledge',
  }));
  const text = renderProfileText(memories, 50);
  assert.ok(text.length <= 50, `应截断到 50 字内，实际 ${text.length}`);
  assert.ok(text.endsWith('…'));
});

test('画像需要足够记忆条数才创建', () => {
  const conversationId = 'qq_group_500';
  const personId = '10001';
  // 少于阈值
  for (let i = 0; i < MIN_FACTS_FOR_PROFILE - 1; i += 1) {
    insertMemory({
      conversationId,
      judgment: `小明的事实${i}`,
      memoryType: 'knowledge',
      subject: '小明',
      tags: ['小明'],
    });
  }
  const tooFew = refreshPersonProfile({ conversationId, personId, personName: '小明' });
  assert.equal(tooFew.created, false);
  assert.ok(tooFew.factCount < MIN_FACTS_FOR_PROFILE);
});

test('记忆足够时创建画像', () => {
  const conversationId = 'qq_group_500';
  const personId = '10001';
  // 补足到阈值
  for (let i = 0; i < 5; i += 1) {
    insertMemory({
      conversationId,
      judgment: `小明喜欢第${i}种食物`,
      memoryType: 'preference',
      subject: '小明',
      tags: ['小明'],
    });
  }
  const result = refreshPersonProfile({ conversationId, personId, personName: '小明' });
  assert.equal(result.created, true);
  assert.ok(result.factCount >= MIN_FACTS_FOR_PROFILE);

  const profile = getPersonProfile(conversationId, personId);
  assert.ok(profile, '画像应已写入');
  assert.ok(profile.profile_text.includes('喜欢第0种食物'));
  assert.equal(profile.person_name, '小明');
});

test('画像以 QQ 号为主键，改名后仍能命中', () => {
  const conversationId = 'qq_group_500';
  const personId = '10001';
  // 用新群名片再刷新一次
  const renamed = refreshPersonProfile({ conversationId, personId, personName: '小明改名了' });
  assert.equal(renamed.created, true);

  const profile = getPersonProfile(conversationId, personId);
  assert.ok(profile, 'QQ 号不变，画像应仍存在');
  assert.equal(profile.person_name, '小明改名了', '显示名应更新');
  assert.ok(profile.profile_text.includes('喜欢第0种食物'), '画像内容应保留');
});

test('画像可被读取并注入', () => {
  const profiles = loadActiveProfiles({
    conversationId: 'qq_group_500',
    activePersonIds: ['10001'],
  });
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].person_name, '小明改名了');

  const block = formatProfileBlock(profiles);
  assert.ok(block.includes('<profiles>'));
  assert.ok(block.includes('【小明改名了】'));
  assert.ok(block.includes('</profiles>'));
});

test('无画像时返回空', () => {
  assert.deepEqual(loadActiveProfiles({ conversationId: 'qq_group_999', activePersonIds: ['张三'] }), []);
  assert.equal(formatProfileBlock([]), '');
  assert.equal(formatProfileBlock(null), '');
});

test('按 QQ 号查询记忆：命中个人子语境', () => {
  const conversationId = 'qq_group_600';
  const personId = '12345';
  insertMemory({
    conversationId: `${conversationId}_u${personId}`,
    judgment: '这个人的个人语境记忆',
    memoryType: 'knowledge',
    subject: '小红',
    tags: [],
  });
  const memories = listActiveMemoriesByPerson({
    conversationId,
    personId,
    personName: '小红',
    limit: 10,
  });
  assert.ok(memories.some((m) => m.judgment.includes('个人语境')));
});

test('按 QQ 号查询：无名字时仍能取到子语境记忆', () => {
  const conversationId = 'qq_group_600';
  const personId = '12345';
  const memories = listActiveMemoriesByPerson({
    conversationId,
    personId,
    personName: '',
    limit: 10,
  });
  assert.ok(memories.some((m) => m.judgment.includes('个人语境')), '不依赖名字也应命中');
});

test('提取活跃人物：当前发言者与 @ 的人', () => {
  const ids = collectActivePersonIds(
    { senderId: '111', atUserIds: ['222', '333'], replyToUserId: '444' },
    [],
  );
  assert.ok(ids.includes('111'));
  assert.ok(ids.includes('222'));
  assert.ok(ids.includes('333'));
  assert.ok(ids.includes('444'));
});

test('提取活跃人物：历史用 speaker_id', () => {
  const ids = collectActivePersonIds(
    { senderId: '111' },
    [{ speaker_id: '555' }, { speaker_id: '666' }],
  );
  assert.ok(ids.includes('555'));
  assert.ok(ids.includes('666'));
});

test('启发式节流：消息太少不触发', () => {
  const state = { lastRecallAt: 0, lastMessageCount: 0 };
  const result = shouldRecall(state, {
    totalMessageCount: 2,
    now: 1000,
    minIntervalSeconds: 60,
    minNewMessages: 5,
  });
  assert.equal(result, false);
});

test('启发式节流：间隔不足不触发', () => {
  const state = { lastRecallAt: 990, lastMessageCount: 0 };
  const result = shouldRecall(state, {
    totalMessageCount: 100,
    now: 1000,
    minIntervalSeconds: 60,
    minNewMessages: 5,
  });
  assert.equal(result, false, '距上次仅 10 秒，应被间隔节流挡住');
});

test('启发式节流：新增消息不足不触发', () => {
  const state = { lastRecallAt: 0, lastMessageCount: 98 };
  const result = shouldRecall(state, {
    totalMessageCount: 100,
    now: 5000,
    minIntervalSeconds: 60,
    minNewMessages: 5,
  });
  assert.equal(result, false, '只新增 2 条，不足 5 条');
});

test('启发式节流：全部条件满足时触发', () => {
  const state = { lastRecallAt: 0, lastMessageCount: 90 };
  const result = shouldRecall(state, {
    totalMessageCount: 100,
    now: 5000,
    minIntervalSeconds: 60,
    minNewMessages: 5,
  });
  assert.equal(result, true);
});

test('缓存未过期时复用', () => {
  const state = { cachedBlock: '<memory>旧结果</memory>', cacheExpiresAt: 2000 };
  assert.equal(getCached(state, 1500, 180), '<memory>旧结果</memory>');
});

test('缓存过期后不返回', () => {
  const state = { cachedBlock: '<memory>旧结果</memory>', cacheExpiresAt: 2000 };
  assert.equal(getCached(state, 2500, 180), null);
});

test('缓存 TTL 为 0 时不启用缓存', () => {
  const state = { cachedBlock: 'x', cacheExpiresAt: 2000 };
  assert.equal(getCached(state, 1500, 0), null);
});

test('会话状态按会话隔离', () => {
  const a = getState('conv-a');
  a.lastRecallAt = 123;
  const b = getState('conv-b');
  assert.equal(b.lastRecallAt, 0, '不同会话状态应独立');
  assert.equal(getState('conv-a').lastRecallAt, 123);
});

test('消息计数可用于节流', () => {
  insertUserMessage({
    conversationId: 'qq_group_700',
    content: '测试消息',
    speakerId: '111',
    speakerName: '小明',
    clientMsgId: 'cnt-1',
  });
  assert.ok(getMessageCount('qq_group_700') >= 1);
});

test('清理临时数据库', () => {
  getDb().close();
  rmSync(tmpDir, { recursive: true, force: true });
  assert.ok(true);
});
