/**
 * SQLite 存储：对话原始记录 + 长期记忆 + 检索索引。
 *
 * 表结构参照邻舍 agent-core 的设计，但只保留本 bot 需要的部分：
 * - raw_messages / messages：对话流水，记忆整理的取数来源
 * - memory_fragments：长期记忆（判断句）
 * - memory_index_jobs：向量索引任务队列
 * - conversation_state：每会话的记忆整理检查点与轮次计数
 * - recall_audit：召回审计，便于排查「为什么没想起来」
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { config, ensureDirs } from '../config.js';
import { createLogger } from '../logger.js';
import { runMigrations } from '../db/migrate.js';

const log = createLogger('store');

let db = null;

export function getDb() {
  if (db) return db;
  ensureDirs();
  const dbPath = resolve(config.dataDir, 'bot.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // 同步迁移：返回时库一定已就绪
  runMigrations(db);
  log.info('数据库已就绪:', dbPath);
  return db;
}

/**
 * 写入一条用户消息。
 *
 * @param {object} params
 * @param {string} params.conversationId 会话 ID
 * @param {string} params.content 消息内容（含发言者标注）
 * @param {string} params.speakerId 发言者 QQ 号
 * @param {string} params.speakerName 发言者显示名
 * @param {string} params.clientMsgId 平台消息 ID，用于幂等
 * @returns {{rawId: number, msgId: number, duplicate: boolean}}
 */
export function insertUserMessage({ conversationId, content, speakerId, speakerName, clientMsgId }) {
  const database = getDb();

  // 去重靠唯一索引 + INSERT OR IGNORE，不用「先查后插」：
  // 后者在并发下两个请求同时通过检查，第二个撞 unique 约束报错。
  const raw = database
    .prepare(`INSERT OR IGNORE INTO raw_messages (conversation_id, role, content, speaker_id, speaker_name, client_msg_id)
              VALUES (?, 'user', ?, ?, ?, ?)`)
    .run(conversationId, content, speakerId ?? null, speakerName ?? null, clientMsgId ?? null);

  // changes = 0 表示命中唯一索引，说明这条消息已经存过
  if (raw.changes === 0) {
    const existing = database
      .prepare('SELECT id FROM raw_messages WHERE client_msg_id = ?')
      .get(String(clientMsgId));
    const msg = existing
      ? database.prepare('SELECT id FROM messages WHERE raw_id = ? AND role = ?').get(existing.id, 'user')
      : null;
    return { rawId: existing?.id ?? null, msgId: msg?.id ?? null, duplicate: true };
  }

  const msg = database
    .prepare(`INSERT INTO messages (conversation_id, raw_id, role, content, seq, speaker_id, speaker_name)
              VALUES (?, ?, 'user', ?, 0, ?, ?)`)
    .run(conversationId, raw.lastInsertRowid, content, speakerId ?? null, speakerName ?? null);

  return { rawId: raw.lastInsertRowid, msgId: msg.lastInsertRowid, duplicate: false };
}

/**
 * 写入一条机器人回复。
 *
 * @returns {{rawId: number, msgIds: number[]}}
 */
export function insertAssistantMessage({ conversationId, content, segments = [] }) {
  const database = getDb();
  const raw = database
    .prepare(`INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)`)
    .run(conversationId, content);

  const msgIds = [];
  const list = segments.length > 0 ? segments : [content];
  const stmt = database.prepare(
    `INSERT INTO messages (conversation_id, raw_id, role, content, seq) VALUES (?, ?, 'assistant', ?, ?)`,
  );
  list.forEach((segment, index) => {
    const result = stmt.run(conversationId, raw.lastInsertRowid, segment, index);
    msgIds.push(result.lastInsertRowid);
  });

  database
    .prepare(`UPDATE conversation_state SET last_bot_message_at = ?, updated_at = CURRENT_TIMESTAMP
              WHERE conversation_id = ?`)
    .run(Math.floor(Date.now() / 1000), conversationId);

  return { rawId: raw.lastInsertRowid, msgIds };
}

