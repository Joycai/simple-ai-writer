# Gemini 族接入方案（现状盘点）

> **状态：四刀全部实现。** 目标 **Gemini 3+**。剩下的是 §5 那几条只能靠真实请求定论的验证。
>
> 核对分两轮，第二轮（API 参考的 markdown 原文）纠正了第一轮的两个判断 ——
> 指南页只讲 Interactions，但**参考页把经典 surface 的字段定义得很完整**。
> 教训记在 §7。
>
> 前两轮的同类文档：[`reasoning-plan.md`](reasoning-plan.md)（① 族，已实现）、
> [`anthropic-plan.md`](anthropic-plan.md)（④ 族，已实现）。本轮把同样的三件事
> ——强度 / 思维链 / 回传——做到 ③ 族。

## 1. 一句话结论

**最难的那件（回传）本来就对；但有一个我们不认识的失败形态。**

`gemini.ts` 从一开始就把整个 `parts` 数组原样累积并回传（`_geminiModelParts`），
与官方对无状态模式的要求一致，**不需要改**。

但 `finishReason` 枚举里有 **`MISSING_THOUGHT_SIGNATURE`**，而
`GEMINI_BLOCKED_FINISH_REASONS` 不含它 —— 签名缺失时请求会**成功返回**、以这个
原因终止，被我们当成一次正常的短回复。这是 ③ 族的第三种失败形态（见 §4）。

缺的是：**强度控制**（完全没有）、**思维链展示**（识别了就丢）、
**`includeThoughts` 未开**（不开就没有思考内容可展示）。

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

### 2.1 `part.thought` 仍然是对的，但缺一个开关

`gemini.ts` 里 `part.thought === true` 的文本被识别后丢弃。第一轮核对时我以为
这个标记在 Gemini 3 上可能不存在（指南页说 `generateContent` 里
*"there are no dedicated thought blocks"*），**API 参考推翻了这个担心** ——
`thinkingConfig.includeThoughts` 的说明是 *"Indicates whether to include
thoughts in the response"*，也就是说思考仍然随响应回来，只是**默认不返回**。

所以 emit 那行仍然成立，但**必须同时发 `includeThoughts: true`**，否则永远没有
内容可 emit。这与 ④ 族 `display: "omitted"` 是同一类陷阱：不显式开就拿不到，
而 token 照计。

### 2.2 已经正确、不要动的

- **`_geminiModelParts` 原样回传。** 与官方对无状态模式的要求一致：
  *"You MUST always resend all `thought` blocks exactly as they were received
  from the model."* 任何"把 part 归一化成自己的结构"的重构都会打破它。
- **`thoughtsTokenCount` 手动折进 output。** ③ 是四族里唯一一个
  `candidatesTokenCount` **不含**思考的，见 [`api/usage.md`](api/usage.md) §2.2。
  （Interactions 那边字段名换成了 `total_thought_tokens`。）
- **`safetySettings` 请求级配置**。③ 族独有，与思考正交。

### 2.3 采样参数：③ 族没有 ④ 族那条禁令

`generationConfig` 的 `temperature` / `topP` / `topK` 在 ③ 族**始终可用**，
不因思考而禁用。这与 ①④ 相反（见 [`api/reasoning.md`](api/reasoning.md) §1.8）。
本 app 从不发送这些，所以只是记录，不影响实现。

### 2.4 目标范围：Gemini 3+（作者决定）

与 ④ 族收窄到 4.6+ 同理。范围内的事实：

- **档位 `minimal/low/medium/high`**，但 **3.1 Pro 没有 `minimal`**。
- **默认值分三种**：`high`（3.1 Pro、3 Flash）/ `medium`（3.6 Flash）/
  `minimal`（3.1 Flash-Lite）。
- **思考不可关闭**，`minimal` 也只是「最少」而非关闭。

对 UI 的直接后果：**③ 族的「关闭」档只能映射到 `minimal`**，与 ④ 族「关闭
映射到最低 effort」的处理完全同构 —— `ANTHROPIC_EFFORT` 那套注释可以照搬。

### 2.5 ③ 族有两套 surface —— 本轮只做经典那套

协议事实见 [`api/landscape.md`](api/landscape.md) §4.1。要点：

- Interactions API（`POST /v1beta/interactions`，`input` + `steps`）是官方
  推荐给新开发的 surface，**结构与经典 `generateContent` 不兼容**。
- **经典 surface 不弃用**：*"While `generateContent` remains fully supported,
  we recommend the Interactions API for all new development."*

**本轮只做经典那套。** 理由：接 Interactions 等于加第五个协议族（新 adapter、
新消息形状、新的 `ApiStandard` 值），而它带来的两大好处对本 app 都不适用 ——
服务端会话状态与我们自己的历史/压缩机制冲突，后台长任务不是写作软件的场景。
留待将来单独评估，记在 §6。

## 3. 待办与顺序

按"打坏东西的风险"排序。**与前两轮不同：不需要先实测** —— API 参考把字段定义
得很完整（§2 各节）。

1. ✅ **认识 `MISSING_THOUGHT_SIGNATURE`**（§1）。把它加进
   `GEMINI_BLOCKED_FINISH_REASONS`，或更准确地单独报错——它不是安全拦截，
   措辞该说清是签名缺失。独立、小、且修的是一个当前会被误读成"正常短回复"的
   失败。
2. ✅ **发 `thinkingConfig`**：`thinkingLevel`（六档映射）+
   `includeThoughts: true`。两件同刀 —— 只发档位不开 includeThoughts，等于
   花钱思考却看不到；只开 includeThoughts 不发档位，则用模型自己的默认。
