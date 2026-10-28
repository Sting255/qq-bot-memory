# 交接文档：qq-bot-memory

> 写给下一个接手这个项目的 AI / 开发者。读这一份就够上手。
> 最后更新：2026-10-24 23:00

## 一、项目是什么

一个独立运行的 QQ 群/私聊「拟人化记忆机器人」，人设与账号在 `config.yaml` 与面板中配置。

不依赖 MaiBot / AstrBot / snowluma，全部自行实现。技术栈 Node.js 22 + SQLite + 本地向量服务（Python）。

```
NapCat (OneBot 11 WS, 端口 3001)
  → Node 主服务 (src/main.js)
      ├── 向量服务 (Python, 端口 8765, 自动拉起)
      ├── WebUI (端口 3099)
      └── LLM 上游 (127.0.0.1:7866, deepseek-v4.1-flash)
```

## 二、当前状态

- **运行**：`npm start`（详见第八节），日志写入 `data/bot-run.log`
- **测试**：`npm test`，224 个单测
- **数据库**：`data/bot.db`（不入库），迁移版本 4

## 三、代码地图（改代码前必读）

| 你要改什么 | 读哪个文件 |
|---|---|
| 消息怎么进来、怎么归一化 | `src/adapters/normalize.js` |
| 要不要回复、什么时机回 | `src/trigger/scheduler.js`、`src/trigger/debounce.js` |
| 回复内容怎么生成 | `src/pipeline/stages.js`（load-context → build-prompt → llm → send） |
| 人格/说话风格 | `src/chat/persona.js`、`src/chat/prompt.md`、数据库 `bot_persona` 表 |
| 拟人化加工（错别字/分段/延迟） | `src/persona/index.js` 及各子模块 |
| 记忆怎么存/取/整理 | `src/memory/store.js`、`recall.js`、`curate.js`、`mid-term.js` |
| 表达习惯/黑话 | `src/memory/expression.js` |
| 生图/语音 | `src/chat/image.js`、`src/chat/tts.js`，检测在 `src/pipeline/tools.js` |
| LLM 调用与超时 | `src/llm/client.js` |
| 数据库表结构变更 | `src/db/migrations/`（加新文件，id 递增） |

详细模块职责见 **`ARCHITECTURE.md`**。

## 四、这一天发现的问题与修复（2026-10-24）

### 已修复

1. **`styleBlock is not defined`**（严重）：load-context stage 的 Promise.all 加了第 5 项但解构漏了变量，导致每次回复都失败。已修。

2. **首字熔断形同虚设**（严重）：给流式加了 15s 首字超时，但①abort 抛的错误名是 `This operation was aborted` 而非 `AbortError`，识别不到；②流式读取在重试循环之外，即使识别到也不会重试。结果：日志 0 次熔断触发，但实测仍有 52s/44s/43s 的回复。已重构 `chatStream`，把整个流式读取放进重试循环。

3. **后台任务抢 LLM 上游**（严重）：记忆整理/中期摘要/表达挖掘与聊天回复同时打同一个上游，上游排队导致聊天首字从 1s 涨到 40s+。已加并发闸门（`acquireSlot`）：聊天永不排队，后台任务最多同时 1 个。

4. **打字延迟从未生效**：`buildOutgoingMessages` 返回的 `delayMs` 发送时没被消费，多段消息瞬间连发。已接通，并尊重 `config.persona.typing.enabled` 开关。

5. **无时间感知**：模型不知道现在几点，会深夜说早上好。已在 system prompt 注入 `现在是 2026-10-24 星期五 03:39（深夜）` 及时段语义。

6. **防抖日志缺失**：SmartDebouncer 内部无日志，无法观察节奏。已补 debug 日志。

### 已知但未修（下一个接手的人优先看）

1. **`中期记忆生成失败: LLM 调用超时（60000ms）` 31 次/天**
   后台摘要任务超时。加了并发闸门后应显著缓解，但没验证。若仍频繁：
   - 考虑把 `mid-term.js` 的 maxTokens 从 4000 降到 2000（摘要不需要那么多）
   - 或把超时从 60s 提到 90s
   - 或干脆让摘要失败就跳过，不重试（它不阻塞回复）

