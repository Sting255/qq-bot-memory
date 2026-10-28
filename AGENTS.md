# AGENTS.md

给在本仓库工作的 AI 代理 / 开发者的约定。改代码前先读这一份，细节见 `ARCHITECTURE.md`。

## 项目定位

QQ 群/私聊「拟人化记忆机器人」：OneBot 11 接入 + 本地向量记忆 + 拟人化回复。
Node.js 22 + SQLite + 本地向量服务（Python），不依赖任何其他 bot 框架。

设计取向：**像人而不是像助手**。规则越少越好——实测 45 字的极简 prompt 比 1233 字的详细规则生成更自然；不引入 planner 多轮工具循环。

## 改代码看哪里

| 要改什么 | 看哪个文件 |
|---|---|
| 消息接入与归一化 | `src/adapters/normalize.js` |
| 要不要回复、什么时机 | `src/trigger/scheduler.js` `src/trigger/debounce.js` |
| 回复怎么生成 | `src/pipeline/stages.js`（load-context → build-prompt → llm → send） |
| 人格与说话风格 | `src/chat/persona.js`、`src/chat/prompt.md`、`bot_persona` 表 |
| 拟人化加工 | `src/persona/*` |
| 记忆读写 | `src/memory/store.js` `recall.js` `curate.js` `mid-term.js` `gate.js` |
| 识图 | `src/chat/vision.js` |
| 表结构变更 | `src/db/migrations/`（新建文件，id 递增） |

## 硬性约束

1. **绝不把图片发给主聊天模型** `deepseek-v4.1-flash`。它在部分上游不是多模态，
   带图请求返回 502 并触发**账号 10 分钟冷却**，整个机器人会哑掉。
   图片一律走 `src/chat/vision.js` 用 `llm.vision.model`。
2. **不要提交** `config.yaml`、`data/`、`logs/`、`resources/voice/*.mp3`。
   前者含密钥，后者含聊天记录与版权素材。都已写进 `.gitignore`，`git add -f` 能绕过，别绕。
3. **数据库迁移必须同步**。`runMigrations()` 是同步函数，`getDb()` 返回时表必须已就绪。
   改成异步会引发一连串 `SQLITE_ERROR`。
4. **改完跑 `npm test`**（224 个用例）。涉及 `app_meta` 节流的测试要换用独立 conversationId。
5. 重启服务杀 `node src\main.js` 这个进程，**不要按 3001 端口找**——3001 是 NapCat 在监听，杀错会白忙。

## 数据来源与授权

本项目自身以 **MIT** 发布，但以下内容有来源需要说明：

| 内容 | 来源 | 许可 | 处理方式 |
|---|---|---|---|
| `resources/clothing-library.json` | [邻舍.EXE](https://github.com/icecranberry/galgame-with-comfyUI) v3.10 | MIT | 原样收录，保留本说明即可 |
| 防抖节奏、参与度门控、记忆衰减、表达学习 | [MaiBot](https://github.com/Mai-with-u/MaiBot) | GPL-3.0 | **只借鉴思路**，JS 重写，未复制代码 |
| pipeline 分层、迁移框架 | [AstrBot](https://github.com/AstrBotDevs/AstrBot) | AGPL-3.0 | 同上，只借鉴思路 |
| 交接笔记、心跳退避、宪法分离 | [Cortico](https://github.com/Pal-AI-Lab/Cortico) | AGPL-3.0 | 同上，只借鉴思路 |
| 记忆作用域划分 | [KiraraAI](https://github.com/lss233/kirara-ai) | MIT | 同上 |
| 记忆写入门 / 遗忘门 | [MemT-1.0](https://github.com/MemTensor/MemT-1.0) | PolyForm NC | 同上，只借鉴思路 |

规则：**AGPL/GPL 项目的代码一行都不能抄**，只能读设计后用本仓库的风格重写。
新增借鉴内容时，同步更新本表和 `README.md` 的「灵感来源与授权」。

## 迁移既有 bot 的记忆数据

想把别的 bot（含邻舍）的记忆搬进来时，请注意：

### 向量不能直接搬

`data/bot.db` 的 `memory_fragments` 只存判断句原文，向量在独立的 Chroma 服务里，
由 `vector-service` 用 `jina-embeddings-v2-base-zh` 生成。

**不同 embedding 模型的向量空间不兼容**，维度、归一化方式、语义分布都不同。
把邻舍（或任何其他项目）导出的向量直接塞进 Chroma，检索结果会是噪声。

### 正确做法：搬文本，重新嵌入

```js
// 1. 从源项目导出记忆原文（判断句 + 类型 + 重要度）
// 2. 逐条写入本项目的 memory_fragments，embedding_state 置为 'pending'
insertMemory({
  conversationId,          // 目标会话 ID
  judgment,                // 记忆判断句（原文）
  memoryType,              // knowledge / emotion / skill / event
  importance: estimateWriteValue({ judgment, memoryType }),  // 走写入门打分
});

// 3. 索引 worker 会自动认领 pending 任务并生成向量
//    也可以手动 wake：indexWorker.wake()
```

要点：

- **会话 ID 要对齐**：QQ 群的约定是 `qq_group_<群号>`，私聊是 `qq_private_<QQ号>`。
  导错会话等于记忆串到别的群。
- **重要度走写入门**，不要照搬源项目的数值——两边评分尺度不同。
- **原文不要改写**。判断句是给模型读的，保持源项目的措辞比"规范化"更保真。
- 导入是异步的：向量生成失败会自动重试，`memory_index_jobs` 表可查进度。

### 记忆衰减会淘汰旧数据

导入后如果 30 天以上没被召回，遗忘门会逐步降权直至退役（`status='decayed'`）。
批量导入的历史记忆，建议先给较高 `importance`，或临时把 `HALF_LIFE_BASE_DAYS` 调大。

## 提交规范

- 一次改动聚焦一件事；跨模块重构先提方案再动手
- 提交信息写清「改了什么 + 为什么」，不要只写「fix」
- 关键行为变更附测试；纯配置调整可豁免
- 回滚导航见 `HANDOVER.md` 第七节

## 已知坑

| 现象 | 原因 |
|---|---|
| 回复要等 20~50 秒 | 上游是 reasoning 模型，首字前在思考；`首字超时` 阈值 45s |
| `LLM empty（finish_reason=length）` | reasoning 吃光 max_tokens，正文被截空，加大配额 |
| 识图报 `convert media URLs error` | 上游下载不到图片地址，已加双传法与 20 分钟熔断 |
| 群里 56 条/5 分钟时机器人几乎不说话 | 概率被活跃度惩罚压低，属预期；调 `trigger.threshold_scale` |
| 机器人说话太频繁 / 太沉默 | 每小时额度 = `frequency × 窗口内预计回复数`，改 `trigger.frequency` 即可；额度用尽日志会写「本小时额度已用尽」 |
