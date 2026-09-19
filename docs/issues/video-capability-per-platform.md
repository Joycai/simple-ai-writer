# 视频输入按平台判定（能力判定 C4）

> **状态：open。** 作者 2026-09-19 定为搁置、记入待办。行为今天没有错到出事的程度，但判据放错了层；
> 动手的前提是几条实测样本，不是代码。设计与上下文见 [`../api/capability-gating-plan.md`](../api/capability-gating-plan.md) §4 C4、§7 第 2 条。

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

## 待决

- 实测前，未测平台上是否先给「视频输入」挂「未实测」注（方案 §6 待决 3）。倾向于随 C4 一起定，不单独改。
