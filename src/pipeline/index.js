/**
 * Pipeline 执行器：按序执行 stage 数组。
 *
 * 借鉴 AstrBot 的 STAGES_ORDER 思想（只抄模式，不抄代码）：
 * 一次回复 = 顺序穿过若干 stage，每个 stage 只做一件事。
 *
 * 设计约束：
 * - stage 开销必须可忽略（<1ms/条），不引入任何异步等待
 * - stage 可通过 skip(ctx) 声明跳过（比如未开生图就不过生图 stage）
 * - stage 抛错即中断整条 pipeline，由调用方决定兜底
 */

/** Pipeline 运行上下文。stage 之间只通过 ctx 传数据，不共享闭包。 */
export class PipelineContext {
  /**
   * @param {object} input
   * @param {object} input.message 归一化后的消息
   * @param {object} input.client OneBot 客户端
   * @param {object} [input.options] respond 的可选项（assistantLabel/imageHint/voiceHint/silent）
   */
  constructor({ message, client, options = {} }) {
    this.message = message;
    this.client = client;
    this.options = options;
    this.conversationId = message.conversationId;

    /** stage 间共享的状态：召回结果、prompt、回复分段等。 */
    this.state = {
      history: [],
      memories: [],
      profiles: [],
      midTerm: null,
      heuristicBlock: '',
      webContext: '',
      messages: [],          // 发给 LLM 的消息列表
      sent: [],              // 已发出的句子
      replied: false,
      quoted: false,
    };

    /** 计时与中止标记。 */
    this.timings = {};
    this.t0 = Date.now();
    this.aborted = false;
  }

  /** 累计耗时（毫秒）。 */
  elapsed() {
    return Date.now() - this.t0;
  }
}

/**
 * 顺序执行 stage 列表。
 *
 * @param {PipelineContext} ctx
 * @param {Array<{name: string, skip?: (ctx) => boolean, run: (ctx) => Promise<void>|void}>} stages
 * @returns {Promise<PipelineContext>} ctx 本身
 */
export async function runPipeline(ctx, stages) {
  for (const stage of stages) {
    if (ctx.aborted) break;
    if (typeof stage.skip === 'function' && stage.skip(ctx)) continue;
    const stageStart = Date.now();
    await stage.run(ctx);
    ctx.timings[stage.name] = Date.now() - stageStart;
  }
  return ctx;
}
