# 五项目源码调研：优势收集（2026-10-24）

> 全部拉源码深读：/tmp/{astrbot, cortico, maibot, langbot, kirara}
> 结论按「对本项目的增量价值」排序。已落地的（pipeline、三件套）不重复列。

## 1. MaiBot（Mai-with-u/MaiBot，6.4k★，GPL-3.0）—— 增量最多

### ✦✦ 消息防抖的状态机（chat/debounce/controller.py）—— 最值得抄
你的 DebounceBuffer 是固定 `debounceSec` 一刀切。MaiBot 的防抖是一台精密状态机：
- **三档模式** fast/natural/steady（群安静开批 2s / 活跃 5s；同人续发 2s / 换人 0.5s）
- **同人续发等更久、换人抢话等更短**——真人就是这样的节奏
- **@ 机器人 1 秒上限**：被点名时压缩等待，不让人干等
- **整批 8 秒硬上限**：无论怎么续都不能无限拖
- **纯表情包只提前不推迟**；裸图至少等 4 秒（等人配文字）
- **批次到期后新消息不再延长**：到期就消费，迟到者进下一批

→ 建议：重写你的 DebounceBuffer 为这套状态机。工作量半天，拟人度收益直接。

### ✦✦ 表达习惯学习（learners/expression_learner.py + replyer/表达选择器）
从群聊中挖掘"这个群怎么说 goodbye/打招呼/玩梗"，存成表达库（DB+向量索引），
回复时按相似度选 3-5 条注入 prompt 作为风格示例。LLM 挖掘 → 审核 → 加权采样。
→ 你的 persona/typo.js 是"机械拟人"，这个是"学习式拟人"：bot 会说这个群的方言。
简化版：memory/curate 时顺带抽取"群友常用表达"存表，buildMessages 注入 3 条示例。

### ✦ 黑话学习（learners/jargon_learner.py + jargon_miner.py）
挖群黑话/新词 → jargon_context_matcher 在上下文里标注含义。
→ 与表达学习同源，可合并做。

### ✦ 连续等待提醒（maisaka/mode_policy.py）
Planner 连续 3 轮选择"等待"后，往上下文注入一条提醒，防止无限观望。
→ 你的心跳/门控没有类似机制，低优先级但很巧。

### ✦ 心流会话 LRU（heartflow_manager.py）
每会话一个常驻实例，24h 不活跃淘汰，上限 100 个，创建加锁防并发。
→ 你的 ConversationQueue 不会膨胀（处理完即删），无此需求，跳过。

## 2. KiraraAI（lss233/kirara-ai，约 14k★，MIT!）—— 许可最友好

### ✦✦ 记忆作用域三件套（memory/scopes/）
GlobalScope / GroupScope / MemberScope：同一条记忆可以按「全局 / 群 / 群内某人」
三个粒度存取。你目前记忆全部按 conversationId 隔离——**跨群的共同经验存不了**
（比如某群友的两个群都认识 bot）。→ person_profile 其实就是你的 MemberScope，
缺的是 GlobalScope（bot 自己的阅历）。低优先级。

### ✦ 记忆组合器/解组合器（memory/composes/）
消息入库时把媒体/工具调用与文本组合（compose），读取时解包（decompose），
媒体走 MediaReference 引用不落记忆正文。你目前纯文本。→ 有多模态需求时再看。

### ✦ 工作流 + YAML 分发规则（data/dispatch_rules/rules.yaml）
消息 → workflow 的路由用声明式 YAML（前缀/@/聊天类型 + 优先级）。
你的触发是代码。→ 单一场景不需要，跳过。

## 3. LangBot（RockChinQ/LangBot，20k+★）—— 工程标杆但同类功能少

### ✦ ARCHITECTURE.md 文档纪律
"改行为先读这张图，再顺着文件引用进代码"——文档比功能文档稳定、比 README 具体，
每个模块标注 Owner 文件。→ 值得学：给本项目写一份（小时级，长期收益大）。

### ✦ 查询池容量控制（pipeline/pool.py）
QueryPoolCapacityError：排队满了优先丢弃可丢弃的，而不是拒绝新工作。
→ 你的 ConversationQueue maxPending=2 直接丢新批，MaiBot 防抖的「到期不延长」
其实更好，两者结合。

### 其余（workspace 执行上下文、多运行时桥接、MCP server）是平台化复杂度，跳过。

## 4. AstrBot / Cortico —— 已消化（pipeline stage / 三件套），增量见前两份报告。
AstrBot 补一个之前没提的：`waking_check` 与 `whitelist_check` 作为可配置 stage 的
粒度划分（"是否唤醒"和"是否允许"分开），对应你的 trigger 和未来的群白名单。

## 汇总：候选改进清单（全项目合并去重，按价值排序）

| # | 改进 | 来源 | 工作量 | 价值 |
|---|---|---|---|---|
| 1 | 防抖状态机（同人/换人/三档/8s上限/@提速） | MaiBot | 半天 | ★★★★★ |
| 2 | 表达习惯学习（群风格示例注入） | MaiBot | 1-2天 | ★★★★☆ |
| 3 | 记忆衰减 | MaiBot/A-Memorix | 2小时 | ★★★★☆ |
| 4 | 参与度门控特征 | MaiBot heartflow | 2小时 | ★★★☆☆ |
| 5 | ARCHITECTURE.md 文档 | LangBot | 2小时 | ★★★☆☆ |
| 6 | 全局记忆作用域（bot 阅历） | KiraraAI | 半天 | ★★☆☆☆ |
| 7 | 黑话挖掘 | MaiBot | 1天 | ★★☆☆☆ |
| 8 | 连续等待提醒 | MaiBot mode_policy | 1小时 | ★★☆☆☆ |

许可注意：MaiBot 是 GPL-3.0、A-Memorix 有独立条款，**只借鉴算法思想，逐行重写**；
KiraraAI 是 MIT，是最安全的参考对象。
