/**
 * 配置文件持久化。
 *
 * 难点：config.yaml 里全是中文注释，用 js-yaml dump 会全部丢失。
 * 折中做法是文本级更新——按 schema 路径找到对应行，只替换值，
 * 注释和格式原样保留。找不到对应行时退回整文件重写。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('config-io');

const CONFIG_PATH = resolve(config.root, 'config.yaml');
const EXAMPLE_PATH = resolve(config.root, 'config.example.yaml');

/** YAML 路径 → 配置文件里的键名（camelCase → snake_case）。 */
function toYamlKey(camelKey) {
  return String(camelKey).replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

/** 把值格式化成 YAML 字面量。 */
function formatYamlValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${value.map((item) => JSON.stringify(String(item))).join(', ')}]`;
  }
  return JSON.stringify(String(value ?? ''));
}

/**
 * 在 YAML 文本里更新一个键的值，保留注释与缩进。
 *
 * 只在该键所属的 section 内查找，避免同名键误改。
 *
 * @param {string} text 原文件内容
 * @param {string} path 点分路径，如 trigger.frequency
 * @param {any} value 新值
 * @returns {{text: string, replaced: boolean}}
 */
export function updateYamlText(text, path, value) {
  const parts = String(path).split('.');
  const yamlKeys = parts.map(toYamlKey);
  const leafKey = yamlKeys[yamlKeys.length - 1];
  const parentKeys = yamlKeys.slice(0, -1);
  const lines = text.split('\n');

  // 定位父级 section 的行范围
  let startLine = 0;
  let endLine = lines.length;
  let cursorIndent = -1;

  for (const parentKey of parentKeys) {
    let found = -1;
    let foundIndent = -1;
    for (let i = startLine; i < endLine; i += 1) {
      const line = lines[i];
      const match = new RegExp(`^(\\s*)${parentKey}:\\s*(#.*)?$`).exec(line);
      if (match) {
        found = i;
        foundIndent = match[1].length;
        break;
      }
    }
    if (found === -1) return { text, replaced: false };
    cursorIndent = foundIndent;
    startLine = found + 1;
    // 找到同缩进的下一个键或文件结束，作为本 section 的边界
    endLine = lines.length;
    for (let i = startLine; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= cursorIndent && /^[\w-]+:/.test(line.trim())) {
        endLine = i;
        break;
      }
    }
  }

  // 在 section 内找叶子键
  const leafIndent = cursorIndent + 2;
  for (let i = startLine; i < endLine; i += 1) {
    const line = lines[i];
    const match = new RegExp(`^(\\s+)${leafKey}:(\\s*)([^#\\n]*)(#.*)?$`).exec(line);
    if (!match) continue;
    const indent = match[1];
    const comment = match[4] ? ` ${match[4]}` : '';
    lines[i] = `${indent}${leafKey}: ${formatYamlValue(value)}${comment}`;
    return { text: lines.join('\n'), replaced: true };
  }

  return { text, replaced: false };
}

/**
 * 持久化多个配置项到 config.yaml。
 *
 * @param {Array<{path: string, value: any}>} updates 待写入的项
 * @returns {{written: number, fallback: boolean}}
 */
export function persistConfigUpdates(updates) {
  if (!updates || updates.length === 0) return { written: 0, fallback: false };

  let text;
  try {
    text = readFileSync(CONFIG_PATH, 'utf8');
  } catch (error) {
    log.error('读取 config.yaml 失败:', error.message);
    return { written: 0, fallback: false };
  }

  // 先备份，写坏了还能恢复
  try {
    copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
  } catch {
    // 备份失败不阻断
  }

  let written = 0;
  const missed = [];
  for (const { path, value } of updates) {
    const result = updateYamlText(text, path, value);
    if (result.replaced) {
      text = result.text;
      written += 1;
    } else {
      missed.push(path);
    }
  }

  // 文本级替换漏掉的项，退回整文件重写（会丢注释，但值正确）
  let fallback = false;
  if (missed.length > 0) {
    fallback = true;
    try {
      const current = yaml.load(text) || {};
      for (const { path, value } of updates) {
        if (!missed.includes(path)) continue;
        const parts = path.split('.');
        let cursor = current;
        for (let i = 0; i < parts.length - 1; i += 1) {
          const key = toYamlKey(parts[i]);
          if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
          cursor = cursor[key];
        }
        cursor[toYamlKey(parts[parts.length - 1])] = value;
      }
      text = yaml.dump(current, { lineWidth: 120, noRefs: true, quotingType: '"' });
      log.warn(`以下配置项退回整文件重写（注释会丢失）: ${missed.join(', ')}`);
    } catch (error) {
      log.error('整文件重写失败:', error.message);
      return { written, fallback: false };
    }
  }

  try {
    writeFileSync(CONFIG_PATH, text, 'utf8');
    log.info(`配置已持久化: ${written}/${updates.length} 项${fallback ? '（含整文件重写）' : ''}`);
  } catch (error) {
    log.error('写入 config.yaml 失败:', error.message);
    return { written, fallback };
  }

  return { written, fallback };
}

/** 从模板重建 config.yaml（保留完整注释）。 */
export function rebuildFromTemplate() {
  if (!existsSync(EXAMPLE_PATH)) {
    throw new Error('config.example.yaml 不存在');
  }
  copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
  log.info('已从模板重建 config.yaml');
}