2. **`记忆整理失败: LLM 调用超时` 7 次/天**，同上。

3. **`LLM empty: 返回空内容（finish_reason=length）` 6 次**
   deepseek-v4.1-flash 是 reasoning 模型，会先消耗大量 reasoning token 再出正文，maxTokens 给小了正文就被截空。curate 已给 5000，mid-term 给 4000。若仍出现，继续加大。

4. **表达挖掘零产出**（`expression_habits` 表 0 条）
   节流时间戳写了但没数据，说明挖掘 LLM 调用失败（超时/空响应）。已提高 maxTokens 到 3000 + 超时 90s，需观察。**这是新功能，从没成功跑通过一次。**

5. **分段几乎不发生**（113 次回复里 107 次只有 1 条）
   `config.persona.splitter.max_length` 是 200，而模型回复通常 30 字内，所以永远不分段。若想更像真人连续发几条短消息，把这个值降到 30~50。**这是产品决策，没擅自改。**

6. **心跳主动性从未运行**：`config.trigger.heartbeat.enabled` 默认 false。要开需手动改配置。

7. **衰减从未实际降权**：`last_recalled_at` 有 242 条非空，但所有记忆 `status` 全是 `active`。因为衰减要求「90 天未召回」，而数据最老才 1 天。这是正常的，不是 bug。

## 五、性能基线（113 次回复实测）

| 指标 | 数值 |
|---|---|
| 平均召回 | 55ms |
| 平均首字 | 7110ms |
| 平均总耗时 | 7634ms |
| 首字 > 10s | 36 次（32%） |
| 最慢 | 52361ms |

**瓶颈是 LLM 上游**，不是代码。召回稳定在 55ms（pipeline 并行召回工作良好）。
若上游持续慢，考虑换模型或加本地推理。

## 六、关键配置（`config.yaml`）

```yaml
llm:
  base_url: "http://127.0.0.1:7866/v1"
  model: "deepseek-v4.1-flash"
  max_tokens: 250        # 聊天回复上限，很小，为了短回复
  timeout_ms: 60000

trigger:
  frequency: 0.15        # 回复概率
  reply_on_at: true
  reply_on_mention: true
  nicknames: ["昔涟"]

persona:
  typo.enabled: false    # 错别字关着
  splitter.max_length: 200   # 太高，见问题 5
  typing.enabled: false      # 打字延迟关着
```

## 七、Git 回滚导航

```
22c1236 拟人修复三件（首字熔断/打字延迟/时间感知）
5385fa3 fix: styleBlock 未定义
59032e6 docs: 回滚导航
33b3882 全局记忆作用域
c574937 表达习惯与黑话学习
48fc1b3 基线：第一批全部改进（202 tests）
```

- 单项回滚：`git revert <hash>`
- 回到某个状态：`git reset --hard <hash>`
- 全部改动都在 `src/` 和 `test/`，`.gitignore` 已排除 data/、node_modules/、Python 运行时

## 八、怎么跑

```bash
npm start          # 自动拉起向量服务 + NapCat + 主服务
npm test           # 224 个单测
```

启动后自动打开：
- WebUI 管理面板 http://127.0.0.1:3099
- NapCat 控制台 http://127.0.0.1:6099/webui

**注意**：改代码后必须重启进程才生效（没有热重载）。

## 九、设计原则（改代码时请遵守）

1. **规则越少越好**：实测 45 字的极简 prompt 比 1233 字的详细规则生成更自然。不要往 prompt 里堆规则。
2. **不引入 planner 多轮工具循环**：那是「麦麦变重」的根源。单轮调用。
3. **重的活放离线**：LLM 挖掘（记忆整理、表达挖掘、中期摘要）都在回复路径之外异步跑，在线只做本地查询。
4. **人格宪法稳定，经历走记忆**：`prompt.md` 只放稳定特质，易变内容（近况、临时设定）禁止写入，走记忆系统。
5. **借鉴思想不搬代码**：参考过的项目 AstrBot/Cortico/MaiBot 都是 AGPL/GPL，只借鉴设计，代码全部 JS 重写。

