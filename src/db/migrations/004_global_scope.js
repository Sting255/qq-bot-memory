/**
 * 004：全局记忆作用域（借鉴 KiraraAI GlobalScope 思想）。
 * memory_fragments.conversation_id 增加约定值 '__global__'，
 * 存 bot 自己的跨群阅历；召回时 OR 查询全局记忆。
 * 语义变更走代码，本迁移只补索引。
 */
export default {
  id: 4,
  name: 'global-memory-scope',
  up(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mem_global
        ON memory_fragments(conversation_id, status)
        WHERE conversation_id = '__global__';
    `);
  },
};
