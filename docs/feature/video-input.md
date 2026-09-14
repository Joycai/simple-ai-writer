# 视频输入：对话里 `@` 一段视频给能读视频的模型

> **状态：`shipped`**（2026-09-14）。实测只覆盖千问 DashScope 兼容模式 Chat Completions；其他厂商的视频输入**没有**接，也没有测。
> 代码：`src/lib/ai/videoInput.ts`（门、内容块、fps、token 估算）· `src/lib/fs/video.ts`（读文件、MP4/MOV 头解析）· `src/lib/agent/chatRefs.ts`（组装）· `src/lib/agent/imageHistory.ts` + `runtime.ts`（历史里只留最新一段）· 设置在 `ModelDrawer.tsx` 能力 → 输入。

## 1. 作者的两个决定

**(a) 视频只作为对话里的 `@` 附件进入，和图片一样；不加工具（没有 `read_video`）。**
理由：助手常驻工具的 schema 棘轮只剩约 27 token（`agentToolBudget.test.ts`），一个新工具的描述就吃光它；而「看这段视频」本来就是作者的明确指令，和 `@` 一张图同构——作者已经决定模型该看它，做成模型可调可不调的工具反而把指令降成建议（`chatRefs.ts` 开头的论证原样适用）。代价是模型不能自己去找一段视频看，这是有意接受的。

**(b) 附件芯片上显示估算 token 数，模型行上声明抽帧频率（fps）；不弹确认卡。**
理由：视频的代价跨两个数量级（2 秒 480p ≈ 600 token，60 秒 720p ≈ 36k），作者从文件名看不出来，所以芯片上要写出来；但它是作者自己挑的附件、按普通 token 计费，不是 `transcribe_audio` 那种「批准之后才花钱的独立计费步骤」，确认卡只会变成每次都点的橡皮图章。能真正压成本的旋钮是 fps（实测 0.5 比默认便宜 4 倍、快 6 倍），它是模型的属性，放在模型行上一次设好。

## 2. 实测事实（2026-09-14，qwen3-vl-plus 除非另注，data URL）

| 项 | 结果 |
| --- | --- |
| 内容块形状 | `{type:"video_url", video_url:{url:"data:video/mp4;base64,…"}, fps?: number}`——`fps` 是 `video_url` 的**兄弟字段**；文字块在前在后都行 |
| 最短时长 | 1 秒 → 400 `The video file is too short`；2 秒通过 |
| 单个 data URI 上限 | **20,971,520 字节**：17.5MB 的 mp4（base64 约 23MB）→ 400 `Exceeded limit on max bytes per data-uri item : 20971520`；11.3MB（base64 约 15MB）通过。所以原文件 ≤ 约 15MB |
| 容器 | mp4、webm、mov 都读 |
| 编码怪癖 | 早先一段 1.5 秒 + 1.5 秒拼接的 320×240 10fps 片段 → 400 `Invalid video file.`；同尺寸单次编码的 3 秒片段正常。疑为拼接编码问题，未深究 |
| 模型 | qwen3-vl-plus、qwen3-vl-flash、qwen3.8-flash 可读；qwen3.5-omni-flash 读画面**并听音轨**（转写出人声）；qwen3-vl-plus **不听**音轨 |
| 协议 | Responses 面上 qwen3-vl-plus 是 `Unsupported model`，此前一个 `video_url` 块在那里得到**空输出、无报错**。所以**只走 Chat Completions（`openai` 族）** |
| 延迟 | 60 秒 720p：默认 125 秒出结果；fps 0.5 约 20 秒 |

token（`usage.prompt_tokens_details.video_tokens`）：

| 片段 | fps | video_tokens |
| --- | --- | --- |
| 640×480，2 秒 | 默认 | 602 |
| 640×480，3 秒 | 默认 | 902 |
| 320×240，3 秒 | 默认 | 242 |
| 320×240，6 秒（10fps 源） | 默认 | 482 |
| 320×240，6 秒 | 1 | 242 |
| 320×240，6 秒 | 0.5 | 162 |
| 1280×720，60 秒 | 默认 | 35,642 |
| 1280×720，60 秒 | 4 | 71,282 |
| 1280×720，60 秒 | 0.5 | 8,912 |

