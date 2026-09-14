# 工具按需加载（tool search / deferred loading）：各族协议事实

> **性质**：与 [`tools.md`](tools.md) 同类的协议事实页，外加一节「与本项目的关系」。
> **来源**：2026-09-14 读各家**官方文档**（链接见每节末尾）。**形状全部未实测**——实测到的只有
> 两条拒绝：New API 中转站上单发 `{type:"tool_search"}` 回 400
> `tools.tool_search requires at least one deferred tool`（[`landscape.md`](landscape.md) 第十个样本）；
> xAI 官方端点带着延迟工具发，回 403「仅对 alpha 用户开放」（第十一个样本）。
> **状态**：`living`。本项目是否采用见 [`gpt56-plan.md`](gpt56-plan.md) P7（2026-09-14 搁置：不为单一 vendor 调整工具装载架构）。

## 0. 一句话

大工具表每轮都要付输入 token。按需加载把一部分工具标成「延迟」：模型起初只看到名字和
描述（或什么都看不到），需要时经一次**搜索**把完整定义取进上下文。原生实现和自己实现的
区别只有一条：**原生的把取回的定义放在上下文末尾或原地展开，前缀缓存不动**；自己改
`tools` 参数则从工具表那一截起缓存全部作废。

## 1. 各族对照

| | ② OpenAI Responses | ④ Anthropic Messages | ② xAI Responses | ③ Gemini | ① Chat Completions（全部） |
| --- | --- | --- | --- | --- | --- |
| 原生支持 | ✅ GPT-5.4 起 | ✅ Sonnet/Haiku/Opus 4.5 起 | ⚠️ 规格里有，**实测 403**（2026-09-14，grok-4.3）：`The tool_search tool and defer_loading are only available for alpha users` | ❌ | ❌ |
| 延迟标记 | 函数 / MCP / custom 工具上 `defer_loading: true` | 工具上 `defer_loading: true` | 函数 / `mcp` 上 `defer_loading: true` | —（带这个字段整个请求被拒，第三方报告） | — |
| 搜索工具 | `{type:"tool_search", execution?: "server"\|"client", description?, parameters?}` | `tool_search_tool_regex_20251119` / `tool_search_tool_bm25_20251119`（或不带日期的别名） | `{type:"tool_search", execution:"server"}`，只有服务端 | — | — |
| 客户端自己搜 | ✅ `execution:"client"`：模型发 `tool_search_call` 后停，应用回 `tool_search_output{tools:[…]}` | ✅ 自己的工具在 `tool_result` 里返回 `tool_reference` 块 | ❌ | — | — |
| 不经模型、由应用插入 | ✅ `{type:"additional_tools", role:"developer", tools:[…]}` 条目 | ❌（需一次 `tool_result`） | 未见 | — | — |
| 分组 | `{type:"namespace", name, description, tools:[…]}`，建议每组 ≤10 | 无 | 未见 | — | — |
| 返回形状 | `tool_search_call{call_id, execution, status, arguments}` → `tool_search_output{…, tools}`；随后 `function_call` 多一个 `namespace` 字段 | `server_tool_use`（`srvtoolu_…`）→ `tool_search_tool_result{content:{type:"tool_search_tool_search_result", tool_references:[{type:"tool_reference", tool_name}]}}` | `ToolSearchCall` / `ToolSearchOutput`（参数 `{query, limit}`，type 串未取到） | — | — |
| 放在哪 | 「全部加载在上下文**末尾**」 | 在对话正文**原地展开**，「不在前缀里」 | 未写 | — | — |
| 缓存 | 前缀不动；**换一批加载的工具会从那一点起破坏缓存** | 前缀不动，缓存保留 | 未写 | 显式缓存 `CachedContent.tools` 创建后不可改；隐式缓存未写 | 改 `tools` 就失效 |
| 回传（无状态） | 下一轮 `input` 必须带着 `tool_search_output`，**不带就不可用**（「未列在该数组里的工具不可用」） | 历史里保留 `tool_search_tool_result` 块即可；不要给 `srvtoolu_` 回 `tool_result` | 未写 | — | — |
| 限制 | 未写；示例都 `parallel_tool_calls:false` | 至少一个非延迟工具（通常是搜索工具本身），否则 400；延迟工具 ≤10,000；默认一次返回 5 个；`defer_loading` + `cache_control` 同时出现 400；引用未定义的工具 400 | 函数工具总数 ≤350 | 建议「活跃工具 10–20 个」 | — |
| 计费 | 未写 | 不单独计费，加载的定义算输入 token | 未写 | — | — |
| 平台 | Responses、Agents；Chat Completions 无 | Claude API、Claude Platform on AWS；Bedrock **仅 InvokeModel**（Converse 不行）；Vertex / Foundry 文档未提 | `/v1/responses` 专属 | — | — |

