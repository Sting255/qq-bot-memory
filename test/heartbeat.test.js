import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const tmpDir = mkdtempSync(resolve(tmpdir(), 'bot-hb-'));
process.env.BOT_DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';
process.env.HEARTBEAT_ENABLED = 'true';

// config 是模块级求值，先设好环境再导入
const { Heartbeat, IDLE_BACKOFF_MAX } = await import('../src/trigger/heartbeat.js');
const { getDb } = await import('../src/memory/store.js');

test.after(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeHeartbeat(spoken = []) {
  return new Heartbeat({
    conversations: () => ['qq_group_1'],
    onSpeak: async (id, text) => spoken.push([id, text]),
  });
}

test('退避倍率按空拍数翻倍且封顶 8 倍', () => {
  const hb = makeHeartbeat();
  assert.equal(hb.nextDelaySec(0), hb.baselineSec);
  assert.equal(hb.nextDelaySec(1), hb.baselineSec * 2);
  assert.equal(hb.nextDelaySec(3), hb.baselineSec * 8);
  assert.equal(hb.nextDelaySec(10), hb.baselineSec * IDLE_BACKOFF_MAX);
});

test('noteActivity 复位空拍计数', () => {
  const hb = makeHeartbeat();
  hb._state.set('qq_group_1', { timer: null, idleTicks: 5, spokenToday: 0, dayKey: hb._dayKey() });
  hb.noteActivity('qq_group_1');
  assert.equal(hb._state.get('qq_group_1').idleTicks, 0);
  // 未知会话不报错
  hb.noteActivity('unknown');
});

test('start/stop 生命周期', () => {
  const hb = makeHeartbeat();
  hb.start();
  assert.ok(hb._running);
  assert.ok(hb._state.has('qq_group_1'));
  hb.stop();
  assert.equal(hb._running, false);
  assert.equal(hb._state.size, 0);
});

test('未启用时 start 不生效', async () => {
  const { config } = await import('../src/config.js');
  const saved = config.trigger.heartbeat.enabled;
  config.trigger.heartbeat.enabled = false;
  const hb = makeHeartbeat();
  hb.start();
  assert.equal(hb._running, false);
  config.trigger.heartbeat.enabled = saved;
});

test('tick：日限已满时空拍递增不开口', async () => {
  const spoken = [];
  const hb = makeHeartbeat(spoken);
  hb._state.set('qq_group_1', { timer: null, idleTicks: 0, spokenToday: hb.dailyLimit, dayKey: hb._dayKey() });
  await hb._tick('qq_group_1');
  assert.equal(spoken.length, 0);
  assert.equal(hb._state.get('qq_group_1').idleTicks, 1);
});
