# 思考功能的验证清单

> **状态：MiniMax-M3 已验掉一部分（§2.6），其余全部未验证。**（§2.8 提示缓存不是
> 思考功能，但它与本文其余各条是同一类问题——发出去了不等于对面照做——所以放在这里。） 三族的思考支持
> （强度 / 思维链 / 回传）都已实现并通过单元测试，但单元测试验的是"我们发出了
> 什么"，这份清单验的是"对面怎么理解"。
>
> 第一次实测就抓到一个静默缺陷（服务端搜索之后 turn 停在半路，
> [`anthropic-plan.md`](../api/anthropic-plan.md) §10.5）—— 这正是本文存在的理由，
> 也说明"通过单元测试"与"真的能用"之间的距离有多大。
>
> 分散在 [`reasoning-plan.md`](../api/reasoning-plan.md)、[`anthropic-plan.md`](../api/anthropic-plan.md)、
> [`gemini-plan.md`](../api/gemini-plan.md) 三份文档里的实测项汇总在此，因为它们只在
> 同一次动手时才会被真正执行。**验完请回原文档更新对应结论**，本文只是索引。

## 怎么验

打开 **设置 → 通用 → API 日志**（`lib/ai/apiLog.ts`），它会记下完整的请求体与
响应体 —— 这份清单里绝大多数问题都能从那里直接读出答案，不需要写脚本。

**建议顺序**：先做 §1 的三条阻断项，它们各自决定一整块功能是否真的在工作；
其余按族分组，配一个模型跑一次即可覆盖该族大半。§2.6（MiniMax-M3）是一整块
独立功能，配一个模型就能一次跑完八条。

---

## 1. 阻断项：不验就不知道功能是否真的生效

这三条的共同点是**失败时没有任何现象** —— 不报错、不中断，只是功能悄悄没起作用。

### 1.1 ④ Anthropic：思考真的开着吗

**为什么最重要**：Anthropic 对"思考配置不合法"的反应是**静默关闭思考**而非
报错（[`api/reasoning.md`](../api/reasoning.md) §3.1）。所以"我们发了 `adaptive`"
不等于"它在思考"。

**怎么验**：配一个 Claude 4.6+ 模型，跑一次**带工具的**运行（续写的 agent 模式、
或对话助手问一个需要读条目的问题）。在 API 日志里看响应：

- ✅ 响应的 `content` 数组里有 `type: "thinking"` 的 block → 思考开着
- ❌ 一个都没有 → 被静默关掉了，回去查 `thinking` 字段发对了没有

**顺带验掉第 5 刀**：第二轮及以后的请求里，assistant 消息的 `content` 应当以
thinking block 开头、后跟 `tool_use`。缺了就是回传没生效。

### 1.2 ③ Gemini：`includeThoughts` 之后拿到了什么

**为什么重要**：`includeThoughts` 默认关闭，我们刚把它打开
（[`gemini-plan.md`](../api/gemini-plan.md) §3 第 2 刀）。而 `part.thought` 的实际形态
只在指南页出现过，参考页没定义。

**怎么验**：配一个 Gemini 3+ 模型跑一次续写，看响应的 `parts`：

- `thought: true` 的 part 长什么样？是纯 `{thought, text}`，还是带别的字段？
- `thoughtSignature` 挂在哪个 part 上？（决定我们的原样回传是否够）
- 面板的思考过程折叠区有没有内容？

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
| 2.1 | `display:"summarized"` 返回的文本量，与计费 token 的差距 | 对比响应里 thinking 文本长度与 `usage.output_tokens_details.thinking_tokens` | 用量面板是否需要一句说明（[`anthropic-plan.md`](../api/anthropic-plan.md) §5.4） |
| 2.2 | `DEFAULT_MAX_TOKENS` 从 8k 提到 32k 后，上下文预算的实际变化 | 看 AiPanel 的上下文分配条：`maxOutput` 未配置的模型，预留是否明显变多 | `lib/context/budget.ts` 拿它做规划，这个常量不孤立（§5.1） |
| 2.3 | 中继是否透传 `output_config` | 同一中继模型分别发 `effort: "low"` 与 `"max"`，比较输出 token 量 | 决定 Claude 上的力度拨盘在中继上是不是按了没反应（§3.6） |
| 2.4 | 中继上 `adaptive` 被拒时的 400 措辞 | 故意给一个 4.5 模型发 `adaptive`，看报错原文 | 是否会被 `structured.ts` 的 `TOOL_CAPABILITY_ERROR` 误判成"不支持工具调用"（推断为不会，值得验） |
| 2.5 | MiniMax ④ 族端点是否接受 `display` 字段 | 配 MiniMax 的 `/anthropic` 端点，思考方言选**「自动」**（即发 `display`）跑一次 | 已不再是阻塞项：方言选「开关式」就不发这个字段（[`anthropic-plan.md`](../api/anthropic-plan.md) §10.1）。仍值得一验，因为答案决定「自动」档在该端点上能不能用 |

