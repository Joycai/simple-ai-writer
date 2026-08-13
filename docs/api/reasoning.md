# 思考模式：强度、思维链、以及回传义务

> 边界见 [`README.md`](README.md)：只写协议事实。族的编号沿用
> [`landscape.md`](landscape.md)：① Chat Completions ② Responses ③ Google GenAI
> ④ Anthropic Messages。

思考模式在协议层是**三件独立的事**，很容易被当成一件：

1. **强度** —— 请求里怎么说"想多久"。
2. **思维链** —— 响应里怎么把想的内容给你（很多端点根本不给）。
3. **回传义务** —— 下一轮要不要把上一轮想的东西还回去。**这一件才是会让请求
   被直接拒绝的那一件**，也是最少被文档放在显眼处的一件。

---

## 1. 强度

| 协议 | 参数位置 | 档位 | 默认 | 关闭 |
| --- | --- | --- | --- | --- |
| **①** | 顶层 `reasoning_effort` | `none/minimal/low/medium/high/xhigh/max`，**每个模型只支持子集** | 模型自定 | `reasoning_effort:"none"` |
| **② Responses** | `reasoning:{effort, summary}` | 同上 | 同上 | 同上 |
| **③ 新代** | `generationConfig.thinkingConfig.thinkingLevel` | `minimal/low/medium/high` | 动态 | 多数模型**不可关** |
| **③ 2.5 代** | `generationConfig.thinkingConfig.thinkingBudget` | `-1` 动态 / `0` 关 / 具体 token 数 | `-1` | `0`，但 2.5 Pro 拒绝 |
| **④ 新代**（4.6+/5） | `output_config:{effort}`，配 `thinking:{type:"adaptive"}` | `low/medium/high/xhigh/max` | `high`（= 不传） | `thinking:{type:"disabled"}` |
| **④ 旧代**（4.5 及更早） | `thinking:{type:"enabled", budget_tokens:N}` | **数值预算**，≥1024 且 < `max_tokens` | 关闭 | 省略该字段 |

### 1.1 档位名相同不等于语义相同

`low/medium/high` 是四族的最大公约数，但：

- **DeepSeek 只有三个真实档位**：`medium`/`xhigh` 被映射成 `high`，只有
  `low`/`high`/`max` 会得到不同的行为。
- **①/② 的 `minimal`、`none` 只有部分模型支持**，④ 的 `xhigh`/`max` 也是。
  "不是每个模型支持每个值"这条规则总是先在边缘档位上应验。
- **④ 的 effort 影响的是整个回复的 token 消耗**（包括工具调用次数与解释文字），
  不只是思考深度。别族的 effort 只管思考。

### 1.2 「关闭」不是通用能力

- Gemini 2.5 Pro 关不掉；新代多数模型最低只能到 `minimal`。
- Claude Opus 5 在 `xhigh`/`max` effort 下收到 `thinking:{type:"disabled"}` 会
  返回 400。
- ④ 的手动 thinking（`type:"enabled"`）与**强制 `tool_choice` 冲突**：需要强制
  单个工具的结构化输出场景，必须显式关掉思考。

### 1.3 ④ 的新旧代互斥，且代次不可从模型名判断

4.7 及以后的模型收到 `thinking:{type:"enabled"}` **直接 400**；4.5 及更早不认
`output_config`。在第三方兼容端点上模型名是自由文本，猜代次不可靠——只能默认
不发，或发了失败再降级。

### 1.4 强度与采样参数互斥

**①：思考模式不支持 `temperature`、`top_p`、`presence_penalty`、
`frequency_penalty`**（DeepSeek 文档明示，OpenAI 推理模型同样不支持
`temperature`）。任何同时提供"温度"与"思考强度"两个设置的界面，都会在推理模型
上让二者互相打架。

---

## 2. 思维链的取回

| 协议 | 流式字段 | 备注 |
| --- | --- | --- |
| **① OpenAI 官方** | **没有内容**，只有 `usage.completion_tokens_details.reasoning_tokens` 计数 | 想看思维链，官方 Chat Completions 这条路是不通的 |
| **① 兼容层扩展** | `delta.reasoning_content`（DeepSeek）/ `delta.reasoning`（OpenRouter 等）/ 部分中继内联 `<think>…</think>` | **字段名没有标准**，见 §2.1 |
| **②** | `reasoning.summary`（需 opt-in `summary: auto/concise/detailed`）+ 无状态时的 `encrypted_content` | 是摘要不是原文 |
| **③** | `part.thought === true` 的文本 part + `thoughtSignature` | 摘要 |
| **④** | `content_block_delta` → `thinking_delta.thinking` + `signature_delta.signature` | 摘要 |

### 2.1 ① 的字段名分歧

