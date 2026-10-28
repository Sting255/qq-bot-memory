# 用本地 ComfyUI 生图

本项目支持两种生图后端，在 `config.yaml` 里切换：

| provider | 说明 |
|---|---|
| `openai` | 云端 OpenAI 兼容接口（如 nai.rinko.ai），一次请求直接返图 |
| `comfyui` | 本地 ComfyUI，提交工作流 → 轮询 → 下载图片 |

本地出图不花钱、不限量、图不进第三方服务器，代价是要自己跑 ComfyUI。

## 配置

```yaml
image:
  enabled: true
  provider: "comfyui"
  comfyui:
    base_url: "http://127.0.0.1:8188"
    # API 格式工作流，放这里或任意路径
    workflow: "resources/comfyui/my-workflow.api.json"
    negative_prompt: "lowres, bad anatomy, watermark, text"
    size: "832x1216"
    steps: 28
    scale: 5
    seed: -1              # -1 = 每次随机
    timeout_ms: 180000
    # 参数写进哪个节点的哪个字段（节点 id 见下面说明）
    bindings:
      positive: { node: "4", input: "text" }
      negative: { node: "5", input: "text" }
      width:    { node: "7", input: "width" }
      height:   { node: "7", input: "height" }
      steps:    { node: "8", input: "steps" }
      cfg:      { node: "8", input: "cfg" }
      seed:     { node: "8", input: "seed" }
```

## 准备 API 格式工作流

1. 在 ComfyUI 里搭好一条能出图的文生图流程，确认点「Queue Prompt」能出图
2. 打开 **设置 → 开发者选项 → 启用 Dev mode**
3. 点 **Save (API Format)**（普通 Save 导出的是 UI 格式，本项目不认）
4. 把生成的 JSON 放到 `resources/comfyui/` 下

## 怎么知道 bindings 该填什么

打开你导出的 JSON，节点是「id 为键」的对象：

```json
{
  "4": { "class_type": "CLIPTextEncode", "inputs": { "text": "a cat" } },
  "7": { "class_type": "EmptySD3LatentImage", "inputs": { "width": 1024, "height": 1024 } },
  "8": { "class_type": "KSampler", "inputs": { "seed": 42, "steps": 20, "cfg": 5 } }
}
```

- 正向提示词节点通常是 **`CLIPTextEncode`** 里接 KSampler `positive` 的那个
- 负向提示词节点是接 `negative` 的那个
- 宽高在 **`EmptyLatentImage` / `EmptySD3LatentImage`** 节点
- 步数、cfg、seed 在 **`KSampler`** 节点

把这些 id 和字段名填进 `bindings` 即可。**节点 id 每个工作流都不一样**，所以必须自己对照着填。

## 常见问题

| 现象 | 原因 |
|---|---|
| `找不到 ComfyUI 工作流` | 路径不对，或文件没放进去 |
| `工作流必须是 API 格式` | 导出时点成了 Save 而不是 Save (API Format) |
| `ComfyUI 连接失败` | ComfyUI 没启动，或 `base_url` 端口不对（默认 8188） |
| `ComfyUI 提交失败 400` | 工作流里的模型文件本机没有，按报错提示装对应模型 |
| `ComfyUI 出图超时` | 首次加载模型很慢，把 `timeout_ms` 调到 300000 |
| 出的图跟提示词没关系 | `bindings.positive` 指错了节点，或指向了没接进采样器的文本节点 |

## 和云端后端的差别

- 本地：无需密钥，但要在自己的机器上常开 ComfyUI，出图速度取决于显卡
- 云端：开箱即用，按张计费（或用免费额度）
- 两个后端共用同一套「识别要图 → 生成提示词 → 出图 → 异步补发」的流程，只是最后一步不同