/** 取会话状态，不存在则创建。 */
/**
 * 取会话状态，不存在则创建。
 *
 * 用 INSERT OR IGNORE 而不是「先查后插」：后者在并发下两个请求
 * 同时查不到、同时插入，第二个就会撞 UNIQUE 约束。日志里
 * `UNIQUE constraint failed: conversation_state.conversation_id`
 * 就是这个竞态。
 */
export function getConversationState(conversationId) {
  const database = getDb();
  database
    .prepare('INSERT OR IGNORE INTO conversation_state (conversation_id) VALUES (?)')
    .run(conversationId);
  return database
    .prepare('SELECT * FROM conversation_state WHERE conversation_id = ?')
    .get(conversationId);
}

/** 更新记忆整理检查点。 */
export function setCheckpoint(conversationId, lastRawMsgId, status = 'idle') {
  getDb()
    .prepare(`UPDATE conversation_state
              SET last_raw_msg_id = ?, curate_status = ?, updated_at = CURRENT_TIMESTAMP
              WHERE conversation_id = ?`)
    .run(lastRawMsgId, status, conversationId);
}

/** 轮次计数 +1，返回新值。 */
export function incrementRound(conversationId) {
  const database = getDb();
  getConversationState(conversationId);
  database
    .prepare(`UPDATE conversation_state
              SET rounds_since_curate = rounds_since_curate + 1,
                  total_rounds = total_rounds + 1,
                  updated_at = CURRENT_TIMESTAMP
              WHERE conversation_id = ?`)
    .run(conversationId);
  return getConversationState(conversationId);
}

/** 重置轮次计数（整理完成后调用）。 */
export function resetRoundCounter(conversationId) {
  getDb()
    .prepare(`UPDATE conversation_state SET rounds_since_curate = 0, updated_at = CURRENT_TIMESTAMP
              WHERE conversation_id = ?`)
    .run(conversationId);
}

/**
 * 取指定 id 区间内的原始消息，供记忆整理使用。
 *
 * @param {string} conversationId 会话 ID
 * @param {number} afterRawId 起始 id（不含）
 * @param {number} throughRawId 结束 id（含）
 */
export function selectRawMessages(conversationId, afterRawId, throughRawId) {
  return getDb()
    .prepare(`SELECT id, role, content, speaker_id, speaker_name, created_at FROM raw_messages
              WHERE conversation_id = ? AND id > ? AND id <= ?
              ORDER BY id ASC`)
    .all(conversationId, afterRawId, throughRawId);
}

/** 取最近 N 条消息用于对话上下文。 */
export function selectRecentMessages(conversationId, limit = 20) {
  return getDb()
    .prepare(`SELECT role, content, speaker_id, speaker_name, created_at FROM messages
              WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`)
    .all(conversationId, limit)
    .reverse();
}

/**
 * 写入一条长期记忆并排入向量索引队列。
 *
 * @returns {string} memoryId
 */
export function insertMemory({
  conversationId,
  judgment,
  memoryType = 'knowledge',
  reasoning = '',
  tags = [],
  subject = '',
  importance = 1,
  sourceRawStartId = null,
  sourceRawEndId = null,
}) {
  const database = getDb();
  const memoryId = `mem_${crypto.randomUUID()}`;
  const transaction = database.transaction(() => {
    database
      .prepare(`INSERT INTO memory_fragments
                (memory_id, conversation_id, memory_type, judgment, reasoning, tags, subject,
                 importance, status, embedding_state, source_raw_start_id, source_raw_end_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 'pending', ?, ?)`)
      .run(
        memoryId, conversationId, memoryType, judgment, reasoning,
        JSON.stringify(tags), subject, importance, sourceRawStartId, sourceRawEndId,
      );
    database
      .prepare(`INSERT INTO memory_index_jobs (job_type, memory_id, status) VALUES ('upsert', ?, 'pending')`)
      .run(memoryId);
  });
  transaction();
  return memoryId;
}