同一个协议族里至少三种写法在流通：`reasoning_content`、`reasoning`、以及把
思维链混进正文的 `<think>…</think>`。**没有任何一方是"标准"** —— OpenAI 官方
不返回思维链，所以这里没有可依据的原始定义，各家各自扩展。

实践含义：读取端应当把它当作一张**候选字段名表**去试，而不是认准一个名字；
写回端应当**用收到时的那个名字写回去**（见 §3）。

### 2.2 token 计数

四族都把思考 token 计入**输出**侧，但报的地方不同：

- **①/②**：`completion_tokens` / `output_tokens` 已包含，`*_details.reasoning_tokens`
  是其中的明细。
- **③**：`candidatesTokenCount` **不含**思考，思考在 `thoughtsTokenCount` 里 ——
  只读前者会把一次思考 5k、回答 500 的请求记成 500。
- **④**：`output_tokens` 已包含；`usage.output_tokens_details.thinking_tokens`
  是明细，流式下只在最后的 `message_delta` 出现。

---

## 3. 回传义务（最容易被漏掉的一件）

**规则不是"要不要显示"，而是"下一个请求会不会被拒"。**

| 协议 | 要求 | 违反后果 |
| --- | --- | --- |
| **① 官方** | 无（本来就没有内容） | — |
| **① DeepSeek** | 两个 user 消息之间**如果模型进行了工具调用**，中间 assistant 的 `reasoning_content` 必须参与拼接，且"在后续所有 user 交互轮次中必须回传"；**没有**工具调用时无需回传（传了会被忽略） | 文档原文：**"若您的代码中未正确回传 `reasoning_content`，API 会返回 400 报错"** |
| **②** | 无状态模式（`store:false`）下回传 reasoning item 的 `encrypted_content` | 丢失推理上下文 |
| **③** | `thoughtSignature` 必须原样回传 | 多轮工具调用失效 |
| **④** | 工具轮必须带该轮的 thinking block 及其 `signature`；手动模式下最终 assistant 轮必须以 thinking block 开头 | 请求被拒 |

四条的共同形状：**思考模型把"自己上一轮想了什么"视为这一轮上下文的一部分**，
而这份内容是它自己产出的、带签名或带完整性校验的，所以只能原样奉还，不能重写、
摘要或省略。

### 3.1 DeepSeek 的完整拼接示例

官方示例的做法是把整条响应消息直接 append 回去：

```python
messages.append(response.choices[0].message)   # 含 content / reasoning_content / tool_calls
messages.append({"role": "tool", "tool_call_id": tool.id, "content": "24℃"})
```

即：**assistant 消息上同时带 `tool_calls` 与 `reasoning_content`**，二者一起构成
那一轮。后续每一轮 user 交互都要继续带着它。

### 3.2 一个可移植的实现规则

由于 §2.1 的字段名分歧，"记住是哪个字段名 + 原样写回那个字段名"比"认准
`reasoning_content`"更耐用：**收到什么名字，就用什么名字还回去**。这条规则不需要
知道对面是哪一家，因此也不会因为下一家换了第三个名字而失效。

同理，只在**带工具调用的 assistant 消息**上回传：无工具时那些端点本就忽略它，
回传纯属多付 token。

---

## 4. DeepSeek 文档的两处自相矛盾（截至 2026-08）

记录下来，因为两处都影响实现选择，且只能靠实测定论：

**① `reasoning_effort` 在顶层还是 `thinking` 内部。**
[API 参考](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)的顶层
参数清单里**没有** `reasoning_effort`，它被列为 `thinking:{type, reasoning_effort}`
的子字段，枚举只有 `low`/`high`/`max`。但
[思考模式指南](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)的可运行
示例把 `reasoning_effort="high"` 作为 OpenAI SDK 的具名参数传入——那会序列化到
**顶层**。合理推断是两种都收（顶层为 OpenAI 兼容别名）。

**② `reasoning_content` 的用途。** API 参考称它是"(Beta) 用于思考模式下在对话
前缀续写功能下，作为最后一条 assistant 思维链内容的输入"；思考模式指南则要求
工具调用轮必须回传否则 400。两处描述的场景不同，后者更贴近工具调用场景。

**连带的缺口**：`thinking.reasoning_effort` 的枚举里没有 `none`，而 DeepSeek 的
关闭开关是 `thinking:{type:"disabled"}` —— 一个 OpenAI 官方端点会拒绝的字段。
所以"用一个字段同时表达四族的关闭"在 ① 这一族内部就做不到。

---

## 5. 一句话小结

- 想控制**强度**：四族都有，档位名像但语义不像，且"关闭"不保证可用。
- 想拿到**思维链**：OpenAI 官方拿不到；其余三族给的是摘要；① 的兼容层字段名
  没有标准。
- **必须处理回传**：这是唯一会让请求直接失败的一件，且在工具调用场景下才触发
  —— 只读"工具调用"那一页文档的人不会看到它。
