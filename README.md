# qq-bot-memory

[![test](https://github.com/Sting255/qq-bot-memory/actions/workflows/test.yml/badge.svg)](https://github.com/Sting255/qq-bot-memory/actions/workflows/test.yml)

一个**群聊和私聊都能用**的 QQ 机器人：记得住人、会画图、能看图、说话像人、不刷屏。

Node.js 22 + OneBot 11（NapCat）+ 本地向量记忆，不依赖任何其他 bot 框架。

## 功能

### 能做的事

| 功能 | 说明 |
|---|---|
| **生图** | 用户要图时出图，异步补发——文字先回、图后到，顺序更像真人。云端接口或**本地 ComfyUI** 二选一 |
| **看图** | 群友发图 / 引用图片让它看，图片先由视觉模型转成描述，再据此回答 |
| **换装** | 角色按场景和时段自动选穿搭（早上居家、深夜睡衣、出门约会各有套装），生图时带上 |
| **语音** | 把回复合成语音发出来，支持音色克隆（自带参考音频） |
| **联网** | 问到天气、时效性内容时自己触发搜索，搜完再回答 |
| **角色资料** | 提到不认识的动漫角色会去查 wiki，避免胡编 |

### 记得住

- **三层记忆**：长期向量记忆 / 中期摘要+召回线索 / 最近对话交接笔记，互相补位
- **会遗忘**：按「价值 × 时间半衰 × 召回次数」打分，琐碎的自然退场，重要的留得住
- **人物画像**：按 QQ 号积累对每个人的认知，改名也认得出
- **表达学习**：从群里挖口头禅和黑话，说话带这个群的味儿

### 像人

- **知道什么时候闭嘴**：按群活跃度、自己说过多少话决定要不要插嘴，有每小时额度
- **打字节奏**：多段回复之间按字数模拟打字延迟，不是一口气全甩出来
- **会打错字**：偶发错别字，有时还补一条纠正
- **偶尔引用**：指着某句话回，不是每次都引用
- **知道现在几点**：深夜会困，饭点会饿，不会在错误的时段说错话

### 通用

- 群聊、私聊都支持；群聊按概率插话，@ 和提及必回
- 管理面板：http://127.0.0.1:3099（人格、记忆、配置可视化）
- 224 个单元测试，GitHub Actions 每次提交自动跑

## 快速开始

```bash
git clone https://github.com/Sting255/qq-bot-memory.git
cd qq-bot-memory
npm install
npm start
```

首次启动会自动生成 `config.yaml`，填三项就能跑：

```yaml
llm:
  base_url: "http://你的LLM地址/v1"   # OpenAI 兼容
  api_key: "sk-xxx"
  model: "你的模型名"
```

然后装 [NapCat](https://napcat.napneko.icu/)，新建 **WebSocket 客户端**（不是服务端，不是 HTTP），
URL 填 `ws://127.0.0.1:3001`，消息格式选 **Array**，扫码登录。

生图、看图、语音、联网这些是可选功能，用到再在 `config.yaml` 里填对应的服务地址与密钥。

**Windows 后台常驻**：双击 `start-silent.vbs`，无控制台窗口启动，进程退出后 10 秒自动重启。
日志写在 `data/bot-run.log`，管理面板固定在 `http://127.0.0.1:3099`（把 `webui.auto_open`
设为 `true` 可以让它在启动时自动弹出）。

## 不会部署？让 AI 帮你

把下面这段直接丢给你的 AI 助手（Claude Code / Cursor / ChatGPT 都行）：

```
帮我部署这个项目：https://github.com/Sting255/qq-bot-memory

我的环境：<Windows 11 / macOS / Linux>
我的 LLM：<OpenAI 兼容的地址、模型名和 key>

请：
1. 克隆仓库、装依赖、跑通 npm test
2. 按我的 LLM 信息写好 config.yaml
3. 安装并配置 NapCat（OneBot 11 WebSocket 客户端，指向 ws://127.0.0.1:3001，消息格式 Array）
4. 启动服务，确认日志出现「已连接账号」
5. 遇到报错就查 AGENTS.md 的「已知坑」那一节
```

有 AI 全程带你，不用懂 Node.js 也不用懂向量数据库。

## 需要自备

| 内容 | 必填 | 说明 |
|---|---|---|
| `config.yaml` | 是 | 首次启动自动生成，填 LLM 地址与密钥 |
| LLM | 是 | 任意 OpenAI 兼容接口 |
| NapCat | 是 | QQ 协议端，自行安装配置 |
| 视觉模型 | 看图才要 | `llm.vision` 段，必须是支持图片的模型 |
| 生图服务 | 生图才要 | `image` 段：云端 OpenAI 兼容接口，或本地 ComfyUI（见 `resources/comfyui/README.md`） |
| TTS 服务 | 语音才要 | `tts` 段 + 一段 20 秒以内的参考音频（放 `resources/voice/`） |

## 遇到问题

- 先看 [AGENTS.md](AGENTS.md) 末尾的「已知坑」——大部分常见报错都在那里
- 还解决不了就 [提 Issue](https://github.com/Sting255/qq-bot-memory/issues)，附上日志里的报错行和环境信息

## 文档

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 开发约定、硬性约束、数据来源、记忆迁移方法 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 模块地图与数据流 |
| [docs/design.md](docs/design.md) | 设计细节：触发判定、记忆分层、注入防护、性能实测 |
| [HANDOVER.md](HANDOVER.md) | 踩过的坑与运维要点 |

## 授权

[MIT](LICENSE)。部分设计借鉴了 AstrBot、Cortico、MaiBot、KiraraAI、MemT-1.0 等开源项目的**思路**，
代码全部独立实现；`resources/clothing-library.json` 来自 [邻舍.EXE](https://github.com/icecranberry/galgame-with-comfyUI)（MIT）。
详见 [AGENTS.md](AGENTS.md) 的「数据来源与授权」。

本项目仅供学习与个人使用，请遵守所在平台的服务条款。
