# 思考功能的验证清单

> **状态：全部未验证。** 三族的思考支持（强度 / 思维链 / 回传）都已实现并通过
> 单元测试，但**没有一条对着真实端点跑过** —— 单元测试验的是"我们发出了什么"，
> 这份清单验的是"对面怎么理解"。
>
> 分散在 [`reasoning-plan.md`](reasoning-plan.md)、[`anthropic-plan.md`](anthropic-plan.md)、
> [`gemini-plan.md`](gemini-plan.md) 三份文档里的实测项汇总在此，因为它们只在
> 同一次动手时才会被真正执行。**验完请回原文档更新对应结论**，本文只是索引。

## 怎么验

打开 **设置 → 通用 → API 日志**（`lib/ai/apiLog.ts`），它会记下完整的请求体与
响应体 —— 这份清单里绝大多数问题都能从那里直接读出答案，不需要写脚本。

**建议顺序**：先做 §1 的三条阻断项，它们各自决定一整块功能是否真的在工作；
其余按族分组，配一个模型跑一次即可覆盖该族大半。

---

## 1. 阻断项：不验就不知道功能是否真的生效

这三条的共同点是**失败时没有任何现象** —— 不报错、不中断，只是功能悄悄没起作用。

### 1.1 ④ Anthropic：思考真的开着吗

**为什么最重要**：Anthropic 对"思考配置不合法"的反应是**静默关闭思考**而非
报错（[`api/reasoning.md`](api/reasoning.md) §3.1）。所以"我们发了 `adaptive`"
不等于"它在思考"。

**怎么验**：配一个 Claude 4.6+ 模型，跑一次**带工具的**运行（续写的 agent 模式、
或对话助手问一个需要读设定的问题）。在 API 日志里看响应：

- ✅ 响应的 `content` 数组里有 `type: "thinking"` 的 block → 思考开着
- ❌ 一个都没有 → 被静默关掉了，回去查 `thinking` 字段发对了没有

**顺带验掉第 5 刀**：第二轮及以后的请求里，assistant 消息的 `content` 应当以
thinking block 开头、后跟 `tool_use`。缺了就是回传没生效。

### 1.2 ③ Gemini：`includeThoughts` 之后拿到了什么

**为什么重要**：`includeThoughts` 默认关闭，我们刚把它打开
（[`gemini-plan.md`](gemini-plan.md) §3 第 2 刀）。而 `part.thought` 的实际形态
只在指南页出现过，参考页没定义。

**怎么验**：配一个 Gemini 3+ 模型跑一次续写，看响应的 `parts`：

- `thought: true` 的 part 长什么样？是纯 `{thought, text}`，还是带别的字段？
- `thoughtSignature` 挂在哪个 part 上？（决定我们的原样回传是否够）
- 面板的思维链折叠区有没有内容？

### 1.3 ① 兼容层：思维链字段名到底有几种

**为什么重要**：`REASONING_CONTENT_FIELDS` 现在只认 `reasoning_content` 与
`reasoning` 两种，外加内联 `<think>` 切分器。**多一种没覆盖的写法 = 那家的思维链
全部丢失**（不报错）。

**怎么验**：手头每个 ① 族中继各跑一次，看响应 `delta` 里思维链在哪个键上。
新发现的名字加进 `REASONING_CONTENT_FIELDS` 即可，一个字符串的事。

---

## 2. ④ Anthropic

| # | 验什么 | 怎么验 | 影响 |
| --- | --- | --- | --- |
| 2.1 | `display:"summarized"` 返回的文本量，与计费 token 的差距 | 对比响应里 thinking 文本长度与 `usage.output_tokens_details.thinking_tokens` | 用量面板是否需要一句说明（[`anthropic-plan.md`](anthropic-plan.md) §5.4） |
| 2.2 | `DEFAULT_MAX_TOKENS` 从 8k 提到 32k 后，上下文预算的实际变化 | 看 AiPanel 的上下文分配条：`maxOutput` 未配置的模型，预留是否明显变多 | `lib/context/budget.ts` 拿它做规划，这个常量不孤立（§5.1） |
| 2.3 | 中继是否透传 `output_config` | 同一中继模型分别发 `effort: "low"` 与 `"max"`，比较输出 token 量 | 决定 Claude 上的力度拨盘在中继上是不是按了没反应（§3.6） |
| 2.4 | 中继上 `adaptive` 被拒时的 400 措辞 | 故意给一个 4.5 模型发 `adaptive`，看报错原文 | 是否会被 `structured.ts` 的 `TOOL_CAPABILITY_ERROR` 误判成"不支持工具调用"（推断为不会，值得验） |
| 2.5 | MiniMax ④ 族端点是否接受 `display` 字段 | 配 MiniMax 的 `/anthropic` 端点跑一次 | 它的文档没列这个字段；透传则无害，严格校验则 400 |

## 3. ③ Gemini

| # | 验什么 | 怎么验 | 影响 |
| --- | --- | --- | --- |
| 3.1 | 3.1 Pro 是否拒绝 `MINIMAL` | 该模型 + 思考档位设「关闭」 | 它的档位是 `low/medium/high`；若拒绝，「关闭」在该模型上要另映射 |
| 3.2 | 档位是否真的生效 | 对比 `MINIMAL` 与 `HIGH` 的 `thoughtsTokenCount` | 验证映射不是白发 |
| 3.3 | 中继的 camelCase 假设 | 配一个 ③ 族中继，发一张图，看模型是否真的看见了 | 我们刚从 snake_case 改过来（[`api/landscape.md`](api/landscape.md) §7）；错了的表现是图片被静默忽略 |
| 3.4 | 中继的 Bearer 鉴权 | 同上，`authMode` 选 `bearer` 后模型列表能否拉到 | 四条路径（聊天/列表/探测/图像）都要通 |

## 4. ① OpenAI 系

| # | 验什么 | 怎么验 | 影响 |
| --- | --- | --- | --- |
| 4.1 | `reasoning_effort` 发顶层是否被 DeepSeek 接受 | 设一个非默认档位，看是否生效（对比输出长度） | DeepSeek 的 API 参考说它在 `thinking` 内部，指南的示例发顶层；若只认嵌套，**强度设置在 DeepSeek 上静默失效** |
| 4.2 | 「关闭」档在 DeepSeek 上是否有效 | 设「关闭」，看响应还有没有 `reasoning_content` | `thinking.reasoning_effort` 的枚举没有 `none`，大概率无效 |
| 4.3 | newAPI 的流式是否返回 usage | 跑一次，看用量统计是不是 0 | 不返回的表现是**用量统计全为 0**，不报错 |

---

## 5. 验完之后

- **回原文档更新结论** —— 本文只是索引，判断依据要留在各自的方案文档里。
- **新发现的兼容层差异**记进 [`api/landscape.md`](api/landscape.md) §7 的样本
  清单，那里已经有五个样本和四条通用规律。
- **本文验完即可删**。它存在的理由是"这些事只在同一次动手时才会被执行"，
  执行完就没有价值了。