## 十、参考过的项目

| 项目 | 借鉴了什么 | 许可证 |
|---|---|---|
| AstrBot | pipeline stage 架构 | AGPL-3.0（只借鉴思想） |
| Cortico | 交接笔记、心跳退避、宪法分离 | AGPL-3.0（只借鉴思想） |
| MaiBot | 防抖状态机、参与度门控、沉默提醒、记忆衰减、表达学习 | GPL-3.0（只借鉴思想） |
| KiraraAI | 记忆作用域三件套 | MIT |
| LangBot | ARCHITECTURE.md 文档纪律 | — |

调研记录在 `docs/research-five-projects.md`。

## 十二、识图（2026-10-28 新增）

### 架构：两段式，图片不直接进主模型

```
QQ 图片 URL
  → Qwen3-VL-235B（视觉模型）生成一句文字描述
  → <image_context>当前消息附带图片，内容是：……</image_context>
  → deepseek-v4.1-flash 读文字照常回复
```

实现在 `src/chat/vision.js`，接在 `pipeline/stages.js` 的 load-context 并行块里，
不额外增加延迟。描述按 URL 缓存 6 小时（同图反复转发只识别一次）。

### ⚠️ 绝对不要把图片发给主聊天模型

`deepseek-v4.1-flash` 在上游**不是多模态**。带 `image_url` 的请求会被拒：

```
InferHub.001001020.406 The request model is not multimodal
```

后果不只是这次请求失败——**会触发账号 10 分钟冷却**，期间所有模型全部不可用，
机器人整体掉线。dev 过程中踩过这个坑。

### 网关补丁（如果你用自建 OpenAI 兼容网关）

不少轻量网关会把 `message.content` 拍平成纯文本，`image_url` 直接丢弃，
图片到不了任何模型。判断方法：请求带图后模型回答「我看不到图片」。

这种网关需要在网关侧放行图片分片；本项目侧不用改。

### 已验证

```
绿色图 → "绿色"       红色图 → "红"
文字图 → "HELLO BOT"  （连图内文字都能读）
```


1. **先看日志再改代码**。这一天的所有问题都是日志里读出来的，不是猜的。
2. **改完先跑 `npm test`**，207 个测试覆盖了主要路径。
3. **优先修第四节「已知但未修」的第 1、2 条**（后台任务超时），这是当前最大的稳定性问题。
4. **第 5 条（分段阈值）是产品决策**，改之前先问用户想要什么样的聊天节奏。
5. 表达挖掘（第四节第 4 条）是从没跑通的新功能，需要重点验证。

## 十三、记忆门控（2026-10-28 新增）

借鉴 MemTensor MemT-1.0 的写入门 / 遗忘门思想（自行实现），实现在 `src/memory/gate.js`。

### 写入门 estimateWriteValue()

记忆入库时按内容特征给 1~5 分初始重要度，替代之前**一律 1 分**的做法：

- 含具体事实（数字 / 偏好 / 习惯 / 身份信息）+1
- 判断句够长（≥20 字 / ≥45 字）各 +1，太短通常是废话
- 情绪类、技能类记忆 +1（对拟人陪伴最有价值）

不用 LLM——入库是高频路径，多一次调用就多延迟。

### 遗忘门 memoryRetention()

```
retention = importance × 0.5^(年龄/半衰期) × (1 + 0.15×召回次数)
半衰期   = 30天 × (0.5 + importance/3) × (1 + log2(1+召回次数))
```

- **重要度延长半衰期**：核心记忆不会因为没人提就消失
- **召回延长半衰期**：常被想起的记忆更牢
- 降权用相对阈值（跌破重要度的一半），退役用绝对阈值 0.35
  —— 否则 1 分记忆几天就被砍

对比旧实现（90 天硬阈值、所有记忆同等待遇、从未召回的 NULL 永不衰减），
新实现是连续打分，重要和琐碎分道扬镳。

### 实测

现有 4321 条活跃记忆全部在 30 天内，遗忘门本轮不介入（设计如此，
30 天内的记忆不参与）。门控会在数据积累后自然生效。
