/**
 * 极简日志：按级别过滤，同时输出控制台与文件。
 * 不引入第三方库，避免为日志增加依赖。
 *
 * 按天分文件（bot-YYYY-MM-DD.log），保留 7 天。单文件只增不减的话，
 * 跑几个月就有几十 MB，查问题时在一个大文件里翻也很慢。
 */
import { appendFileSync, mkdirSync, readdirSync, unlinkSync, existsSync, renameSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.log.level] ?? LEVELS.info;

/** 日志保留天数。 */
const KEEP_DAYS = 7;

let logPath = null;
let logDay = '';

function currentDay() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 配置里的日志路径拆成目录和文件名前缀。 */
function logTarget() {
  const configured = resolve(config.root, config.log.file);
  return {
    dir: dirname(configured),
    base: basename(configured, extname(configured)),
  };
}

function resolveLogPath() {
  const day = currentDay();
  // 跨天时重新算文件名，否则零点之后还往昨天的文件里写
  if (logPath && logDay === day) return logPath;

  const { dir, base } = logTarget();
  mkdirSync(dir, { recursive: true });
  logPath = resolve(dir, `${base}-${day}.log`);
  logDay = day;
  return logPath;
}

/** 当前正在写入的日志文件路径，供面板读取。 */
export function getCurrentLogPath() {
  return resolveLogPath();
}

/**
 * 清理过期日志，并把旧版单文件 bot.log 迁进当天。
 *
 * @returns {number} 删除的文件数
 */
export function cleanupOldLogs(keepDays = KEEP_DAYS) {
  const { dir, base } = logTarget();
  if (!existsSync(dir)) return 0;

  let removed = 0;
  const pattern = new RegExp(`^${base}-(\\d{4})-(\\d{2})-(\\d{2})\\.log$`);
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;

  try {
    for (const name of readdirSync(dir)) {
      const match = pattern.exec(name);
      if (!match) continue;
      const fileTime = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00`).getTime();
      if (Number.isNaN(fileTime) || fileTime >= cutoff) continue;
      try {
        unlinkSync(resolve(dir, name));
        removed += 1;
      } catch {
        // 单个删不掉不影响其他
      }
    }

    // 旧版把日志全写在一个 bot.log 里，迁到当天文件，之后按天切
    const legacy = resolve(dir, `${base}.log`);
    if (existsSync(legacy)) {
      const target = resolve(dir, `${base}-${currentDay()}.log`);
      try {
        if (existsSync(target)) unlinkSync(legacy);
        else renameSync(legacy, target);
      } catch {
        // 迁移失败就算了，新日志照样按天写
      }
    }
  } catch {
    // 清理失败不能影响启动
  }

  return removed;
}

function write(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  // 用本地时间。之前用 toISOString() 是 UTC，日志里的时间比实际早 8 小时，
  // 排查时对不上任何东西。
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const prefix = `[${time}] [${level.toUpperCase().padEnd(5)}]`;
  const label = scope ? ` [${scope}]` : '';
  const text = args
    .map((item) => (typeof item === 'string' ? item : safeStringify(item)))
    .join(' ');
  const line = `${prefix}${label} ${text}`;

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  try {
    appendFileSync(resolveLogPath(), `${line}\n`);
  } catch {
    // 日志写盘失败不能影响主流程
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger(scope = '') {
  return {
    debug: (...args) => write('debug', scope, args),
    info: (...args) => write('info', scope, args),
    warn: (...args) => write('warn', scope, args),
    error: (...args) => write('error', scope, args),
  };
}
