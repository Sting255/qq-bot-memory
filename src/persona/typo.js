/**
 * 错别字生成器：同音字/近音字替换，模拟真人打字失误。
 *
 * 移植自 MaiBot v1.3.14 的 src/chat/utils/typo_generator.py，改用 Node 的
 * pinyin-pro 与 segmentit 替代 jieba + pypinyin。
 *
 * 与麦麦的差异：
 * - 麦麦用 jieba 词频 + 汉字字频双重筛选候选字，这里用「常用字表 + 同音分组」
 *   做等价约束：候选只从 3755 个常用汉字里选，避免冒出个生僻字露馅。
 * - 麦麦的整词替换依赖词频表，这里用分词后的整词同音替换，规则更简单。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinyin } from 'pinyin-pro';
import segmentit from 'segmentit';

const { Segment, useDefault } = segmentit;
const segmenter = useDefault(new Segment());

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 汉字字频表（12010 字）。错别字候选按字频加权，保证选出的错字都是常见字。 */
let charFrequency = null;

function getCharFrequency() {
  if (charFrequency) return charFrequency;
  try {
    charFrequency = JSON.parse(readFileSync(resolve(ROOT, 'data/char_frequency.json'), 'utf8'));
  } catch {
    charFrequency = {};
  }
  return charFrequency;
}

/** 最低字频阈值：低于此值的字不进候选池，避免出现「龚」「蜗」这类生僻字。 */
const MIN_CHAR_FREQUENCY = 1.0;

/** 候选字与原字的字频差异上限，防止把高频字错成低频字。 */
const MAX_FREQUENCY_RATIO = 0.25;

/**
 * GB2312 一级汉字，共 3755 字，覆盖日常用字。
 * 刻意不取二级字区（0xD8-0xF7）：那里大量是化学元素、地名等生僻字，
 * 替换成「钔」「龚」这类字反而露馅，真人打字不会错成这样。
 */
function buildCommonChars() {
  const chars = [];
  for (let hi = 0xb0; hi <= 0xd7; hi += 1) {
    for (let lo = 0xa1; lo <= 0xfe; lo += 1) {
      try {
        const decoded = new TextDecoder('gbk').decode(Buffer.from([hi, lo]));
        if (decoded.length === 1 && /[\u4e00-\u9fff]/.test(decoded)) {
          chars.push(decoded);
        }
      } catch {
        // 非法 GB2312 码位，跳过
      }
    }
  }
  return chars;
}

/** 拼音 → 同音字列表。懒构建，只建一次，只收录字频达标的常用字。 */
let homophoneIndex = null;

function getHomophoneIndex() {
  if (homophoneIndex) return homophoneIndex;
  const freq = getCharFrequency();
  homophoneIndex = new Map();
  for (const char of buildCommonChars()) {
    const charFreq = freq[char] ?? 0;
    if (charFreq < MIN_CHAR_FREQUENCY) continue;
    const py = pinyin(char, { toneType: 'none', type: 'string' });
    if (!py) continue;
    if (!homophoneIndex.has(py)) homophoneIndex.set(py, []);
    homophoneIndex.get(py).push(char);
  }
  return homophoneIndex;
}

/**
 * 按字频加权的候选选择：高频字更可能被选中。
 * 真人打字错的是「同音字里比较常见的那个」，不是随机挑一个同音字。
 */
