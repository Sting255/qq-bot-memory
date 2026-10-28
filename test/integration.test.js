/**
 * 端到端冒烟测试：不依赖外部服务，验证「事件 → 判定 → 存储 → 整理」整条链路。
 *
 * 用假 LLM 与假 OneBot 客户端，避免真实调用产生费用与副作用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const tmpDir = mkdtempSync(resolve(tmpdir(), 'bot-test-'));

// 必须在导入业务模块前设置环境变量，config 是模块级求值的
process.env.BOT_DATA_DIR = tmpDir;
process.env.ONEBOT_SELF_ID = '10001';
process.env.LLM_MODEL = 'fake-model';
process.env.LOG_LEVEL = 'error';

const { getDb, insertUserMessage, insertAssistantMessage, listActiveMemories, stats } =
  await import('../src/memory/store.js');
const { TurnScheduler } = await import('../src/trigger/scheduler.js');
const { config } = await import('../src/config.js');
const { normalizeEvent, shouldSkipMessage } = await import('../src/adapters/normalize.js');
const { parseMemories, buildTranscript } = await import('../src/memory/curate.js');

test('数据库初始化与消息写入', () => {
  const db = getDb();
  assert.ok(db, '数据库应可用');

  const result = insertUserMessage({
    conversationId: 'qq_group_1',
    content: '小明: 大家好',
    speakerId: '20002',
    speakerName: '小明',
    clientMsgId: 'msg-1',
  });
  assert.ok(result.rawId > 0);
  assert.equal(result.duplicate, false);

  // 幂等：相同 clientMsgId 不重复写入
  const again = insertUserMessage({
    conversationId: 'qq_group_1',
    content: '小明: 大家好',
    speakerId: '20002',
    speakerName: '小明',
    clientMsgId: 'msg-1',
  });
  assert.equal(again.duplicate, true);
  assert.equal(again.rawId, result.rawId);

  const assistant = insertAssistantMessage({
    conversationId: 'qq_group_1',
    content: '你好呀',
    segments: ['你好呀'],
  });
  assert.ok(assistant.rawId > 0);
  assert.equal(assistant.msgIds.length, 1);
});

test('@ 机器人时调度器必定放行', () => {
  const scheduler = new TurnScheduler({ config, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const messages = [
    {
      messageId: 'at-1',
      text: '@你 在吗',
      isAt: true,
      isMentioned: false,
      isSelf: false,
    },
  ];
  const decision = scheduler.evaluate(messages, {
    isGroup: true,
    recentSelfCount: 0,
    recentTotalCount: 1,
    secondsSinceBotMessage: 100,
  });
  assert.equal(decision.decision, 'trigger');
  assert.ok(decision.detail.includes('强制触发'), `实际 detail: ${decision.detail}`);
});

test('普通群聊消息在低频设置下大概率不触发', () => {
  const scheduler = new TurnScheduler({ config, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const messages = [
    { messageId: 'n-1', text: '今天吃什么', isAt: false, isMentioned: false, isSelf: false },
  ];
  const decision = scheduler.evaluate(messages, {
    isGroup: true,
    recentSelfCount: 0,
    recentTotalCount: 1,
    secondsSinceBotMessage: 10,
  });
  assert.equal(decision.decision, 'wait', `低频下普通消息不应触发: ${decision.detail}`);
});

test('私聊不设门控，直接放行', () => {
  const scheduler = new TurnScheduler({ config, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const decision = scheduler.evaluate(
    [{ messageId: 'p-1', text: '随便说点什么', isAt: false, isMentioned: false, isSelf: false }],
    { isGroup: false, recentSelfCount: 0, recentTotalCount: 1, secondsSinceBotMessage: 10 },
  );
  assert.equal(decision.decision, 'trigger');
});

test('自己发的消息被过滤掉，不参与判定', () => {
  const scheduler = new TurnScheduler({ config, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const decision = scheduler.evaluate(
    [{ messageId: 's-1', text: '我自己说的', isAt: true, isMentioned: false, isSelf: true }],
    { isGroup: true, recentSelfCount: 0, recentTotalCount: 1, secondsSinceBotMessage: 10 },
  );
  assert.equal(decision.decision, 'wait');
});

test('转发事件归一化后纯转发被跳过，带文字则保留', () => {
  const forwardOnly = normalizeEvent(
    {
      post_type: 'message',
      message_type: 'group',
      group_id: 1,
      user_id: 20002,
      message_id: 'f-1',
      sender: { card: '小明' },
      message: [{ type: 'forward', data: { id: 'x' } }],
    },
    { selfId: '10001', ignoreForward: true },
  );
  assert.equal(shouldSkipMessage(forwardOnly), true);

  const withText = normalizeEvent(
    {
      post_type: 'message',
      message_type: 'group',
      group_id: 1,
      user_id: 20002,
      message_id: 'f-2',
      sender: { card: '小明' },
      message: [
        { type: 'forward', data: { id: 'x' } },
        { type: 'text', data: { text: '你看这个' } },
      ],
    },
    { selfId: '10001', ignoreForward: true },
  );
  assert.equal(shouldSkipMessage(withText), false);
  assert.equal(withText.hasForward, true);
});

test('记忆整理解析与发言者标注在群聊场景下正确', () => {
  const rows = [
    { role: 'user', content: '小明: 我喜欢猫', speaker_name: '小明' },
    { role: 'assistant', content: '猫很可爱' },
  ];
  const transcript = buildTranscript(rows, { assistantLabel: '我' });
  assert.ok(transcript.includes('[小明] 小明: 我喜欢猫'));
  assert.ok(transcript.includes('[我] 猫很可爱'));

  const parsed = parseMemories(
    JSON.stringify({ memories: [{ judgment: '喜欢猫', type: 'preference', tags: ['宠物'] }] }),
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].judgment, '喜欢猫');
});

test('统计接口反映实际写入量', () => {
  const current = stats();
  assert.ok(current.rawMessages >= 2, `消息数应至少为 2，实际 ${current.rawMessages}`);
  assert.ok(current.conversations >= 0);
});

test('清理临时数据库', () => {
  const db = getDb();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  assert.ok(true);
});