3. ✅ **emit `part.thought` 的文本** → `{reasoning}` chunk。#128 的展示界面
   在等它，前提是第 2 刀开了 `includeThoughts`。
4. ✅ **面板拨盘解禁**（`supportsThinkingLevel` 加 gemini）。

### 3.1 六档怎么映射

`ThinkingLevel` 枚举是 `MINIMAL` / `LOW` / `MEDIUM` / `HIGH`（**全大写**），
没有 `MAX`。所以：

| 本项目档位 | Gemini |
| --- | --- |
| 跟随默认 | 不发 `thinkingLevel` |
| 关闭 | `MINIMAL`（③ 族关不掉，`minimal` 也只是「最少」） |
| 低 / 中 / 高 | `LOW` / `MEDIUM` / `HIGH` |
| 最高 | `HIGH`（没有更高的） |

「关闭 → 最低档」与 ④ 族的处理完全同构，`ANTHROPIC_EFFORT` 那段注释的理由可
照搬。**3.1 Pro 没有 `MINIMAL`** —— 若实测发现它拒绝，这正是 `thinkingDialect`
或探测该管的事。

### 3.2 `thinkingBudget` 不实现

它与 `thinkingLevel` 并存于同一个 `thinkingConfig` 对象，靠"用错模型会报错"
区分，而不是靠对象形状。而我们只支持 Gemini 3+，参考页原文：`thinkingLevel`
*"Recommended for Gemini 3 or later models. Use with earlier models results in
an error."* —— 反过来说，3+ 上发 `thinkingLevel` 就够了。

这也意味着 **③ 族用不上 `thinkingDialect`**：范围内只有一种形状。那个字段仍然
只服务 ④ 族。

## 4. 与前两轮的差异

| | ① DeepSeek 系 | ④ Anthropic | ③ Gemini |
| --- | --- | --- | --- |
| 回传做错了 | **400** | **静默关掉思考** | **`finishReason` 报 `MISSING_THOUGHT_SIGNATURE`** |
| 回传现状 | 已修 | 已修 | **本来就对** |
| 能否关闭思考 | 可以（`none`） | 部分模型可以 | **不能** |
| 采样参数与思考冲突 | 是 | 是 | **否** |
| 拿到思考文本要 | 什么都不用做 | 发 `display:"summarized"` | 发 `includeThoughts:true` |

**三族各有一种失败形态**，且三种互不相同：响亮的 400、完全静默、以及"成功返回
但 finishReason 告诉你出事了"。第三种最容易被当成正常结果。

## 5. 需要实测才能定论的

汇总在 [`thinking-verification.md`](thinking-verification.md) §1.2 与 §3。
**最要紧的一条**是 §1.2：`includeThoughts` 打开之后 `part.thought` 的实际形态
—— 参考页没定义它，而第 3 刀的写法建立在对它的假设上。

## 6. 未决：要不要接 Interactions API

不是本轮的事，但记下判断依据，免得下次从头想：

**接的理由**：官方推荐给新开发；服务端管理 thought 与签名，回传义务整个消失；
类型化的 `steps` 比 `parts` 更好调试。

**不接的理由**（目前占优）：
- 它是**第五个协议族**，要新 adapter、新消息形状、新 `ApiStandard` 值。
- 服务端会话状态（`previousInteractionId`）与本 app 自己的历史管理、压缩
  （`compactChatHistory`）、裁剪（`trimHistory`）**直接冲突** —— 我们要控制
  上下文里有什么，那正是它替我们代劳的部分。
- 经典 surface 明确不弃用。

**触发重新评估的条件**：官方宣布 `generateContent` 弃用；或某个我们需要的能力
只在 Interactions 上有。

## 7. 一个方法教训：指南页与参考页要分开读

第一轮我只读了 `gemini-api/docs/*` 的指南页，得出两个错误判断：「Gemini 3 的
思考配置在经典 surface 上文档已不给」「emit 思考文本的前提待实测」。

**参考页 `ai.google.dev/api/generate-content` 把 `ThinkingConfig` 定义得完整
无缺** —— 只是它 295KB，网页摘要工具扫不到，`curl` 下来自己 grep 才看见。

沉淀成两条：

- **指南页反映"官方希望你怎么用"，参考页反映"接口实际接受什么"。** 前者会为了
  推新 surface 而不提旧的，后者不会。**判断能力边界要看后者。**
- **大文档要抓原文自己搜。** 摘要工具在 300KB 量级会漏掉整节，而漏掉的恰好
  可能是唯一的权威定义。

## 8. 落地记录

- **`MISSING_THOUGHT_SIGNATURE` 单独成一类，不并入安全拦截集合。** 它报的是
  请求有问题，不是内容被拒；混进 `GEMINI_BLOCKED_FINISH_REASONS` 会让作者
  去检查自己的稿子里有什么敏感内容——而问题在我们这边。同组还收了
  `UNEXPECTED_TOOL_CALL` / `TOO_MANY_TOOL_CALLS` / `MALFORMED_RESPONSE`，
  各带一句说明实际出了什么事。
- **`generationConfig` 必须深合并一层。** JSON 模式经由 `extraBody` 往那里放
  `responseMimeType`，任一方向的直接赋值都会吃掉对方的字段。有测试盯着。
- **思考 part 仍然先进 `geminiAllModelParts` 再分支。** 原代码就是这个顺序，
  改动只是在分支里多认一种 part——签名因此不受影响。
- **UI 文案补了一句**：Gemini 关不掉思考，「关闭」等于最低档。此前只有 ④ 族的
  文案说了这件事，而 ③ 族走的是另一条 hint。
