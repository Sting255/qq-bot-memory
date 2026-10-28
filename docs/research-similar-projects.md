# 同类开源项目调研汇总（2026-10-24）

> 调研范围：AstrBot（已深读）、Cortico（已深读）、MaiBot/MaiSaka（文档+第三方源码解读）、
> LangBot/MMBot（搜索了解）。目的：找可吸纳的设计，不迁代码。

## 总览

| 项目 | 定位 | 与你的关系 | 深度 |
|---|---|---|---|
| AstrBot | 通用 IM Agent 框架 | pipeline stage 思想来源（已落地） | 源码深读 |
| Cortico | 事件流 Agent Harness（人格 Bot） | 同类，思想最相近（已落地 3 件） | 源码深读 |
| MaiBot/MaiSaka | "想当群友"的陪伴 Agent | 你的记忆/画像思路部分源自它的 v1.3.14 | 文档+解读 |
| LangBot/MMBot | 通用框架 / 群聊特化 | 参考价值低 | 搜索 |

## MaiBot（Mai-with-u/MaiBot，6.4k stars，GPL-3.0）可借鉴点

### 1. 心流（heartflow）：发言时机作为一等公民 ✦ 最值得
它把「现在该不该开口」做成了独立的会话层（heartflow_manager），
Planner 决定行动前先过心流的时机/频率判定。你的 trigger/scheduler 是它的简化版，
但差一块：**你的概率门控只看自己说话占比和群活跃度，不看"话题参与度"**——
正在聊的话题如果你已经插过两句话，热度应该更高。MaiBot 的启示：把
「我最近的参与度」作为门控特征之一（数据你都有，conversation_state 里加个计数即可）。

### 2. A-Memorix 的四层分离 ✦ 你已对齐
聊天流（短期）/窗口摘要（中期）/人物事实画像/回答前检索注入——
你的 store + mid-term + person_profile + recall 完全同构，无需改动。
它的 `maintain_memory` 工具（记忆演化：合并、衰减、纠错）你没有——
你的 curateMemories 只增不减。**可借鉴：给记忆整理加"衰减"步骤**，
长期不被召回的记忆降低 importance，避免画像和召回被陈年条目污染。

### 3. 表达选择器：说什么 vs 怎么说分离
它有独立的表达向量索引+选择器。你的 persona/（typo/splitter/typo）已经是
"怎么说"层，这个对齐了，不用动。

### 4. 自动写回闭环 ✦ 你已对齐
回复后摘要+人物事实写回——你的 curateMemories + profile 就是这个。MaiBot
源码解读里特别强调"少了写回，越来越懂你只是越来越长的聊天记录"，你已闭环。

## LangBot / MM-Bot
通用框架路线（MaiBot 式但更工程化），对你无增量；MMBot 的群聊特化功能（日程等）
与拟人化主线无关。跳过。

## 结论：后续候选清单（按价值排序）

1. **记忆衰减**（MaiBot maintain_memory 思想）：curateMemories 增加衰减步骤，
   90 天未召回的记忆 importance -1，低于阈值的标记 inactive。工作量小时级。
2. **参与度门控特征**（MaiBot heartflow 思想）：scheduler.evaluate 增加
   「话题内我已发言次数」特征，插话越多概率越低。工作量小时级。
3. **纠错记忆**（A-Memorix 记忆演化）：召回的记忆与新对话矛盾时让 curate
   识别并改写。这个复杂，放长期。

前两项可以做，第三项先记着。
