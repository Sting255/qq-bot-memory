# Architecture

> 改行为先读这张图，再顺着文件引用进代码（纪律借鉴 LangBot）。
> 本文档比功能文档稳定、比 README 具体。每个模块标注 Owner 文件。

## 消息的一生

```
NapCat (OneBot 11 WS)
  → main.js（入口：连接、生命周期）
  → adapters/normalize.js      协议归一化，得 message
  → chat/handler.js            编排中枢（写库、防抖、判定、回复分发）
      ├─ memory/store.js       消息入库（raw_messages/messages）
      ├─ memory/curate.js      记忆整理（异步，不阻塞回复）
      ├─ trigger/debounce.js   防抖状态机（同人/换人/提速/上限）
      ├─ trigger/scheduler.js  概率门控（参与度衰减 + 连续沉默提醒）
      ├─ pipeline/tools.js     生图/语音被动触发检测
      ├─ pipeline/queue.js     会话串行队列
      ├─ chat/orchestrator.js  respond() 入口
      │    └─ pipeline/stages.js  load-context → build-prompt → llm → send
      │         ├─ memory/recall.js    长期记忆召回 + 衰减
      │         ├─ memory/mid-term.js  中期记忆 + recent-notes
      │         ├─ memory/profile.js   人物画像
      │         └─ persona/*           错别字/分段/引用/延迟
      ├─ chat/image.js         生图（nai.rinko.ai）
      └─ chat/tts.js           语音合成
  → adapters/onebot-client.js  发送
```

## 模块地图与 Owner

| 模块 | Owner | 职责 | 改动注意 |
|---|---|---|---|
| 入口/生命周期 | `src/main.js` | 连接管理、自动拉起 NapCat、优雅退出 | 不要放业务逻辑 |
| 协议适配 | `src/adapters/normalize.js` | OneBot 段 → 归一化 message；会话 ID 约定 `qq_group_<id>` / `qq_private_<id>` | 新消息类型在此归一 |
| 编排中枢 | `src/chat/handler.js` | 防抖缓冲、批次判定、工具检测分发、回复后写回 | 只做编排；业务规则在 trigger/、pipeline/ |
| 防抖 | `src/trigger/debounce.js` | SmartDebouncer 状态机（借鉴 MaiBot） | 改节奏参数走 config.trigger.debounce |
| 触发判定 | `src/trigger/scheduler.js` | 概率门控、参与度衰减、连续沉默提醒、空闲退避 | @/提及走强制路径，不受门控影响 |
| 心跳 | `src/trigger/heartbeat.js` | 冷场主动开口（默认关） | 判定权在 LLM，日限在 config |
| 回复管线 | `src/pipeline/index.js` `stages.js` | stage 化执行：召回→拼 prompt→流式生成→发送 | 新增能力 = 新 stage，不改主流程 |
| 工具检测 | `src/pipeline/tools.js` | 生图/语音请求识别 + hint | 在进管线前运行（参与触发决策） |
| 会话队列 | `src/pipeline/queue.js` | 同会话批次串行（排队上限 2） | 任务抛错不能卡队列 |
| 错误翻译 | `src/pipeline/errors.js` | 底层异常 → 群友话术（60s 频控） | 只在零回复时兜底 |
| 长期记忆 | `src/memory/recall.js` `curate.js` | 向量召回、LLM 整理、衰减 | 衰减 24h 节流 |
| 中期记忆 | `src/memory/mid-term.js` | 摘要+召回线索、recent-notes | recent-notes 与召回命中同条去重 |
| 画像 | `src/memory/profile.js` | 群友人物画像 | 以 QQ 号为主键 |
| 存储 | `src/memory/store.js` | 所有 SQLite 读写唯一出口 | 新表走 src/db/migrations/ |
| 迁移 | `src/db/migrate.js` + `migrations/` | 同步迁移框架，schema_version 登记 | 必须同步（getDb 返回时库须就绪）、幂等 |
| 人格 | `src/chat/persona.js` `prompt.md` | 宪法区（稳定特质）；bot_persona 表为正式人格 | 易变内容禁入宪法，走记忆 |
| 拟人化 | `src/persona/*` | 错别字、分段、引用、打字延迟 | 纯函数，可单测 |
| LLM | `src/llm/client.js` | 流式/非流式调用 | 所有调用必须带 label 便于日志 |
| 生图 | `src/chat/image.js` | nai.rinko.ai 被动生图 | 冷却与并发控制在 handler |
| 向量服务 | `vector-service/` | Python + Chroma + jina | 独立进程，HTTP 通信 |
| WebUI | `src/webui/` | 配置面板 | 不碰主链路 |

## 数据流要点

- **入库先于判定**：所有消息（含未触发回复的）都进 raw_messages，维持时间线
- **召回并行**：历史/画像/长期/中期/启发式/联网在 load-context stage 用 Promise.all
- **流式逐句发送**：第一句生成完就发，不等全文；联网请求只重试一次
- **回复后写回**：assistant 消息入库 → 轮次+1 → 达标异步 curate → 顺带衰减
- **会话 ID** 是所有数据的关联键；类型前缀决定群/私聊

## 测试

`npm test`（node --test）。测试用 `BOT_DATA_DIR` 环境变量指到临时目录，
必须在 import 业务模块前设置（config 是模块级求值）。
注意：涉及 app_meta 节流（如记忆衰减）的测试要用独立 conversationId。

## 历史与借鉴来源

- pipeline stage：AstrBot（AGPL，只借鉴思想）
- 交接笔记/心跳/宪法分离：Cortico（AGPL，只借鉴思想）
- 防抖状态机/参与度/沉默提醒/记忆衰减/表达学习/黑话：MaiBot（GPL，只借鉴思想，JS 重写）
- 记忆作用域三件套：KiraraAI（MIT）
- 迁移框架：AstrBot db/migration 思想
- 本文档纪律：LangBot

## Git 提交结构（回滚导航）

- `48fc1b3` 基线：第一批全部改进
- `c574937` 表达习惯与黑话学习
- `33b3882` 全局记忆作用域

单项回滚：`git revert <hash>`；整体回到第二批前：`git reset --hard 48fc1b3`。