**估算公式（是估算，界面上一律带 ≈）**：帧数 = round(时长 × fps)，至少 4，向上取偶；每两帧一组，每组 token = min(round(宽/32) × round(高/32), 594)；再加 2。默认 fps 按 2 算。这个规律恰好复现上表每一个点，但它是从九个点反推的，不是厂商文档：594 的封顶只在 16:9 上量过，别的宽高比会有偏差；qwen3-vl-flash / qwen3.8-flash 没量 token。WebM 的时长和尺寸这里不解析，芯片只显示大小、明说估不出。

## 3. 不变量

1. **只有 `openai` 族，只对声明了 `videoInput` 且能看图的模型**（`canReadVideo`）。门在组装处（`agentStore` 的 `allowVideo`、`AgentChat` 的候选与读取），不靠 Responses / Gemini / Anthropic 适配器对未知内容块的具名报错兜底——那个报错还在，是最后一道。
2. **按模型声明，不猜模型名。** 设置里「视频输入」开关只在 Chat Completions + 能看图的模型上出现；换了协议或类型，保存时清掉（fps 随开关一起清）。DashScope 预设给三个实测可读的模型预先打开。
3. **每条消息最多 1 段视频**（`MAX_MESSAGE_VIDEOS`）。一段就可能 20MB 请求体、上万 token；多出来的按路径点名、不发。
4. **请求历史里只留最新 1 段**（`runtime.ts` 的 `MAX_VIDEO_RESULTS`，与图片的 3 张各算各的）。每一轮工具调用都重发整个历史并重新计费，36k token 的视频跑六轮就是六倍。更早的视频块换成一句说明，消息里的文字保留；会话落盘时视频数据全部丢掉（`chatSession.ts`）。
5. **读字节之前先查大小**：`readFileHead(path, 0)` 一次往返拿到真实大小，超过 15MB（`MAX_VIDEO_BYTES`）直接拒，不把文件读进 webview；已知时长短于 2 秒也在挑选时就拒，而不是等请求 400。
6. **估算只是估算**：`estimateVideoTokens` 标 ≈；未知时长返回 null，不编一个数。估值记在 `tokenEstimate` 的 WeakMap 里给上下文预检用，**绝不**写到内容块上——`openai.ts` 原样发送内容块，任何附加字段都会上线。无估值的视频按 `VIDEO_TOKENS_UNKNOWN`（10k）计，而不是按一张图的 800。
7. **工具在场性**：模型读不了视频时，视频退回成「一个录音文件的路径」，走现有的 `mediaRefs` / `mediaRefsNoTool` 文案——只在本次运行真有 `transcribe_audio` 时才点它的名。

## 4. 有意没做

- **没有 `read_video` 工具**——见决定 (a)。
- **角色扮演的输入框不接视频**：它的 `@` 候选本来就不含音视频文件（只有文本和图片），加视频要同时补读取、芯片、历史裁剪三处，而没有人提出这个需求。
- **文件树的「发送到助手」**仍把视频当路径附件（不传 `video` 选项）：那条路不知道当前模型，且与另一条并行的转写改动共用同一段代码。作者在输入框里 `@` 同一个文件就会按视频读。
- **WebM 头解析**（EBML）：解析器只做 MP4/MOV。WebM 照发，时长由端点裁决。
- **URL 形式的视频**（`https://…`）与帧序列形式（`{type:"video", video:[…]}`，实测要求 4–2000 帧）：本项目文件都在本地，只发 data URL。
- **fps 的范围**：设置接受 0.1–10，实测只覆盖 0.5–4。

## 5. 复测

`src/lib/__tests__/live.qianwen.test.ts` 的 `video: qwen3-vl-plus`（需要 `QIANWEN_KEY`）：2 秒片段通过且输入 token 落在估值附近；1 秒片段报 too short；同一段 6 秒片段 `fps: 0.5` 比默认少。三个片段在 `src/lib/__tests__/fixtures/`（ffmpeg 测试图样，共约 54KB）。
