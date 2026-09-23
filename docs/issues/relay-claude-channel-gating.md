# 中转站上 Claude 的能力裁决：渠道部分已解决，转换层部分未决

> **状态：`open`**（2026-09-23）。事实已实测并记在 [`api/landscape.md`](../api/landscape.md) §7 第十五、十六个样本。
> **渠道（上游）部分已解决**：改成作者声明的上游 + 内置画像，见 [`api/capability-gating-plan.md`](../api/capability-gating-plan.md) §8.11
> （`KIRO_CLAUDE` 已迁成按 id 推断出的 Kiro 上游）。**仍未决的是下面第 1 条的 New API 转换层**。

## 是什么

能力表（`src/lib/ai/capabilities.ts`）在中转站平台 `newapi` / `custom` 上用一个**只点名**的模型格
`KIRO_CLAUDE`（id 同时含 `kiro` 与 `claude`）关掉了 Kiro 渠道 Claude 实测不生效的五格
（[`api/capability-gating-plan.md`](../api/capability-gating-plan.md) §8.10）。第十六个样本在同一台中转站上又测了
CC、anti、AWSb 三个渠道，结果有两类没有进表：

1. **不是渠道的事，是这台 New API 的 ①→④ 转换**：① 面的 `response_format`（`json_object` 与 strict `json_schema`）四个渠道全被丢；
   `reasoning_effort: "max"` / `"none"` 四个渠道全等于不想。表里只对 Kiro 判了 ① 面 `structuredOutput` 不发，
   其余渠道的 Claude 仍会发一个必被丢掉的 `response_format`。
2. **别的渠道各有要点名的格子**：

   | 渠道（id 前缀） | 该判「不发」的 | 依据 |
   | --- | --- | --- |
   | `[anti…]` | ①④ `forcedToolChoice`、① `pdfInput`、④ `web_search`（被丢、模型凭记忆答） | 强制工具 0/16；PDF 与文本文档都被丢 |
   | `[正向AWSb…]` | ④ `web_search`（400，Bedrock 没有服务端工具） | 四种服务端工具全 400 |
   | `[CC…]` | 强制工具带思考时时好时坏（3/8、4/8）——**不宜判「不发」**，关了反而丢掉不带思考时 100% 的那部分 | 见第十六个样本 |

   另有两条不是能力格能表达的：anti 的 Claude **根本不会思考**（思考参数、`-thinking` 变体都无效）；CC 的 opus-5 思考文本恒为空。
   它们属于思考类目 / 模型行，不属于能力表。

## 为什么还没改（2026-09-23 写下时）

- **名单按渠道前缀写，前缀是这一台中转站自定的**（`[CC量]`、`[anti量]`、`[正向AWSb量1]`……）。Kiro 的名字来自上游产品，
  换一台中转站大概率还叫 kiro；`CC` / `anti` / `AWSb` 是站主起的缩写，写进正则就是在为一台中转站硬编码。
- **转换层那两条（① 面 JSON 模式、`max`）按「这台 New API 的所有 Claude」点名更准**，但目前只有一台 New API 的样本。
  如果是 New API 通用行为，应该落成 `newapi` 平台 ① 面、按 `claude` 点名；如果只是这台的版本问题，就会误伤别的 New API。
- `[官key量]` 这一档当天整体 502，没测到正向官 key 的对照组。

## 做的时候

> 第 2 条已按另一种方式做完：站主缩写不进代码，改成渠道上的「前缀 → 上游」表由作者填（§8.11）。第 1、3 条仍待做。

1. 先补一个样本：另一台 New API（或同一台升级后）的 Claude 走 ① 面，看 `response_format` 与 `reasoning_effort: "max"` 是否同样被丢。
   同样被丢 → 在 `newapi`（不含 `custom`）的 ① 面给 `structuredOutput` 加 `{ refuses: [/claude/] }`，并考虑让 `openai-generic`
   在这类 id 上把 `max` 夹到 `high`（第十五个样本的建议，未实现）。
2. 渠道名单只收**上游产品名**能认出的（kiro、bedrock 类）；站主自定的缩写不进代码，改在作者说明里提示「按渠道实测」。
3. `[官key量]` 恢复后补测，作为正向官方的对照组。
