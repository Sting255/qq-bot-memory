/**
 * 向量服务 HTTP 客户端。
 *
 * 对接邻舍的 Python 向量服务（FastAPI :8765），接口契约与
 * 邻舍 agent-core/src/services/vectorClient.js 保持一致，便于两边复用同一套服务。
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('vector');

async function fetchWithTimeout(url, options = {}, timeoutMs = config.vector.timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function describeFailure(res) {
  const body = await res.json().catch(() => null);
  const detail = body?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (detail) return JSON.stringify(detail);
  return `HTTP ${res.status}`;
}

/** 单文本嵌入，返回 768 维向量。 */
export async function embedText(text) {
  const res = await fetchWithTimeout(`${config.vector.url}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Embed error: ${await describeFailure(res)}`);
  const data = await res.json();
  return data.embeddings?.[0] ?? data.embedding;
}

/** 批量嵌入。 */
export async function embedBatch(texts) {
  const res = await fetchWithTimeout(`${config.vector.url}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texts }),
  });
  if (!res.ok) throw new Error(`Embed error: ${await describeFailure(res)}`);
  const data = await res.json();
  return data.embeddings;
}

/**
 * 向量检索。
 *
 * @param {string} text 查询文本
 * @param {object} options
 * @param {number} options.topK 返回条数
 * @param {string|string[]|null} options.conversationId 限定会话范围
 * @param {number[]|null} options.embedding 外部查询向量
 * @param {string} options.corpus 语料分区
 * @param {number} options.timeoutMs 超时
 * @returns {Promise<{id: string, score: number, metadata: object, document: string}[]>}
 */
export async function vectorSearch(text, {
  topK = config.vector.topK,
  conversationId = null,
  embedding = null,
  corpus = config.vector.corpus,
  timeoutMs = config.vector.recallTimeoutMs,
} = {}) {
  const res = await fetchWithTimeout(`${config.vector.url}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      top_k: topK,
      conversation_id: conversationId,
      embedding,
      corpus,
    }),
  }, timeoutMs);
  if (!res.ok) throw new Error(`Vector search error: ${await describeFailure(res)}`);
  const data = await res.json();
  return data.results ?? [];
}

/** 写入或更新一条向量。 */
export async function upsertVector(chromaId, text, metadata = {}, fragmentType = null, corpus = config.vector.corpus, embedding = null) {
  const res = await fetchWithTimeout(`${config.vector.url}/upsert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chroma_id: chromaId,
      text,
      metadata,
      fragment_type: fragmentType,
      corpus,
      embedding,
    }),
  });
  if (!res.ok) throw new Error(`Vector upsert error: ${await describeFailure(res)}`);
  return res.json();
}

/** 删除一条向量。 */
export async function deleteVector(chromaId, corpus = config.vector.corpus) {
  const res = await fetchWithTimeout(`${config.vector.url}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chroma_id: chromaId, corpus }),
  });
  if (!res.ok) throw new Error(`Vector delete error: ${await describeFailure(res)}`);
  return res.json();
}

/** 健康检查。 */
export async function healthCheck() {
  try {
    const res = await fetchWithTimeout(`${config.vector.url}/health`, {}, 2500);
    if (!res.ok) return { reachable: false };
    const data = await res.json();
    return { reachable: true, ...data };
  } catch (error) {
    log.debug('向量服务不可达:', error.message);
    return { reachable: false };
  }
}
