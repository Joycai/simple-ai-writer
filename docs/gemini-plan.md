# Gemini 族接入方案（现状盘点）

> **状态：盘点完成，未调研官方文档，一行代码未动。** 本文是动手前的**代码侧**
> 现状，用来定位缺口；协议事实要在动手前补一轮官方文档核对。
>
> 前两轮的同类文档：[`reasoning-plan.md`](reasoning-plan.md)（① 族，已实现）、
> [`anthropic-plan.md`](anthropic-plan.md)（④ 族，已实现）。本轮把同样的三件事
> ——强度 / 思维链 / 回传——做到 ③ 族。

## 1. 一句话结论

**三件事里最难的那件（回传）已经做完了，且做得比另外两族都早。**

`gemini.ts` 从一开始就把整个 `parts` 数组原样累积并在后续回合回传
（`_geminiModelParts`），注释写明理由是"thinking 模型需要 `thoughtSignature`"。
所以 ③ 族没有前两轮那种"静默降级"或"必然 400"的问题。

缺的是：**强度控制**（没有）、**思维链展示**（解析到了但丢弃）、**方言**
（新代 `thinkingLevel` vs 2.5 代 `thinkingBudget` 未区分）。

## 2. 现状盘点（代码侧）

| 项 | 状态 | 位置 |
| --- | --- | --- |
| 回传 `thoughtSignature` | ✅ **已合规** | `geminiAllModelParts` → `StreamChunk._geminiModelParts` → `StreamMessage._geminiModelParts` |
| 思考 token 计入输出 | ✅ **已对齐** | `outputTokens = candidatesTokenCount + thoughtsTokenCount` |
| 识别思考 part | ✅ 已识别 | `part.thought === true` |
| 思考文本展示 | ❌ **识别了就丢** | `if (part.text && !part.thought)` —— 非思考才 emit |
| 强度控制 | ❌ **完全没有** | `reasoningBody` 对 gemini 返回 undefined |
| 方言区分 | ❌ 没有 | `defaultDialect` 对非 anthropic 一律 `none` |
| 面板拨盘 | ❌ 不渲染 | `supportsThinkingLevel` 不含 gemini |

### 2.1 唯一一行就能拿到的收益

`gemini.ts` 的 part 循环里，`part.thought === true` 的文本**已经被识别出来了，
只是没有 emit**。接上 `{reasoning}` chunk 是一行的事，而 PR #128 的展示界面
早就在等它。这是三族里成本最低的一次接入。

### 2.2 已经正确、不要动的

- **`_geminiModelParts` 原样回传。** 这是 ③ 族回传合规的全部。任何"把 part
  归一化成自己的结构"的重构都会打破它——`thoughtSignature` 必须逐字送回。
- **`thoughtsTokenCount` 手动折进 output。** ③ 是四族里唯一一个
  `candidatesTokenCount` **不含**思考的，见 [`api/usage.md`](api/usage.md) §2.2。

## 3. 待办与顺序

沿用前两轮的切片法，按"打坏东西的风险"排序：

1. ⬜ **emit 思考文本**（§2.1）。一行，纯加法，#128 的界面立刻有内容。
2. ⬜ **官方文档核对**。本文只盘了代码，协议事实需要一轮
   `ai.google.dev` 的核对，重点是：`thinkingLevel` 的取值与各模型默认值、
   `thinkingBudget` 的 `-1`/`0` 语义、`includeThoughts` 是否仍需显式开启
   （对应 ④ 族的 `display` 陷阱）、以及哪些模型**不能关闭**思考。
3. ⬜ **方言 + 强度映射**。`thinkingDialect` 已经为此预留了 `extended` 值 ——
   ③ 的 2.5 代正是"数值预算"语义，与 Anthropic 旧代同构，这是当初选这个字段
   形状的主要理由（[`anthropic-plan.md`](anthropic-plan.md) §3.3）。
4. ⬜ **面板拨盘解禁**（`supportsThinkingLevel` 加 gemini）。

## 4. 已知的协议事实（来自前两轮的旁证，需核实）

这些是写 [`api/`](api/README.md) 时顺带记下的，**没有针对 ③ 族专门核对过**：

- **新代**：`generationConfig.thinkingConfig.thinkingLevel`，取值
  `minimal/low/medium/high`。
- **2.5 代**：`generationConfig.thinkingConfig.thinkingBudget`，
  `-1` 动态 / `0` 关 / 具体 token 数；**2.5 Pro 拒绝 `0`**（关不掉）。
- **`part.thought` + `thoughtSignature`**：思考 part 的标记与签名，签名必须
  原样回传。
- **安全过滤是请求级可配的**（`safetySettings`），且**默认会拦** —— 这是 ③ 族
  独有的一维，与思考正交但同样影响"为什么没有输出"。

## 5. 与前两轮的差异预判

- **不会有"静默降级"**（④ 族那种）：回传已经合规。
- **不会有"必然 400"**（① 族那种）：现在什么都不发，不发不会错。
- **最可能的坑是 `includeThoughts` 这类"默认不给你看"的开关** ——
  ④ 族的 `display: "omitted"` 就是这个形状，且照全额计费。核对时优先确认。
