# QQ 机器人 Pipeline 化重构方案

> 借鉴 AstrBot 的 pipeline stage 模式，不引入其任何代码（AGPL-3.0）。
> 目标：把 orchestrator/handler 的平铺逻辑拆成可插拔 stage，为生图等新功能铺路。
> 约束：**回话延迟零感知变化**（stage 开销 <1ms），行为完全向后兼容，逐步迁移不停机。

## 一、现状与问题

当前一次回复的路径：`main.js` 收消息 → `handler.js`（触发判定/生图检测/TTS 检测，562+ 行）
→ `orchestrator.respond()`（召回→拼 prompt→流式 LLM→拟人化→发送，424 行）。

问题：
1. handler 里每加一个能力（生图、TTS、web-search）就多一段 if + 预处理，已经 14 个文件堆在 `src/chat/`
2. "回复前检查"（限频、白名单、会话开关）散落在 main.js 和 handler.js
3. 同一用户连发消息时的竞态没有统一处理
4. 没有统一的错误→用户友好话术层

## 二、目标架构

### Stage 模型（照 AstrBot 的 STAGES_ORDER 思想，JS 极简实现）

```
src/pipeline/
  index.js        # runPipeline(ctx, stages)：顺序执行，支持 stage.skip(ctx) 跳过
  context.js      # PipelineContext：{ message, client, config, state, timings, abort }
  stages/
    load-context.js    # 并行召回：历史/画像/长期记忆/中期记忆/启发式/web（现有 Promise.all 原样搬）
    image-tool.js      # 生图触发（从 handler 的检测逻辑迁入）
    voice-tool.js      # TTS 触发
    build-prompt.js    # buildMessages + imageHint/voiceHint 注入
    llm.js             # 流式调用 + cleanReply
    persona.js         # 错别字/分段/quote/typing 延迟
    send.js            # OneBot 发送（含 silent 模式收集）
```

执行顺序即数组顺序；ctx.state 在 stage 间传递（等价于现在的局部变量，但可观测、可测试）。

### 各模块迁移映射（现有代码 → 新位置）

| 现有 | 去向 | 改动量 |
|---|---|---|
| orchestrator.respond 的召回并行块 | load-context stage | 平移，逻辑不变 |
| handler.js 的生图/TTS 检测 | image-tool / voice-tool stage | 提取成函数 |
| buildMessages + hint 注入 | build-prompt stage | 平移 |
| 流式 LLM + 逐句发送循环 | llm + persona + send 三段 | 拆开但复用现有函数 |
| cleanReply | 留在 orchestrator 或移 utils | 不动 |

**不迁移**：adapters/、trigger/（概率触发判定留在 main 入口，它决定"要不要进 pipeline"，不属于 pipeline 内部）、memory/、persona/ 的底层实现。

## 三、附带改进（从 AstrBot 借鉴的小件，随重构顺手做）

1. **错误翻译层**（借鉴 error_redaction + llm_error_messages）：LLM/生图失败时给群友一句自然的话（"卡了，再问一次"），而不是沉默
2. **会话限频/开关 stage**（借鉴 rate_limit_check）：现在散落的地方统一为一个可开关 stage，config 加 `rateLimit` 段
3. **串发竞态**（借鉴 follow_up.py 的 seq 思想）：同一 conversationId 上一条还在生成时，新消息排队或丢弃（按 config 选择），防止两条回复交错刷屏
4. **SQLite 迁移机制**（借鉴 db/migration）：加一张 `schema_version` 表 + 顺序迁移脚本目录，为后续表变更铺路（本次只搭架子）

## 四、明确不做

- 不引入 MCP、插件系统、多平台抽象
- 不做 tool loop（生图仍按被动触发关键词检测；LLM 自主调工具等真有需求再说）
- 不改 prompt 内容、不改 persona 行为、不改触发概率——本次纯结构重构

## 五、实施步骤（每步可独立提交、可回滚）

1. **搭 pipeline 骨架**：`src/pipeline/`（index + context），加单测：空 stage 数组、skip、异常传播
2. **平移 load-context + build-prompt + llm**：respond() 改为调 pipeline，旧函数保留导出供测试，跑全量 `npm test` 对比行为
3. **拆 persona + send stage**：流式逐句发送循环搬进 send stage，保持 silent/quote 逻辑逐字不变
4. **迁 handler 的生图/TTS 检测**进 tool stage，handler.js 瘦身为纯分发
5. **加竞态排队 + 错误翻译 + 限频 stage**，config.example.yaml 补对应段
6. **schema_version 迁移架子**，把现有建表语句包装成 001 号迁移
7. **收尾**：更新 README 架构图，删旧代码路径，全量测试

## 六、验收标准

- `npm test` 全绿；现有测试（buildMessages、cleanReply、detectMention 等）不改断言
- 手测：普通聊天、@ 机器人、生图触发、TTS 触发各一轮，回复内容与重构前无可感知差异
- timings 日志保留，确认 recall→首句延迟与重构前同级（±50ms 内）
- handler.js 行数明显下降（预期 <200 行），新能力 = 新 stage 文件，不碰主流程

## 七、风险

| 风险 | 应对 |
|---|---|
| 流式发送拆 stage 后顺序/引用逻辑出错 | 该循环整体平移不重写；步骤 3 单独验证 quote/silent |
| 竞态排队导致消息丢失 | 默认策略为"排队"，config 可切"丢弃"；上线前在测试群验证 |
| 迁移脚本误伤现有 db | 001 迁移只做 CREATE TABLE IF NOT EXISTS 等幂等操作，执行前备份 bot.db |