### 2.6 MiniMax-M3 专项（`switch` 方言 + 服务端工具）

配一个 `anthropic_compat` 供应商（base URL 填 `https://api.minimaxi.com/anthropic`，
鉴权 `bearer` 或默认 `x-api-key` 均可），模型 `MiniMax-M3`，**思考参数形态选
「开关式」**。

**已验（2026-08-14，一次 Agent 模式运行 + 一次联网搜索）**：

| # | 结论 |
| --- | --- |
| 2.6.1 | ✅ `{type:"adaptive"}` 开出了思考 |
| 2.6.2 | ✅ **思考文本可见** —— 不发 `display` 也拿得到，无需回头补 2.5 |
| 2.6.6 | ✅ 服务端 `web_search` 声明被接受，块名与文档一致（`server_tool_use` / `web_search_tool_result`） |
| 2.6.7 | ✅ 结果字段读得出（8 次搜索 × 10 条命中，标题与 URL 都有） |
| 2.6.8 | ✅ 服务端工具与我们自己的 22 个工具同处一个 `tools` 数组，未被拒 |
| 2.6.9 | ✅ **不发 `pause_turn`，报 `end_turn`** —— 但 turn 确实停在半路，见 [`anthropic-plan.md`](../api/anthropic-plan.md) §10.5 |

**仍未验**：

| # | 验什么 | 怎么验 | 影响 |
| --- | --- | --- | --- |
| 2.6.3 | 「力度」选**关闭**时 `{type:"disabled"}` 是否被接受 | 力度设「关闭」跑一次 | 这是唯一真能关掉思考的 ④ 族端点，若被拒则该档要改映射 |
| 2.6.4 | 结构化任务（一致性检查）能否跑通 | 对一篇有条目的文档跑一次一致性检查 | 我们把强制 `tool_choice` 降级成了 `auto`（§10.2）。若模型不主动调工具，应看到它**自动退回 JSON 模式**并仍给出结果；两条路都失败才是缺陷 |
| 2.6.5 | 工具轮回传 thinking block 是否被接受 | Agent 模式跑一次会调工具的任务，看第二轮请求体 | MiniMax 文档要求"回传完整响应"，`signature` 必须原样。被拒会是 400，能自己暴露 |
| 2.6.10 | **续跑是否真的救回了答案** | 问一个会触发多次搜索的问题（实测那次 8 次），看界面上答案有没有写完 | §10.5 + §10.7 那两个补丁的唯一验收项。API 日志里现在每次 HTTP 请求都有一条 `request-body`（带 `leg` 序号），续跑请求看得见 —— `leg:2` 的 messages 末尾应是「assistant 开场白 + user 搜索结果文本」两条纯文本消息，且**不含任何 `server_tool_use` / `tool_result`** |
| 2.6.11 | 续跑请求会不会撑爆上下文 | 同上，看是否报 ContextSizeError 或上游 400 | 它把搜索结果渲染成文本重发（实测首个请求已 123k）。已有两道闸：单条 600 字、整份 12,000 字（§10.7）；仍不够就得再降 |
| 2.6.12 | ~~渲染出来的结果里有没有正文~~ | — | **已验：有。** 每条腿的续跑消息带 12k 字左右的结果正文（`web_search_result.content` 存在） |
| 2.6.16 | **收尾轮是否真的不再联网** | 让一次 agent 运行跑到轮数上限，看最后一轮的 `request-body` | §10.9 把 `serverTools` 一并纳入 `withholdTools`。该轮的 `tools` 应当**完全没有** —— 此前是 `[web_search]` |
| 2.6.15 | **模型拿到结果后会不会真的写正文** | 问一个需要多批检索的问题，看执行日志里的续跑行与最终产出 | §10.8 把续跑提示词改成「先写这一批再搜下一批」、最后一条腿禁止再检索。改动前的症状是 16 次搜索只换来 69 字预告 —— 这是该改动的唯一验收项 |
| 2.6.13 | `max_uses` 是否被接受 | 同上，看是否 400、搜索次数是否被压到 10 以内 | 它的文档没列这个字段；被拒则要撤掉（§10.6） |
| 2.6.14 | `usage.server_tool_use.web_search_requests` 有没有 | 看响应 usage | 决定能不能把搜索次数计入用量面板 |

