/**
 * 002：记忆衰减支持。
 * memory_fragments 加 last_recalled_at（上次被召回命中的时刻）与 recalled_count。
 * 幂等：列存在时跳过 ADD COLUMN；回填按 created_at 近似。
 */
export default {
  id: 2,
  name: 'memory-decay-columns',
  up(db) {
    const columns = db.prepare('PRAGMA table_info(memory_fragments)').all().map((c) => c.name);
    if (!columns.includes('last_recalled_at')) {
      db.exec('ALTER TABLE memory_fragments ADD COLUMN last_recalled_at DATETIME');
    }
    if (!columns.includes('recalled_count')) {
      db.exec('ALTER TABLE memory_fragments ADD COLUMN recalled_count INTEGER DEFAULT 0');
    }
    db.exec(`
      UPDATE memory_fragments
      SET last_recalled_at = created_at
      WHERE last_recalled_at IS NULL AND recalled_count > 0
    `);
  },
};