function pickWeighted(candidates, random) {
  if (candidates.length === 0) return null;
  const freq = getCharFrequency();
  const weights = candidates.map((char) => Math.max(0.01, freq[char] ?? 0.01));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = random() * total;
  for (let i = 0; i < candidates.length; i += 1) {
    cursor -= weights[i];
    if (cursor <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

const CHINESE_CHAR_RE = /[\u4e00-\u9fff]/;

function isChineseChar(char) {
  return CHINESE_CHAR_RE.test(char);
}

function segmentSentence(sentence) {
  return segmenter.doSegment(String(sentence || ''), { simple: true });
}

/**
 * 按中文/非中文切分文本，保留原始字符与空格。
 *
 * 分词器（segmentit）会吞掉空格与非中文边界，直接整段分词会把
 * "hello 123" 变成 "hello123"。所以先按字符类型切块，只对中文块分词。
 */
function splitByScript(text) {
  const chunks = [];
  let buffer = '';
  let bufferIsChinese = null;
  for (const char of text) {
    const isChinese = isChineseChar(char);
    if (bufferIsChinese === null || isChinese === bufferIsChinese) {
      buffer += char;
      bufferIsChinese = isChinese;
      continue;
    }
    chunks.push({ text: buffer, isChinese: bufferIsChinese });
    buffer = char;
    bufferIsChinese = isChinese;
  }
  if (buffer) chunks.push({ text: buffer, isChinese: bufferIsChinese });
  return chunks;
}

function getWordPinyin(word) {
  return pinyin(word, { toneType: 'num', type: 'array' });
}

/** 去掉声调数字，得到无声调拼音。 */
function stripTone(py) {
  return String(py || '').replace(/\d/g, '');
}

/**
 * 取与给定字同音、且字频不会骤降的候选字。
 * 声调相同优先，其次允许声调不同的同音字（模拟「声调错误」）。
 */
function getSimilarChars(char, toneErrorRate = 0.1, random = Math.random) {
  const index = getHomophoneIndex();
  const freq = getCharFrequency();
  const pyWithTone = pinyin(char, { toneType: 'num', type: 'string' });
  if (!pyWithTone) return [];

  const toneMatch = /^([a-z]+)(\d)?$/.exec(pyWithTone);
  if (!toneMatch) return [];
  const [, base] = toneMatch;

  const origFreq = Math.max(0.01, freq[char] ?? 0.01);
  // 候选必须是常见字，且不能比原字冷门太多
  const usable = (index.get(base) || []).filter((candidate) => {
    if (candidate === char) return false;
    const candidateFreq = freq[candidate] ?? 0;
    return candidateFreq >= MIN_CHAR_FREQUENCY && candidateFreq >= origFreq * MAX_FREQUENCY_RATIO;
  });
  if (usable.length === 0) return [];

  // 同音同调优先
  const sameTone = usable.filter(
    (candidate) => pinyin(candidate, { toneType: 'num', type: 'string' }) === pyWithTone,
  );
  if (sameTone.length > 0 && random() >= toneErrorRate) {
    return sameTone;
  }
  return usable;
}

/** 整词同音替换的候选词。 */
function getWordHomophones(word, random = Math.random) {
  const targetPy = getWordPinyin(word).map(stripTone).join('');
  if (!targetPy) return [];
  const candidates = [];
  const index = getHomophoneIndex();
  // 逐字取同音字，只替换其中一个字构成错词，比整词重排更自然
  for (let i = 0; i < word.length; i += 1) {
    const char = word[i];
    if (!isChineseChar(char)) continue;
    const pool = getSimilarChars(char, 0, random).slice(0, 6);
    for (const replacement of pool) {
      const next = word.slice(0, i) + replacement + word.slice(i + 1);
      const nextPy = getWordPinyin(next).map(stripTone).join('');
      if (nextPy === targetPy) candidates.push(next);
    }
  }
  return [...new Set(candidates)].filter((item) => item !== word);
}

/**
 * 生成含错别字的句子。
 *
 * @param {string} sentence 原句
 * @param {object} options
 * @param {number} options.errorRate 单字错字概率
 * @param {number} options.toneErrorRate 声调错误概率
 * @param {number} options.wordReplaceRate 整词替换概率
 * @param {number} options.correctionProbability 生成纠正建议的概率
 * @param {() => number} options.random 随机源，测试时可注入
 * @returns {{text: string, correction: string|null}}
 */
export function createTypoSentence(sentence, options = {}) {
  const {
    errorRate = 0.01,
    toneErrorRate = 0.1,
    wordReplaceRate = 0.006,
    correctionProbability = 0.5,
    random = Math.random,
  } = options;

  const source = String(sentence || '');
  if (!source.trim()) return { text: source, correction: null };

  const parts = [];
  const wordTypos = [];
  const charTypos = [];

  // 按中文段与非中文段切分：分词器会吞掉空格与英文边界，
  // 整段丢进分词会把 "hello 123" 变成 "hello123"，必须分段处理。
  for (const chunk of splitByScript(source)) {
    if (!chunk.isChinese) {
      parts.push(chunk.text);
      continue;
    }

    for (const word of segmentSentence(chunk.text)) {
      // 整词替换
      if (word.length > 1 && random() < wordReplaceRate) {
        const candidates = getWordHomophones(word, random);
        if (candidates.length > 0) {
          const typo = candidates[Math.floor(random() * candidates.length)];
          parts.push(typo);
          wordTypos.push([typo, word]);
          continue;
        }
      }

      // 单字替换：词内字的替换概率随词长衰减，避免长词被拆得太碎
      let wordResult = '';
      for (const char of word) {
        if (!isChineseChar(char)) {
          wordResult += char;
          continue;
        }
        const rate = word.length > 1 ? errorRate * 0.7 ** (word.length - 1) : errorRate;
        if (random() < rate) {
          const pool = getSimilarChars(char, toneErrorRate, random);
          if (pool.length > 0) {
            const typo = pickWeighted(pool, random);
            wordResult += typo;
            charTypos.push([typo, char]);
            continue;
          }
        }
        wordResult += char;
      }
      parts.push(wordResult);
    }
  }

  // 纠正建议：优先从整词错误里选
  let correction = null;
  if (random() < correctionProbability) {
    if (wordTypos.length > 0) {
      correction = wordTypos[Math.floor(random() * wordTypos.length)][1];
    } else if (charTypos.length > 0) {
      correction = charTypos[Math.floor(random() * charTypos.length)][1];
    }
  }

  return { text: parts.join(''), correction };
}
