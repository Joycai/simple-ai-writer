# 视频输入按平台判定（能力判定 C4）

> **状态：`fixed`（2026-09-28）。** 样本补齐大半后按「做法」落地（能力判定 C4，[`../api/capability-gating-plan.md`](../api/capability-gating-plan.md) §9）：
> 实测收的平台点名、拒收的写 `false` 格、没测过的不发、中继照发。只剩 OpenAI 官方与火山方舟按量付费没量，见「遗留」。
> 以下「现象」「做法」保留为当时的记录。

## 现象

`videoInput` 在能力表（`src/lib/ai/capabilities.ts`）里是 `native`、族 = ①（Chat Completions），**没有任何平台格**。
于是任何说 ① 族的平台上，看图模型都能声明「视频输入」，对话 `@` 视频照发 `video_url` 片段——
包括从没测过收不收这种片段的 OpenAI 官方、DeepSeek、xAI、火山方舟、OrcaRouter、本地 Ollama。

这与 G12（千问私有的 `vl_high_resolution_images` 漏到智谱）是同一类错：**拿协议族回答了平台的问题**。
`video_url` 不是 Chat Completions 规范里的片段类型，是千问一族兼容端的扩展（landscape.md §7 第六个样本「视觉理解」）。

已实测收它的：百炼（国内，2026-09-14）；智谱收、但忽略 `fps`（第十四个样本）。

## 做法（样本到了之后）

1. `videoInput` 改为按平台点名：百炼 ×2、智谱写 `true` 格；规则改成 `private`、`relay: "unknown"`
   （New API / 自定义背后可能正是百炼）；其余平台在实测前落到 `no / platform-unlisted`。
2. 实测过「不收」的平台写 `false` 格（`no / platform-absent`），与「没测过」分开。
3. 代码几乎不用动：C1 之后 `canReadVideo` / `sentVideoFps` / 抽屉 / 矩阵都直接问表，只改表里的格子。
   `capabilityConsistency.test.ts` 与矩阵文档会把变了的格子逐一显出来。

**这是能力判定里第一次行为变化。** 已声明视频、却落在 `no` 上的旧模型行不受伤：声明留在行上、只是不发，
抽屉显示「已声明，不发送」，可用性矩阵里那一行照样看得见（channel-model-route-plan §7 第 4 条的既有不变量）。

## 需要先跑的样本

各一条 ① 线路的 `video_url` 请求，结果记成 `landscape.md` 的新样本：

- OpenAI 官方（`gpt-5.x` 看图模型）
- DeepSeek
- xAI
- 火山方舟（按量付费与 Coding Plan 各一条，两个平台）
- 可选：OrcaRouter（背后若转发千问，应判 `unknown` 还是按实测写格）

每条要看三件事：HTTP 状态；模型是否真的描述了画面（200 而内容与视频无关 = 静默丢弃，按不收记）；
`usage` 里有无视频 token。

## 实测结果（2026-09-28）

`live.video-input.test.ts`，一段 4 秒红转蓝的片段，走应用自己的 `videoPart` 与 openai 适配器。逐条数据在 landscape.md §7 第十九个样本。

| 平台 | 收不收 `video_url` | `fps` | 按「做法」该写的格 |
| --- | --- | --- | --- |
| 百炼（对照） | 收 | 生效 | `true`（已知） |
| 火山方舟 Coding Plan | **收**，读对了画面 | 两种拼法都不改这段片段的账单 | `videoInput: true`；`videoFps` 不写（未定） |
| DeepSeek | 不收：422 点名 `video_url` 不是可接受的类型 | — | `false` |
| xAI | 不收：400 `Empty content block` | — | `false` |
| OrcaRouter ① | 不收：Gemini **静默丢弃**（200、答错、token 不变），GPT 400 | — | `false` |
| OpenAI 官方 | 未量（本机无 key） | — | 不写，落到「未列出」 |
| 火山方舟按量付费 | 未量（本机只有 Coding Plan 的 key） | — | 不写；与 Coding Plan 同源，大概率同样收，但按规矩要样本 |

- OrcaRouter 那一条最要紧：不报错，作者看不出视频没到。按族放行的今天，它正是「看起来发了、其实没到」。
- 火山方舟收视频，说明「只有千问一族」的说法太窄；「按平台点名」的做法不受影响。

## 落地（2026-09-28）

按「做法」三条做，能力判定只改了表：`videoInput` 规则改为 `private`、`relay: "unknown"`；按上表写格——百炼 ×2、智谱、
火山方舟 Coding Plan `true`，DeepSeek、xAI、OrcaRouter `false`。矩阵文档与一致性测试逐格显出变化，`videoFps` 一格没动。

唯一动到界面的地方是抽屉里的一行提示：此前对任何「不发」都说「这条线路没有这项的拼法」，C4 之后对 DeepSeek（实测不收）
和 OpenAI 官方（没测过）都是错的，改成按裁决的原因码说（方案 §9）。

**待决（方案 §6 待决 3）已定：不需要「未实测」注。** 规则改为 `private` 后，未测平台根本不放行，没有「放行但挂注」的中间态。

## 遗留

- **OpenAI 官方、火山方舟按量付费的样本。** 本机没有这两把 key。补一条 `live.video-input.test.ts` 的目标即可，收就写 `true` 格。
- **火山方舟的 `fps`。** 4 秒片段上两种拼法都不改账单，分不清「无视」与「压在最少帧数上」；要一段 20 秒以上的片段再量。
- **按平台估 token。** `estimateVideoTokens` 按百炼拟合；火山方舟上同一段片段约是它的 2.3 倍，智谱没量。今天只在「视频输入」
  说明里写明估值来自千问。