/** 取待处理的索引任务。 */
export function claimIndexJob() {
  const database = getDb();
  const job = database
    .prepare(`SELECT * FROM memory_index_jobs WHERE status = 'pending' ORDER BY id LIMIT 1`)
    .get();
  if (!job) return null;
  database
    .prepare(`UPDATE memory_index_jobs SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(job.id);
  return job;
}

/** 标记索引任务完成。 */
export function finishIndexJob(jobId, status = 'completed', error = null) {
  getDb()
    .prepare(`UPDATE memory_index_jobs
              SET status = ?, error = ?, attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`)
    .run(status, error ? String(error).slice(0, 500) : null, jobId);
}

/** 取记忆详情。 */
export function getMemory(memoryId) {
  return getDb().prepare('SELECT * FROM memory_fragments WHERE memory_id = ?').get(memoryId);
}

/** 标记记忆的向量状态。 */
export function setMemoryEmbeddingState(memoryId, state, chromaId = null) {
  getDb()
    .prepare(`UPDATE memory_fragments
              SET embedding_state = ?, chroma_id = COALESCE(?, chroma_id), updated_at = CURRENT_TIMESTAMP
              WHERE memory_id = ?`)
    .run(state, chromaId, memoryId);
}

/** 取会话内活跃记忆，供召回失败时降级使用。 */
export function listActiveMemories(conversationId, limit = 20) {
  return getDb()
    .prepare(`SELECT memory_id, judgment, memory_type, importance, created_at
              FROM memory_fragments
              WHERE conversation_id = ? AND status = 'active'
              ORDER BY importance DESC, created_at DESC LIMIT ?`)
    .all(conversationId, limit);
}

/** 有消息记录的活跃会话 ID 列表，供心跳遍历。 */
export function listActiveConversations(limit = 20) {
  return getDb()
    .prepare(`SELECT DISTINCT conversation_id FROM raw_messages
              WHERE created_at >= datetime('now', '-7 days')
              LIMIT ?`)
    .all(limit)
    .map((row) => row.conversation_id);
}

/** 写召回审计。 */
export function auditRecall({ conversationId, query, hitCount, source, elapsedMs }) {
  try {
    getDb()
      .prepare(`INSERT INTO recall_audit (conversation_id, query, hit_count, source, elapsed_ms)
                VALUES (?, ?, ?, ?, ?)`)
      .run(conversationId, String(query).slice(0, 500), hitCount, source, elapsedMs);
  } catch (error) {
    log.warn('召回审计写入失败:', error.message);
  }
}

/** 取会话内最新一条原始消息 id。 */
export function getLatestRawId(conversationId) {
  const row = getDb()
    .prepare('SELECT MAX(id) AS id FROM raw_messages WHERE conversation_id = ?')
    .get(conversationId);
  return row?.id ?? 0;
}

/** 取会话内消息总数，供启发式召回节流使用。 */
export function getMessageCount(conversationId) {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS count FROM raw_messages WHERE conversation_id = ?')
    .get(conversationId);
  return row?.count ?? 0;
}

/**
 * 取最近一段时间内的活跃度统计。
 *
 * 供概率模型用：说话占比高说明自己说太多该收敛，消息多说明群里正热。
 *
 * @param {string} conversationId 会话 ID
 * @param {number} windowSec 时间窗口（秒）
 * @returns {{selfCount: number, totalCount: number}}
 */
export function getRecentActivity(conversationId, windowSec = 300) {
  const database = getDb();
  const row = database
    .prepare(`SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS self
              FROM raw_messages
              WHERE conversation_id = ?
                AND created_at >= datetime('now', ?)`)
    .get(conversationId, `-${Math.max(1, Math.floor(windowSec))} seconds`);
  return {
    totalCount: Number(row?.total) || 0,
    selfCount: Number(row?.self) || 0,
  };
}

/**
 * 会话的静默秒数：最近一条消息距今多久（无消息返回窗口时长）。
 * 供心跳主动性判断「够不够安静」。
 */
export function quietSecondsSince(conversationId) {
  const row = getDb()
    .prepare(`SELECT MAX(created_at) AS last
              FROM raw_messages WHERE conversation_id = ?`)
    .get(conversationId);
  if (!row?.last) return Infinity;
  const lastMs = Date.parse(String(row.last).replace(' ', 'T') + 'Z');
  if (!Number.isFinite(lastMs)) return Infinity;
  // SQLite CURRENT_TIMESTAMP 是 UTC
  return Math.max(0, Math.round((Date.now() - lastMs) / 1000));
}

/** 取指定 id 区间内的原始消息（含两端），供中期记忆摘要使用。 */
export function selectRawMessagesBetween(conversationId, fromRawId, toRawId) {
  return getDb()
    .prepare(`SELECT id, role, content, speaker_id, speaker_name, created_at FROM raw_messages
              WHERE conversation_id = ? AND id >= ? AND id <= ?
              ORDER BY id ASC`)
    .all(conversationId, fromRawId, toRawId);
}

/**
 * 写入一条中期记忆。
 *
 * @returns {number} 自增 id
 */
export function insertMidTermMemory({
  conversationId,
  summary,
  recallCues,
  cueEmbeddings,
  participants,
  timeRange,
  sourceRawStartId,
  sourceRawEndId,
}) {
  const result = getDb()
    .prepare(`INSERT INTO mid_term_memory
              (conversation_id, summary, recall_cues, cue_embeddings, participants, time_range,
               source_raw_start_id, source_raw_end_id, embedding_state)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready')`)
    .run(
      conversationId,
      summary,
      JSON.stringify(recallCues || []),
      JSON.stringify(cueEmbeddings || []),
      participants || '',
      timeRange || '',
      sourceRawStartId ?? null,
      sourceRawEndId ?? null,
    );
  return result.lastInsertRowid;
}

/** 取会话内最近的中期记忆，供召回匹配。 */
export function listMidTermMemory(conversationId, limit = 20) {
  return getDb()
    .prepare(`SELECT * FROM mid_term_memory
              WHERE conversation_id = ?
              ORDER BY id DESC LIMIT ?`)
    .all(conversationId, limit);
}

/**
 * 取最近一条中期记忆（不做相似度匹配），供 recent-notes 交接笔记使用。
 *
 * 解决的盲区：对话刚被裁出短期上下文时，若当前消息与召回线索不相似，
 * 「刚刚还在聊的事」会彻底消失。recent-notes 让最近脉络无条件在场，
 * 超时后自动退场（判断在调用方）。
 *
 * @param {string} conversationId
 * @param {number} maxAgeMs 只取生成时间在此范围内的记忆
 * @returns {object|null} 最近一条记忆行，无则 null
 */
export function latestMidTermMemory(conversationId, maxAgeMs = Infinity) {
  const row = getDb()
    .prepare(`SELECT * FROM mid_term_memory
              WHERE conversation_id = ?
              ORDER BY id DESC LIMIT 1`)
    .get(conversationId);
  if (!row) return null;
  if (!Number.isFinite(maxAgeMs) && maxAgeMs !== Infinity) {
    const created = Date.parse(row.created_at || '');
    if (Number.isFinite(created) && Date.now() - created > maxAgeMs) return null;
  }
  return row;
}

/** 标记一条中期记忆被召回一次。 */
export function markMidTermRecalled(id) {
  getDb()
    .prepare('UPDATE mid_term_memory SET recalled_count = recalled_count + 1 WHERE id = ?')
    .run(id);
}

/**
 * 取某人在指定会话下相关的活跃记忆。
 *
 * 来源优先级：
 * 1. 个人子语境 `qq_group_X_u<QQ号>` —— 最精准，不依赖名字
 * 2. 主会话里 subject 或 tags 命中该人名字的记忆 —— 补充，名字可能改所以是辅助
 */
export function listActiveMemoriesByPerson({ conversationId, personId, personName, limit = 40 }) {
  const subContextId = `${conversationId}_u${personId}`;
  const name = String(personName || '').trim();
  return getDb()
    .prepare(`SELECT memory_id, judgment, memory_type, subject, tags
              FROM memory_fragments
              WHERE status = 'active'
                AND (
                  conversation_id = ?
                  OR (
                    conversation_id = ?
                    AND ? != ''
                    AND (subject = ? OR tags LIKE ?)
                  )
                )
              ORDER BY importance DESC, created_at DESC
              LIMIT ?`)
    .all(
      subContextId,
      conversationId,
      name,
      name,
      name ? `%${name}%` : '',
      limit,
    );
}

/** 写入或更新人物画像。 */
export function upsertPersonProfile({
  conversationId,
  personId,
  personName,
  profileText,
  factCount,
  sourceMemoryIds,
}) {
  getDb()
    .prepare(`INSERT INTO person_profile
              (conversation_id, person_id, person_name, profile_text, fact_count, source_memory_ids, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(conversation_id, person_id) DO UPDATE SET
                person_name = excluded.person_name,
                profile_text = excluded.profile_text,
                fact_count = excluded.fact_count,
                source_memory_ids = excluded.source_memory_ids,
                updated_at = CURRENT_TIMESTAMP`)
    .run(
      conversationId,
      String(personId),
      personName || '',
      profileText,
      factCount,
      JSON.stringify(sourceMemoryIds || []),
    );
}

/** 读取某人画像。 */
export function getPersonProfile(conversationId, personId) {
  return getDb()
    .prepare('SELECT * FROM person_profile WHERE conversation_id = ? AND person_id = ?')
    .get(conversationId, String(personId));
}

/** 统计概览。 */
export function stats() {
  const database = getDb();
  return {
    rawMessages: database.prepare('SELECT COUNT(*) c FROM raw_messages').get().c,
    memories: database.prepare(`SELECT COUNT(*) c FROM memory_fragments WHERE status = 'active'`).get().c,
    pendingJobs: database.prepare(`SELECT COUNT(*) c FROM memory_index_jobs WHERE status = 'pending'`).get().c,
    conversations: database.prepare('SELECT COUNT(*) c FROM conversation_state').get().c,
    midTermMemories: database.prepare('SELECT COUNT(*) c FROM mid_term_memory').get().c,
    profiles: database.prepare('SELECT COUNT(*) c FROM person_profile').get().c,
  };
}

/** 会话列表，供 WebUI 展示。 */
export function listConversations() {
  return getDb()
    .prepare(`SELECT s.conversation_id,
                     s.total_rounds,
                     s.last_bot_message_at,
                     s.updated_at,
                     (SELECT COUNT(*) FROM raw_messages r WHERE r.conversation_id = s.conversation_id) AS message_count,
                     (SELECT COUNT(*) FROM memory_fragments m
                       WHERE m.conversation_id = s.conversation_id AND m.status = 'active') AS memory_count
              FROM conversation_state s
              ORDER BY s.updated_at DESC`)
    .all();
}

/** 列出记忆，支持按会话过滤，供 WebUI 展示。 */
export function listMemoriesForUi({ conversationId = '', limit = 50, offset = 0 } = {}) {
  const database = getDb();
  const where = conversationId
    ? `WHERE status = 'active' AND conversation_id = ?`
    : `WHERE status = 'active'`;
  const params = conversationId ? [conversationId] : [];
  const rows = database
    .prepare(`SELECT memory_id, conversation_id, memory_type, judgment, subject, tags,
                     importance, embedding_state, created_at
              FROM memory_fragments ${where}
              ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  const total = database
    .prepare(`SELECT COUNT(*) c FROM memory_fragments ${where}`)
    .get(...params).c;
  return { rows, total };
}

/** 列出中期记忆，供 WebUI 展示。 */
export function listMidTermForUi(limit = 30) {
  return getDb()
    .prepare(`SELECT id, conversation_id, summary, recall_cues, participants, time_range,
                     recalled_count, created_at
              FROM mid_term_memory ORDER BY id DESC LIMIT ?`)
    .all(limit);
}

/** 列出人物画像，供 WebUI 展示。 */
export function listProfilesForUi(limit = 30) {
  return getDb()
    .prepare(`SELECT conversation_id, person_id, person_name, profile_text, fact_count, updated_at
              FROM person_profile ORDER BY updated_at DESC LIMIT ?`)
    .all(limit);
}

/** 最近的召回审计记录，供 WebUI 排查召回问题。 */
export function listRecallAudit(limit = 30) {
  return getDb()
    .prepare(`SELECT conversation_id, query, hit_count, source, elapsed_ms, created_at
              FROM recall_audit ORDER BY id DESC LIMIT ?`)
    .all(limit);
}

/** 删除一条长期记忆（软删除）。 */
export function softDeleteMemory(memoryId) {
  const result = getDb()
    .prepare(`UPDATE memory_fragments SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
              WHERE memory_id = ?`)
    .run(memoryId);
  return result.changes > 0;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
