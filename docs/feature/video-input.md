# 视频输入：对话里 `@` 一段视频给能读视频的模型

> **状态：`shipped`**（2026-09-14）。token、`fps` 与片段限制只在千问 DashScope 兼容模式 Chat Completions 上量过。收不收 `video_url` 按平台测：智谱收（landscape §7 第十四个样本，2026-09-19）；火山方舟 Coding Plan 收，DeepSeek、xAI、OrcaRouter 不收（第十九个样本，2026-09-28）。门按平台判定（不变量 1）。
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

1. **只有 `openai` 族上实测收它的平台，只对声明了 `videoInput` 且能看图的模型**（`canReadVideo` 问能力表的 `videoInput`）。`video_url` 是厂商扩展：百炼、智谱、火山方舟 Coding Plan 收；DeepSeek、xAI、OrcaRouter 不收（OrcaRouter 上 Gemini 回 200 却把视频静默丢掉，GPT 直接报错）；没测过的平台不发，中继照发（capability-gating-plan §9，2026-09-28）。门在组装处（`agentStore` 的 `allowVideo`、`AgentChat` 的候选与读取）；已经在历史里的视频每一轮由请求计划再问一次（§4）。Responses / Gemini / Anthropic / 原生适配器对拼不出的内容块的具名报错（`unsendablePart`）还在，只是后备。
2. **按模型声明，不猜模型名。** 设置里「视频输入」开关只在收它的线路、能看图的模型上出现；已声明而当前线路不发的，开关照旧显示、可关，下面一行写明不发的原因（抽屉的 `declNotes`）。换了类型（不再看图），保存时清掉（fps 随开关一起清）；换线路不清，声明是模型的。DashScope 预设给三个实测可读的模型预先打开。
3. **每条消息最多 1 段视频**（`MAX_MESSAGE_VIDEOS`）。一段就可能 20MB 请求体、上万 token；多出来的按路径点名、不发。
4. **请求历史里只留最新 1 段**（`runtime.ts` 的 `MAX_VIDEO_RESULTS`，与图片的 3 张各算各的）。每一轮工具调用都重发整个历史并重新计费，36k token 的视频跑六轮就是六倍。更早的视频块换成一句说明，消息里的文字保留；会话落盘时视频数据全部丢掉（`chatSession.ts`）。
5. **读字节之前先查大小**：`readFileHead(path, 0)` 一次往返拿到真实大小，超过 15MB（`MAX_VIDEO_BYTES`）直接拒，不把文件读进 webview；已知时长短于 2 秒也在挑选时就拒，而不是等请求 400。
6. **估算只是估算**：`estimateVideoTokens` 标 ≈；未知时长返回 null，不编一个数。估值记在 `tokenEstimate` 的 WeakMap 里给上下文预检用，**绝不**写到内容块上——`openai.ts` 原样发送内容块，任何附加字段都会上线。记的是**代价随 fps 的函数**（`noteVideoCost`），不是算好的数：估算按手上那个 part 的 `fps` 算，投影出的副本带着它（`carryVideoCost`，见 §4「片段的 fps 也按请求决定」）。无估值的视频按 `VIDEO_TOKENS_UNKNOWN`（10k）计，而不是按一张图的 800。
7. **工具在场性**：模型读不了视频时，视频退回成「一个录音文件的路径」，走现有的 `mediaRefs` / `mediaRefsNoTool` 文案——只在本次运行真有 `transcribe_audio` 时才点它的名。

## 4. 历史里的媒体按请求放行（2026-09-28）

**问题。** 对话历史跨模型切换复用（`chats[key].history`，模型是全局的 `activeModelId`），而视频、图片、PDF 只在**附加那一刻**过门。
一段视频留在历史里（§3 第 4 条保留最新一段），作者把模型切到原生 / Gemini / Anthropic / Responses 线路，之后每一轮都在适配器里以名字报错；
切到不看图的模型，历史里的图照样打到 ① 上，由上游 400。「历史里的 part 每一轮都会重发」这件事没有拥有者。

**决定：媒体放行归请求计划，发送时投影，历史不改。**

1. **一个答案。** `capability/media.ts` 的 `admittedMedia(wire, model, 声明)` 是「这条线路 × 这个模型收哪几类媒体」的唯一答案：
   三层：协议那一层是适配器有没有拼法（`spelledMedia`：图片五族都有，视频只有 ①，PDF 除原生外都有），总是生效；模型那一层是声明
   （类型看不看图、`videoInput`、`pdfInput`）；平台那一层是能力格（`videoInput` / `pdfInput`，按 id 与中转上游），只对声明发问。
   `ConnOptions` 带上三项声明，`planRequest` 产出 `RequestPlan.media`；决定建不建 part 的门——输入框的视频门 `canReadVideo`、PDF 子代理的资格 `readsPdf`——经 `conn.ts` 的
   `admittedMediaOf` 读同一个组合，「将发送」的 fps 行读 `plan.media.video`。三处不再各问一遍能力表，`mediaAdmission.test.ts`
   随机走全部平台 × 线路 × 声明 × 中转上游，钉住它们逐格相等。
