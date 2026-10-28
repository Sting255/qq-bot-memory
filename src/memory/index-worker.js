/**
 * 记忆索引 worker：把待处理的记忆写入向量库。
 *
 * 与主对话流程解耦——索引失败不影响聊天，任务留在队列里下次重试。
 * 最多重试 MAX_ATTEMPTS 次，超过标记 failed，避免坏数据无限重试烧资源。
 */
import { createLogger } from '../logger.js';
import {
  claimIndexJob,
  finishIndexJob,
  getMemory,
  setMemoryEmbeddingState,
} from './store.js';
import { deleteVector, upsertVector } from './vector-client.js';

const log = createLogger('index');

const MAX_ATTEMPTS = 5;
const IDLE_INTERVAL_MS = 2000;

export class MemoryIndexWorker {
  constructor({ concurrency = 1 } = {}) {
    this.concurrency = concurrency;
    this._active = 0;
    this._running = false;
    this._timer = null;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._pump();
    log.info('索引 worker 已启动');
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /** 有新任务时唤醒，立即尝试处理。 */
  wake() {
    if (!this._running) return;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._pump();
  }

  _pump() {
    if (!this._running) return;

    while (this._active < this.concurrency) {
      const job = claimIndexJob();
      if (!job) break;
      this._active += 1;
      this._runJob(job)
        .catch((error) => log.error(`任务 ${job.id} 异常:`, error.message))
        .finally(() => {
          this._active -= 1;
          this._pump();
        });
    }

    if (this._active === 0 && !this._timer) {
      this._timer = setTimeout(() => {
        this._timer = null;
        this._pump();
      }, IDLE_INTERVAL_MS);
    }
  }

  async _runJob(job) {
    const memory = getMemory(job.memory_id);
    if (!memory) {
      finishIndexJob(job.id, 'completed');
      return;
    }

    try {
      if (job.job_type === 'upsert') {
        if (memory.status !== 'active') {
          finishIndexJob(job.id, 'completed');
          return;
        }
        await upsertVector(
          memory.memory_id,
          memory.judgment,
          {
            conversation_id: memory.conversation_id,
            memory_type: memory.memory_type,
            subject: memory.subject || '',
            importance: memory.importance ?? 1,
          },
          memory.memory_type,
        );
        setMemoryEmbeddingState(memory.memory_id, 'ready', memory.memory_id);
        finishIndexJob(job.id, 'completed');
        log.debug(`已索引记忆 ${memory.memory_id}`);
      } else if (job.job_type === 'delete') {
        await deleteVector(memory.memory_id);
        setMemoryEmbeddingState(memory.memory_id, 'deleted');
        finishIndexJob(job.id, 'completed');
      } else {
        throw new Error(`未知任务类型: ${job.job_type}`);
      }
    } catch (error) {
      const attempts = (Number(job.attempts) || 0) + 1;
      const nextStatus = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      finishIndexJob(job.id, nextStatus, error.message);
      setMemoryEmbeddingState(memory.memory_id, nextStatus === 'failed' ? 'failed' : 'pending');
      if (nextStatus === 'pending') {
        log.warn(`任务 ${job.id} 第 ${attempts}/${MAX_ATTEMPTS} 次失败，稍后重试: ${error.message}`);
      } else {
        log.error(`任务 ${job.id} 已达最大重试次数，标记失败: ${error.message}`);
      }
    }
  }

  status() {
    return { running: this._running, active: this._active, concurrency: this.concurrency };
  }
}
