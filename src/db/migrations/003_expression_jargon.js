/**
 * 003：表达习惯与黑话学习。
 * - expression_habits：从群聊挖出的常用表达（含向量嵌入，供相似检索）
 * - jargon_terms：群黑话/新词及其含义
 */
export default {
  id: 3,
  name: 'expression-jargon-tables',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS expression_habits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        expression TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'phrase',
        embedding TEXT,
        use_count INTEGER DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_expr_conv ON expression_habits(conversation_id, status);

      CREATE TABLE IF NOT EXISTS jargon_terms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        term TEXT NOT NULL,
        meaning TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(conversation_id, term)
      );
      CREATE INDEX IF NOT EXISTS idx_jargon_conv ON jargon_terms(conversation_id, status);
    `);
  },
};
