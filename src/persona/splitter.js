/**
 * 回复分段：把一条长回复拆成多条消息发送。
 *
 * 真人在 IM 里不会发一大段，而是一句一句发。分段本身就是活人感的一部分。
 *
 * 采用规则分段而非麦麦新版的 LLM 分段：规则分段零延迟、零成本，
 * 且中文断句的确定性足够好，不值得为它多一次模型调用。
 */

/** 颜文字保护：成对的括号与常见符号组合不应被拆开。 */
const KAOMOJI_PATTERNS = [
  /\([^)]{0,12}\)/g,
  /（[^）]{0,12}）/g,
  /\[[^\]]{0,12}\]/g,
  /【[^】]{0,12}】/g,
  /[≧≦╥╯╰ω･・∀▽△▽´｀°˚].{0,8}[≧≦╥╯╰ω･・∀▽△▽´｀°˚]/g,
];

const PLACEHOLDER = '\u0000';

/** 把颜文字替换成占位符，避免在括号内部断句。 */
function protectKaomoji(text) {
  const mapping = [];
  let protectedText = text;
  for (const pattern of KAOMOJI_PATTERNS) {
    protectedText = protectedText.replace(pattern, (match) => {
      const token = `${PLACEHOLDER}${mapping.length}${PLACEHOLDER}`;
      mapping.push(match);
      return token;
    });
  }
  return { protectedText, mapping };
}

function restoreKaomoji(text, mapping) {
  return text.replace(
    new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'),
    (_, index) => mapping[Number(index)] ?? '',
  );
}

/** 按中文句末标点断句，保留标点。 */
function splitSentences(text) {
  const sentences = [];
  let buffer = '';
  for (const char of text) {
    buffer += char;
    if ('。！？!?…；;\n'.includes(char)) {
      const trimmed = buffer.trim();
      if (trimmed) sentences.push(trimmed);
      buffer = '';
    }
  }
  const tail = buffer.trim();
  if (tail) sentences.push(tail);
  return sentences;
}

/**
 * 把回复拆成多条待发送消息。
 *
 * @param {string} text LLM 输出的完整回复
 * @param {object} options
 * @param {number} options.maxLength 单条最大字符数
 * @param {number} options.maxSplitNum 最多拆成几条
 * @returns {string[]} 待逐条发送的消息
 */
export function splitReply(text, { maxLength = 200, maxSplitNum = 3 } = {}) {
  const source = String(text || '').trim();
  if (!source) return [];
  if (source.length <= maxLength) return [source];

  const { protectedText, mapping } = protectKaomoji(source);
  const sentences = splitSentences(protectedText);
  if (sentences.length === 0) return [source];

  // 贪心合并：尽量让每段接近 maxLength，避免拆得太碎
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
      continue;
    }
    if (current.length + sentence.length <= maxLength) {
      current += sentence;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);

  // 段数超限时，把多出的段并入最后一段（宁可长一点，也不要发太多条）
  let result = chunks;
  if (chunks.length > maxSplitNum) {
    const head = chunks.slice(0, maxSplitNum - 1);
    const tail = chunks.slice(maxSplitNum - 1).join('');
    result = [...head, tail];
  }

  return result.map((chunk) => restoreKaomoji(chunk, mapping).trim()).filter(Boolean);
}