### 2.7 官方端点服务端工具（api.anthropic.com，全部未验）

现有实现对官方端点是"预期走正路"的推断（[`anthropic-plan.md`](../api/anthropic-plan.md)
§10.10）：声明格式与官方一致、`pause_turn` 的 verbatim 续跑本就按官方行为实现，
但没有对 api.anthropic.com 实测过。配一个官方供应商、给模型勾上 web_search 即可验。

| # | 验什么 | 怎么验 | 影响 |
| --- | --- | --- | --- |
| 2.7.1 | `web_search_20250305` 不带 `anthropic-beta` header 是否被接受 | 勾选 web_search 后随便问一个需要联网的问题 | 官方资料称 GA 无需 header；若 400 则 `authHeaders` 要加头 |
| 2.7.2 | `pause_turn` → verbatim 续跑是否成功 | 问一个会触发多次搜索的问题，看 API 日志里 `leg:2` 的请求体：应是**原样回传的块**（含 `encrypted_content`），且不被 400 拒 | 这是与 MiniMax 分叉的那条正路（§10.5/§10.7），从未走通过一次 |
| 2.7.3 | `usage.server_tool_use.web_search_requests` 有没有 | 看响应 usage | 与 2.6.14 同一问题，官方端点上按官方文档应当存在；验到即可把搜索次数计入用量面板 |

### 2.8 提示缓存（`cache_control`）—— **暂缓，backlog**

> 作者 2026-08-21 的判断：这条暂时用不上，不急着验。放在这里当待办，不是阻塞项。
> 想做的时候，2.8.4 是收益最大的一格（MiniMax-M3 是本项目最常用的中转端点）。

④ 族的 prompt caching 是**显式**的（[`api/landscape.md`](../api/landscape.md) §5）：
不打断点就一定不缓存。1.22 起官方端点会在 `tools` 最后一项和 `system` 上各打一个
断点（`lib/ai/anthropic.ts` → `cachesPrompt`），把 agent 循环每一轮重发的那几千
token 固定头部变成缓存读。**第三方 ④ 族端点一律不打**——这一节就是解开它的条件。

| # | 验什么 | 怎么验 | 影响 |
| --- | --- | --- | --- |
| 2.8.1 | 官方端点真的命中了吗 | 配官方模型，在对话助手里连问两句。看第二次请求响应的 usage：`cache_read_input_tokens` 应≈第一次的 `cache_creation_input_tokens` | 不命中说明断点位置或 TTL 判断错了；表现是**无症状地照付全价** |
| 2.8.2 | 断点是否被工具集变化打断 | 同上，但中途批准一次知识库方案（PR5a 之后工具集会在运行中变长） | 命中率骤降说明常驻工具的顺序没稳住，缓存前缀每轮都在变 |
| 2.8.3 | MiniMax-M3：`system` 数组带 `cache_control` 是否被接受 | 手工发一个最小请求（或临时放开 `cachesPrompt`），看是否 400 | 文档写了接受但从未验过。通过则可以只对 compat 开 system 断点 |
| 2.8.4 | MiniMax-M3：`tools` 上的 `cache_control` 是否被接受 | 同上，断点改打在最后一个工具上 | 文档**没写**。这是本项目最常用的中转端点，通过了才是收益最大的一格 |
| 2.8.5 | 其它 ④ 族中继（New API 一类）对未知字段的态度 | 同 2.8.3 | 若静默忽略而非 400，可以按"打了不亏"放开；若 400 则必须按 standard 分档 |

> 验完记得回 [`agent-tool-context-lld.md`](../feature/agent/agent-tool-context-lld.md) §2.3 更新结论。