**一处要注意的语义差**：OpenAI 的单个延迟函数，模型**仍看得到名字与描述**，推迟的主要是
参数 schema（文档原话大意）；Anthropic 的延迟工具在搜到之前**完全不在**模型视野里。
所以同样标了 `defer_loading`，OpenAI 省的是参数那一截，Anthropic 省的是整条定义。

## 2. 流式

- **Anthropic**：`content_block_start{server_tool_use}` → `input_json_delta`（`{"pattern":…}`）→
  停顿（服务端在搜）→ `content_block_start{tool_search_tool_result}` 一次到齐、无 delta。
- **OpenAI**：流式事件参考里**没有**专门的 tool search 事件，条目只出现在通用的
  `response.output_item.added/done` 里。
- **xAI**：未写。

## 3. 与本项目的关系

本项目**已经在做按需加载**，只是不经模型、也不经端点：

- `registry.ts` 的 `ToolGroup`（今天是 `lore_write` 16 个、`lore_organize` 4 个）由**运行状态**
  自动装载——批准知识库方案那一刻进 `tools`，追加在常驻工具之后，保住工具数组的前缀
  （[`agent-tool-context-lld.md`](../feature/agent/agent-tool-context-lld.md) §5，实测每轮省 2,542）。
- 「让模型自己开口要工具」的本地版 `load_tools` **实测否掉了**（同文 §6）：gemma4:12b 在
  工具就摆在眼前时分段写文件 3 次 0 次走通，再加一层间接只会从「做得差」变「做不了」。
  重开的条件写在那里：**一个能稳定完成 §4.3 第三格的模型，在同样的间接下仍然稳定。**

对照上表，原生 tool search 改变的只是两件事：

1. **缓存不再是代价**（OpenAI、Anthropic）——本地版被否的理由里没有缓存这一条，所以这不足以
   单独翻案。
2. **只在强模型上有**（GPT-5.4+ / Claude 4.5+ / Grok）——恰好是 §6 重开条件指向的那一档，
   但「稳定」需要实测，文档给不了。

而有一个原生机制**不需要模型配合**，和 §6 的结论同向：**OpenAI 的 `additional_tools` 条目**——
应用在对话的某个位置插入工具定义，定义在上下文末尾、前缀不动。这正是 5a「由运行状态装载」
在 ② 族上的缓存友好写法。Anthropic 没有对应物（`tool_reference` 必须经一次 `tool_result`）。

**做之前必须先定的**（均需官方 key）：

- `additional_tools` 在 `store:false` 下的回传规则（文档只说「重发时保持同一位置」）。
- 本项目 `isEchoItem` 只回传 `reasoning` / `function_call` / `message`；任何原生方案都要把
  `tool_search_call` / `tool_search_output` / `additional_tools` 加进回传，否则**加载过的工具
  下一轮静默消失**——与 [`tools.md`](tools.md) 里「回传缺失无现象」同一类失败。
- `tool-presence.md` 的契约：延迟工具算不算「在场」、briefing 能不能提到它们。

## 来源（2026-09-14）

- OpenAI：[Tool search guide](https://developers.openai.com/api/docs/guides/tools-tool-search) ·
  [Function calling / namespaces](https://developers.openai.com/api/docs/guides/function-calling) ·
  [Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create) ·
  [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- Anthropic：[Tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) ·
  [Tool reference](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference) ·
  [Tool use with prompt caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching) ·
  [MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)（`mcp_toolset` 的
  `default_config` / `configs` 里也有 `defer_loading`，连接器本身仍需 beta 头 `mcp-client-2025-11-20`）
- xAI：`https://docs.x.ai/openapi.json`（只在规格里，无文档页）
- Gemini：[Function calling](https://ai.google.dev/gemini-api/docs/function-calling) ·
  [Caching API](https://ai.google.dev/api/caching) ·
  功能请求 [googleapis/python-genai#2185](https://github.com/googleapis/python-genai/issues/2185)（2026-03-18 开，未回应）