2. **投影，不改写。** `streamCompletion` 在一切读 `messages` 的环节（token 估算、图片载荷门、API 日志、适配器）之前调
   `admitMedia(messages, plan.media)`：不放行的 part 换成一句给模型读的英文说明（`[video clip not sent: …]`），文字保留
   （`withoutParts`，与裁剪、落盘同一条规则）。返回新数组，历史本身一个字节不动——切回收得下的模型，视频原样再发。
3. **适配器只剩后备。** 四个适配器对拼不出的 part 统一抛 `unsendablePart`；正常路径到不了，`mediaHistory.test.ts` 走真实的
   `streamCompletion` 证明这一点（随机 平台 × 线路 × 声明 × 历史，外加「切原生再切回」「不看图的模型 + 历史图片」两个场景）。

**为什么不是别的做法。**
- **适配器里丢弃**（把四个默认分支改成说明句）：判定仍散在五处；适配器不知道模型声明，不看图的模型带图走 ① 的那种情形覆盖不到；
  token 估算和 API 日志看到的是丢弃前的请求；以后第六种 part 要改五处。
- **切模型时改写历史**：切回去视频就没了；模型是全局的，一次切换改写所有对话；运行中切换有竞态。

**已知取舍。**
- **运行时按投影估算**（片段 fps 那一节的 review 之后，2026-09-28）。`trimHistory`、每轮开头的 token 估值与思考守卫、检查点提示，
  都按 `plan.ts` 的 `mediaProjection(opts)` 投影后的历史估——与 `streamCompletion` 同一个 `admitMedia` 组合，运行的模型固定，投影也固定。
  此前它们按未投影的历史估，本节的多算只会往保守那边偏（提早裁剪、思考预算被砍，例如历史里一段 ≈36k 的视频、切到 64k 窗口的原生线路
  思考模型，思考预算按 ≈13.5k 而不是 ≈31.5k 给）；片段 fps 改为按请求决定之后，同一处会**少算**（见下一节「已知取舍」的 review 记录），
  于是按当时写下的做法改成读同一个计划，而不是另写一份判定。
- 裁剪仍会改写历史：窗口装不下这一轮**实际发出**的请求时（例如一段 60 秒 720p 的片段在 20k 窗口下切到按缺省帧率计费的智谱），
  这段视频和更早的工具结果会被真正删掉——此后切回去，那段视频不在了。「切回去还在」只在窗口装得下这一轮投影后的请求时成立。
- **压缩与上下文条仍按未投影的历史估**：`compact.ts` 的折叠规划、`compactRun` / `skillStateRun` 的前后对比、`contextBreakdown.ts`
  的上下文条。换过模型之后，这里的数可能与实际发出的不同，两个方向都有（收不下的媒体多算；附加时 0.5、现在按缺省发的片段少算）。
  它们不决定请求发不发——超窗由上面的运行时裁剪兜住——所以不在本次一并改；要改也是读同一个 `mediaProjection`。
- **手拼的请求（探针、live 测试）不带声明，发协议拼得出的一切**，不看平台格。平台格是量出来的，而 `live.video-input.test.ts`
  这类探针正是去量它的：若它也受格约束，一个没测过的平台收到的永远是说明句，探针量到的是表而不是平台（片 3 review F1）。
  协议那一层照样生效，适配器的后备报错到不了。
- 片段的 `fps` 原先在附加时写死、不随换模型重算（整体 review 第 2 轮 N1）——已按本节同一个形状改掉，见下面「片段的 fps 也按请求决定」。
- **没有给 Gemini / Anthropic / 原生线路加视频拼法。** Gemini 有 inline 视频、原生有 `{video}`，都没实测过；那是「开能力」，要样本，另开任务。
- 界面上不标「这段视频本轮没发」。说明句是写给模型的，模型会告诉作者；要做界面提示先走 Claude Design。

### 片段的 fps 也按请求决定（2026-09-28）

**问题。** `fps` 在附加时由 `sentVideoFps` 算好写进片段，之后没人再问。历史跨模型复用：智谱上附的片段不带 `fps`，
切到声明 `videoFps: 0.5` 的百炼模型后照样不带——按缺省约 2 帧 / 秒计费，约 4 倍 token——而「将发送」列着 `fps 0.5`；
反向则把百炼私有的 `fps` 发给不理它的平台。「这条线路读不读 fps」另在将发送里问一遍，两处都不带模型类型与中转上游。

**决定：与媒体放行同一个形状——计划决定，投影写入，历史不改。**