## 3. ③ Gemini

| # | 验什么 | 怎么验 | 影响 |
| --- | --- | --- | --- |
| 3.1 | 3.1 Pro 是否拒绝 `MINIMAL` | 该模型 + 思考档位设「关闭」 | 它的档位是 `low/medium/high`；若拒绝，「关闭」在该模型上要另映射 |
| 3.2 | 档位是否真的生效 | 对比 `MINIMAL` 与 `HIGH` 的 `thoughtsTokenCount` | 验证映射不是白发 |
| 3.3 | 中继的 camelCase 假设 | 配一个 ③ 族中继，发一张图，看模型是否真的看见了 | 我们刚从 snake_case 改过来（[`api/landscape.md`](../api/landscape.md) §7）；错了的表现是图片被静默忽略 |
| 3.4 | 中继的 Bearer 鉴权 | 同上，`authMode` 选 `bearer` 后模型列表能否拉到 | 四条路径（聊天/列表/探测/图像）都要通 |

## 4. ① OpenAI 系

| # | 验什么 | 怎么验 | 影响 |
| --- | --- | --- | --- |
| 4.1 | `reasoning_effort` 发顶层是否被 DeepSeek 接受 | 设一个非默认档位，看是否生效（对比输出长度） | DeepSeek 的 API 参考说它在 `thinking` 内部，指南的示例发顶层；若只认嵌套，**强度设置在 DeepSeek 上静默失效** |
| 4.2 | 「关闭」档在 DeepSeek 上是否有效 | 设「关闭」，看响应还有没有 `reasoning_content` | `thinking.reasoning_effort` 的枚举没有 `none`，大概率无效 |
| 4.3 | newAPI 的流式是否返回 usage | 跑一次，看用量统计是不是 0 | 不返回的表现是**用量统计全为 0**，不报错 |
| 4.4 | DashScope：`switch` 方言的 `enable_thinking` 是否生效 | `openai_compat` 接 compatible-mode，模型声明「开关式」、力度设非「关闭」，对默认关思考的商业款（qwen3-max 一类）看响应有没有 `reasoning_content` | 不生效则这类模型**永远不思考**，且不报错 |
| 4.5 | DashScope：「关闭」档是否真的关思考 | 同上，力度设「关闭」，对默认开思考的模型（Qwen3.5+）看 `reasoning_content` 是否消失 | 不生效的表现是照常思考照常计费 |
| 4.6 | DashScope：Qwen3.7+ 对顶层 `reasoning_effort` 的实际接受度 | 不声明方言、设非默认档，看是否 400 或生效 | 被拒则新款也得声明「开关式」，ModelDrawer 的 openai 族 hint 文案要跟着改 |
| 4.7 | DashScope：`enable_search: true` 在 Chat Completions 上是否生效 | 模型开启服务端 web_search，问一个时效性问题（"今天……"），对比开关前后的答案 | 文档说该模式不返回任何搜索痕迹，所以**不生效也完全无症状**——只能靠答案内容判断；不生效则搜索子代理绑千问等于白跑 |
| 4.8 | DashScope：思考开 + forced `tool_choice` 的报错与降级条件是否精确 | 声明「开关式」、力度设「关闭」，跑一次结构化任务（forced pseudo-tool），确认思考关时 forced 真的合法 | 若「关闭」时也拒 forced，`toolChoiceFor` 的降级条件要放宽成"方言声明即降级"（与 anthropic 侧对齐） |
| 4.9 | DashScope：`file` 内容块（base64 `file_data` + `filename`）是否被 qwen3.8-max 接受；一次多个 PDF 是否可行 | PDF 子代理绑 qwen3.8-max，delegate 一份小 PDF；再试 refs 传两份 | 文档只给了单文件示例；多文件被拒则 `MAX_PDF_FILES` 应降为 1 |

---

## 5. 验完之后

- **回原文档更新结论** —— 本文只是索引，判断依据要留在各自的方案文档里。
- **新发现的兼容层差异**记进 [`api/landscape.md`](../api/landscape.md) §7 的样本
  清单，那里已经有六个样本和四条通用规律。
- **本文验完即可删**。它存在的理由是"这些事只在同一次动手时才会被执行"，
  执行完就没有价值了。
