/**
 * SQLite 迁移框架（借鉴 AstrBot db/migration 的思想，只做最小实现）。
 *
 * 用法：把每次 schema 变更写成 src/db/migrations/ 里一个导出 { id, name, up(db) } 的模块，
 * id 严格递增。框架按 id 顺序执行未应用的迁移，并在 schema_version 表登记。
 *
 * 注意：runMigrations 是同步的。迁移只允许用 better-sqlite3 的同步 API
 * （exec/prepare），这样 getDb() 返回时库一定已就绪，调用方无需关心异步。
 *
 * 001 号迁移是「追认」：现有建表语句原本直接 exec，现在纳入版本管理。
 * 全部语句保持 IF NOT EXISTS 幂等，老库升级零影响。
 */
import { readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');
const require = createRequire(import.meta.url);

/** 读取已应用的迁移版本。 */
export function appliedMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  return new Set(db.prepare('SELECT id FROM schema_version').all().map((row) => row.id));
}

/**
 * 同步执行所有未应用的迁移（每条一个事务）。
 * @param {import('better-sqlite3').Database} db
 */
export function runMigrations(db) {
  const done = appliedMigrations(db);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort();

  for (const file of files) {
    const migration = require(resolve(MIGRATIONS_DIR, file)).default;
    if (!migration?.id || typeof migration.up !== 'function') continue;
    if (done.has(migration.id)) continue;

    const apply = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_version (id, name) VALUES (?, ?)').run(migration.id, migration.name ?? file);
    });
    apply();
  }
}