1. **一个答案。** `capability/media.ts` 的 `clipFps` 给出 `RequestPlan.clipFps`：放行了片段、行上声明了 `videoFps`、
   且这条线路对这个模型（类型 + 中转上游）有 `videoFps` 格，就是那个值；否则 `"none"`；请求不带声明（手拼的探针）则 `"as-built"`。
   声明经 `mediaDeclarationOf` 进 `ConnOptions.videoFps`，与另三项同一个映射。附加时的 `sentVideoFps`（经 `conn.ts` 的 `clipFpsOf`）、
   芯片估算、「将发送」的 `video_url.fps` 行都读它；`mediaAdmission.test.ts` 随机走平台 × 线路 × 声明 × 中转上游钉住逐格相等，
   `capabilityConsistency.test.ts` 的 `request` 提问者经真实 `streamCompletion` 对照能力表。
2. **投影写入。** `admitMedia` 给每个放行的片段的**副本**设上 `plan.clipFps` 或删掉 `fps`；已经相同的不复制，历史一个字节不动。
   `clipFps.test.ts` 走真实的 `buildChatMessage`（附加时照 `agentStore` 调）→ `streamCompletion`，随机在两个模型下附、第三个状态下发：
   线上每个片段的 `fps` 等于芯片的答案；把投影写 fps 那段还原，测试失败。
3. **估算跟着实际发出的 fps。** WeakMap 里记代价函数而不是数（§3 第 6 条），副本带着它；发送前的上下文闸和首块期限按投影后的
   `fps` 算。还原「副本带估值」，副本退回 10k 的未知值，测试失败。

**为什么这样。**
- **手拼的请求原样发**，理由同本节「探针发协议拼得出的一切」：`live.qianwen.test.ts`、`live.video-input.test.ts` 正是去量
  「这个平台理不理 fps」的，受格约束就只能量到表。它们用 `videoPart(url, fps)` 自己拼，计划不碰。
- **不在适配器里写 fps**（只有 ① 拼 `video_url`，看似一处就够）：API 日志和 token 估算读的是投影后的 messages，在适配器里改，
  它们看到的就不是发出去的——与「适配器里丢弃」被拒是同一个理由。
- **估算提示记函数，不记时长与尺寸**：`tokenEstimate` 是界面到处引用的叶子模块，记函数它就不必 import `videoInput.ts`
  （后者经 `conn` 连到整个能力层），公式也只留一处。
- **计划不 clamp**：`plan.ts` import `videoInput.ts` 会成环；`videoFps` 在每个入口（数据库读取、配置导入、抽屉保存）都已 clamp 过。

**已知取舍。**
- **历史里的片段仍写附加时的 `fps`**（作者 2026-09-28 选定）。线上只认投影；这个值只剩给仍按未投影历史估算的读者
  （压缩规划、上下文条，见上一节）用，不换模型时它就是计划的答案。另一种做法是附加时不写、投影成为唯一写入方——更干净，
  但当时运行时还按未投影历史估算，那会让它的估算全部落到缺省 2 帧 / 秒：百炼 0.5 的常规路径上一段 60 秒 720p 的片段从 ≈8.9k 变成
  ≈35.6k，思考预算被砍、小窗口提早裁剪（裁剪会真的删历史）。
- **review 记录：附加时的 fps 让运行时少算**（片 2 review，已修）。附在百炼 0.5、切到智谱：运行时按历史里的 0.5 估 ≈8.9k，
  请求自己的预检按实际发出的缺省帧率估 ≈35.6k；作者窗口落在两者之间时，运行时不裁、预检每一轮都拒，这次运行必然失败。
  此前运行时与预检读同一个 `fps`，只在媒体放行上有「多算」这一种分歧。修法是让运行时读同一个计划（上一节第一条），
  `runtimeClipFps.test.ts` 走真实的 `runAgent` 钉住两个方向；把运行时改回按原始历史估算，两条都失败。
- 查看完整提示（`PromptViewer`）显示的是运行里的 messages，即投影前的；与说明句一样，那里看到的 `fps` 是附加时的。

## 5. 有意没做

- **没有 `read_video` 工具**——见决定 (a)。
- **角色扮演的输入框不接视频**：它的 `@` 候选本来就不含音视频文件（只有文本和图片），加视频要同时补读取、芯片、历史裁剪三处，而没有人提出这个需求。
- **文件树的「发送到助手」**仍把视频当路径附件（不传 `video` 选项）：那条路不知道当前模型，且与另一条并行的转写改动共用同一段代码。作者在输入框里 `@` 同一个文件就会按视频读。
- **WebM 头解析**（EBML）：解析器只做 MP4/MOV。WebM 照发，时长由端点裁决。
- **URL 形式的视频**（`https://…`）与帧序列形式（`{type:"video", video:[…]}`，实测要求 4–2000 帧）：本项目文件都在本地，只发 data URL。
- **fps 的范围**：设置接受 0.1–10，实测只覆盖 0.5–4。

## 6. 复测

`src/lib/ai/__tests__/live.qianwen.test.ts` 的 `video: qwen3-vl-plus`（需要 `QIANWEN_KEY`）：2 秒片段通过且输入 token 落在估值附近；1 秒片段报 too short；同一段 6 秒片段 `fps: 0.5` 比默认少。三个片段在 `src/lib/fs/__tests__/fixtures/`（ffmpeg 测试图样，共约 54KB）。
