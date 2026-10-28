/** 追认初始建表：从 memory/store.js 原样平移，全部 IF NOT EXISTS 幂等。 */
const SCHEMA = `CREATE TABLE IF NOT EXISTS raw_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      speaker_id TEXT,
      speaker_name TEXT,
      client_msg_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_raw_conv ON raw_messages(conversation_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_client_msg
      ON raw_messages(client_msg_id) WHERE client_msg_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      raw_id INTEGER,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      images TEXT,
      seq INTEGER DEFAULT 0,
      speaker_id TEXT,
      speaker_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (raw_id) REFERENCES raw_messages(id)
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);

    CREATE TABLE IF NOT EXISTS memory_fragments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'knowledge',
      judgment TEXT NOT NULL,
      reasoning TEXT,
      tags TEXT,
      subject TEXT,
      importance REAL DEFAULT 1.0,
      status TEXT NOT NULL DEFAULT 'active',
      chroma_id TEXT,
      embedding_state TEXT DEFAULT 'pending',
      source_raw_start_id INTEGER,
      source_raw_end_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_mem_conv ON memory_fragments(conversation_id, status);
    CREATE INDEX IF NOT EXISTS idx_mem_embedding ON memory_fragments(embedding_state);

    CREATE TABLE IF NOT EXISTS memory_index_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_type TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_job_status ON memory_index_jobs(status, id);

    CREATE TABLE IF NOT EXISTS conversation_state (
      conversation_id TEXT PRIMARY KEY,
      last_raw_msg_id INTEGER DEFAULT 0,
      rounds_since_curate INTEGER DEFAULT 0,
      total_rounds INTEGER DEFAULT 0,
      last_bot_message_at INTEGER,
      curate_status TEXT DEFAULT 'idle',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS recall_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      query TEXT NOT NULL,
      hit_count INTEGER DEFAULT 0,
      source TEXT,
      elapsed_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 中期记忆：被裁出短期上下文的对话压缩成摘要 + 召回线索。
    -- 解决「只有最近 N 条 + 长期向量记忆」中间断层的问题：
    -- 群里聊 100 条时，前面 80 条的脉络靠这张表保住。
    CREATE TABLE IF NOT EXISTS mid_term_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      recall_cues TEXT NOT NULL,
      cue_embeddings TEXT,
      participants TEXT,
      time_range TEXT,
      source_raw_start_id INTEGER,
      source_raw_end_id INTEGER,
      recalled_count INTEGER DEFAULT 0,
      embedding_state TEXT DEFAULT 'ready',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_mid_term_conv
      ON mid_term_memory(conversation_id, id);
    CREATE INDEX IF NOT EXISTS idx_mid_term_embedding
      ON mid_term_memory(embedding_state);

    -- 人物画像：按 QQ 号积累对每个人的认知，注入 prompt 用。
    -- 与「按人建子语境」的记忆互补：子语境存该人的对话记忆，
    -- 这张表存浓缩的画像摘要，召回更快、注入更省 token。
    CREATE TABLE IF NOT EXISTS person_profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      person_name TEXT,
      profile_text TEXT NOT NULL,
      fact_count INTEGER DEFAULT 0,
      source_memory_ids TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_conv_person
      ON person_profile(conversation_id, person_id);
    CREATE INDEX IF NOT EXISTS idx_profile_person
      ON person_profile(person_id);`;

export default {
  id: 1,
  name: 'init-schema',
  up(db) {
    db.exec(SCHEMA);
  },
};
