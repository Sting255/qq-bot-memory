# 吸纳改进实施计划（五项目调研成果落地）

> 依据：docs/research-five-projects.md 的候选清单。
> 许可纪律：MaiBot（GPL-3.0）只借鉴算法思想，JS 逐行重写；KiraraAI（MIT）可参考实现。
> 原则：每项独立可回滚、默认参数保守、不动 pipeline 主链路、每项带单测。

## 总览（8 项，按价值×成本排序分两批）

### 第一批（本次实施）
1. 防抖状态机（MaiBot debounce 思想）——半天
2. 记忆衰减（A-Memorix maintain 思想）——2 小时
3. 参与度门控特征（MaiBot heartflow 思想）——2 小时
4. 连续沉默提醒（MaiBot mode_policy 思想）——1 小时
5. ARCHITECTURE.md 文档（LangBot 纪律）——2 小时

### 第二批（暂缓，先观察第一批效果）
6. 表达习惯学习（1-2 天，涉及 LLM 挖掘管线，单独规划）
7. 全局记忆作用域（需 schema 变更，等有跨群需求再做）
8. 黑话挖掘（与 6 合并做）

## 一、防抖状态机（重写 trigger/debounce.js）

### 设计
替换现有固定 `debounceSec` 的 DebounceBuffer（在 handler.js 内），
独立成 `src/trigger/debounce.js`，规则照 MaiBot 思想用 JS 重写：

```
开批等待：群安静 quiet_sec / 群活跃 active_sec（默认 2s/5s）
续发等待：同人 same_author_sec / 换人 different_author_sec（默认 2s/0.5s）
@ 机器人：mention_limit_sec 压缩截止（默认 1s）
整批上限：batch_limit_sec（默认 8s）
裸图（消息只有图片段）：至少等 bare_image_sec（默认 4s）
纯表情：只提前截止，不延长
批次到期后：新消息不延长，进下一批
```

「活跃」定义：上一条消息到达距今 ≤ quiet_threshold_sec（30s）视为群活跃。

### 兼容
- config.trigger 增 `debounce:` 子段，保留旧 `debounce_sec` 作为未配置时的
  开批等待回退值
- handler.js 的 DebounceBuffer 类移出为独立模块并替换实现，
  对外接口 push/clear 不变
- 单测覆盖：同人/换人/限时/上限/到期不延长/纯表情提前

## 二、记忆衰减（memory/curate.js 扩展）

### 设计
curateMemories 完成后追加一步 `decayMemories(conversationId)`：
- 召回 `memory_fragments` 中 status='active' 且 last_recalled_at 距今
  超过 decay_after_days（默认 90 天）的条目
- importance -1；降到 0 以下标记 status='decayed'
- 每次最多处理 200 条，避免锁库
- 节流：同一会话 24h 只跑一次（记在 conversation_state 或 app_meta）

### schema 变更
`memory_fragments` 需要 `last_recalled_at` 列（若没有）→ 走新迁移 002。
召回路径（recall.js）命中时顺手 UPDATE 该列。

## 三、参与度门控特征（trigger/ 扩展）

### 设计
scheduler.evaluate 的上下文已有 recentSelfCount/recentTotalCount。
增加「话题参与度」：最近 N 条（默认 30）里 bot 发言中连续话题段的计数，
简化为：最近 30 条里 bot 发言条数 botRecent30。
- 门控公式：已插话越多 → 触发概率乘以衰减因子
  `p *= max(0.2, 1 - botRecent30 / 30)`
- 数据来源：selectRecentMessages 已返回历史，无需新查询
- 保守：只降不升，@/提及路径不受影响

## 四、连续沉默提醒（persona/ 或 trigger/）

### 设计
scheduler 连续 K 次（默认 3）判定「不触发」且群内持续有消息时，
在下一批 buildMessages 注入一条 system 提醒：'你已经很久没说话了，
如果接下来的话题你有想说的可以自然接上，没有就继续保持沉默。'
——不强制开口，只给感知。计数在批处理结束时更新，bot 发言即清零。

## 五、ARCHITECTURE.md

按 LangBot 纪律写：模块地图 + 每模块 Owner 文件 + 数据流图 +
「改 X 先读 Y」导航。内容以现有代码为准，不改代码。

## 验收

- 每项独立提交，`npm test` 全绿（预计新增约 25 个单测）
- 防抖：测试群里观察开批节奏日志
- 衰减/参与度：纯后端逻辑，单测覆盖即可
- 全部完成后更新 README 与 ARCHITECTURE.md
