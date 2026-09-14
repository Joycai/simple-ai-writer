# GPT-5.6（sol / terra / luna）支持度盘点与方案

> **状态**：P2 / P3 / P4.1–4.4 `shipped`（与本文同一个 PR）；P1 / P5 / P6 暂不做（作者 2026-09-14 决定）；
> P7 移到后一期。2026-09-14。
> **性质**：本项目的取舍，不是协议事实。事实在 [`responses.md`](responses.md)（§2、§10），
> 中转站的改写在 [`landscape.md`](landscape.md) §7 第八、第十个样本。
> **证据的边界**：两次实测都经 New API 中转站（`[Pro]` 档 2026-09-03、`[Plus]` 档 2026-09-14），
> **没有一次打过 api.openai.com**。下文每条方案都标了「中转站已定」或「需要官方 key」。

## 1. 已经通的

在 `openai_responses` / `openai_responses_compat` 上，下面这些由 adapter 实测
（`live.openai-responses.test.ts`，terra 12 条过 11 条，唯一失败是中转站无视
`max_output_tokens`）和线路探针共同确认：

| 能力 | 本项目怎么发 | 证据 |
| --- | --- | --- |
| 思考力度 | 类目 `responses-effort`，`off/low/medium/high/xhigh/max` → `reasoning:{effort, summary:"auto"}` | terra 的 `xhigh` / `max` 原样回显；5.4 越界 400 由端点报 |
| 思维链可见 | `reasoning_summary_text.delta` → `{reasoning}` | 发 `summary` 才有，已随 effort 发 |
| 函数工具 + 思考 | 扁平 `tools`、`strict:false` | effort `medium` 下拿到 `function_call` |
| 强制 `tool_choice` | `{type:"function", name}` / `required`，400 学习兜底 | effort `high` 下强制合法 |
| 无状态回传 | reasoning / function_call / message 条目原样回传 | 三种残缺回传都 200 |
| 结构化输出 | `gpt-5` 前缀自动 `text.format: json_schema`，不发 `strict` | terra 通过 |
| 图片 / PDF | `input_image` / `input_file` | terra 通过；sol 的 `input_file` 6 次 4 过（失败归因于中转站上游，含一次静默丢文件，见 landscape 第十个样本） |

sol / terra / luna **不需要按型号分支**：三款共用上面每一条，差别只在后端给不给某一档
（sol 的 `mode:"pro"`），而那是端点的事。

## 2. 顺手修掉的：实测文件读不到自己发的请求体

`streamCompletion` 为了把请求体写进 API 日志，用自己的 `_onRequestBody` **覆盖**了调用方的，
`live.*.test.ts` 里所有 `c.bodies[0]` 断言因此读到 `undefined`——这次 terra 的 12 条里有 6 条
不是端点失败，是这个。改为两个钩子都调用，`responses.test.ts` 加了一条单测守住。

## 3. 缺口与方案

按「用户会不会撞上」排序。

### P1 官方 Chat Completions 上「思考 + 工具」—— **需要官方 key**

**缺口**：OpenAI 文档说 5.4 起 Chat Completions 在 `reasoning_effort ≠ none` 时不支持工具。
本项目在 `openai`（官方）标准上对此没有任何处理：给 5.6 设了力度再跑 agent，预计每次 400。
两台中转站都把 ① 翻译成 ② 再打后端，所以**这条在中转站上永远是好的**，验不了。

**方案**：

1. 先用官方 key 跑一条（`live.openai-responses.test.ts` 旁加一个 ① 族用例）拿到原文报错。
2. **不降级**：把 effort 改成 `none` 或把工具去掉，都是悄悄收回作者给的东西（与千问
   `agent_max` 那次同一条原则）。改为把这条 400 翻译成可操作的报错——
   「这个模型在 Chat Completions 上不能边思考边用工具，把服务商协议换成 OpenAI Responses」，
   与 `probeAnalysis.ts` 翻译参数名报错是同一类。
3. `ProviderDrawer`：填官方地址、选 `openai` 标准时，提示一句「GPT-5.4 及以后建议用
   Responses」。按**标准 + 官方地址**判断，不按模型 id（`provider-layering.md` §4）。

### P2 力度 / temperature 被端点改写，没有人看回显 —— **中转站已定，可以做**

**缺口**：第十个样本里 sol 发 `max`、回显 `effort:"none"`、`reasoning_tokens: 0`；terra 发
`none` 两次都回显 `medium`、照样推理；terra 发 `temperature: 0.5`、回显 `1.0`。请求 200、
输出正常，作者以为开了（或关了）深思考，其实没有。adapter 只读 `usage`，不读
`response.reasoning` / `response.temperature`。还有一次 sol 的响应**完全没有**这几个回显字段
（换了上游）——缺字段时不报告，只报告「有回显且不一致」。

**方案**：`response.completed` 时比对**发出去的**与**回显的** `reasoning.effort`、
`temperature`，不一致就在执行日志与 API 日志里记一条
「端点把 effort 从 max 改成了 none」。只报告、不重试、不改请求——改写的原因可能是
中转站、档位或后端，这一侧分不清，作者看到就能换档。
不做成报错：输出本身是可用的。

落点：`responses.ts` 的终止事件分支读 `response.reasoning.effort`，与 `opts.reasoningEffort`
经 `OPENAI_EFFORT` 映射后的值比；`StreamChunk` 的 `done` 块加一个可选 `wireNotes`。
① 族 Chat Completions 没有回显字段，不做。

### P3 `text.verbosity` —— **中转站已定，可以做**

**缺口**：5.x 的 `verbosity: low/medium/high` 实测生效（terra 同题回答变短），本项目没有入口。
对写作工具它比 effort 更贴近作者的直觉（「简洁 / 详细」）。

**方案**：模型级声明 `textVerbosity?: "low" | "medium" | "high"`，**只在 Responses 族**
的模型抽屉出现，未设置则不发（与 effort 同一条「未声明 = 字节不变」规则）。
按 [`provider-layering.md`](provider-layering.md) 它是 L3 模型字段，进 `ConnOptions`
一次、`configDb` 加列、`modelSummary` 的「将发送」一行显示 `text.verbosity`。
与 `jsonMode` 的 `text.format` 同在 `text` 对象里，拼 body 时要合并而不是覆盖。

### P4 OpenAI 自家 `web_search` —— **中转站已定一半**

**缺口**：`supportsServerTools` 在官方 `openai_responses` 上返回 false，理由是「官方的内置搜索
是没人测过的另一份契约」。现在测过了（`responses.md` §10）：同一个 `web_search_call` 条目类型，
`action` 多一种 `open_page`。在 `openai_responses_compat` 上本项目**今天就会**发
`{type:"web_search"}`，中转站上能用，只是 `open_page` 被解析成空查询、空结果。

**方案**：

1. `responsesServerToolEvent`：`action.type === "open_page"` 时 call 的 input 为 `{url}`、
   result 为 `[{title:url, url}]`；`search` 时 `queries` 缺失则退回 `query`。纯解析，
   单测按 §10 的条目形状写。
2. 放开官方 `openai_responses` 的 `web_search`（**只放这一个 id**；`web_extractor` 与两个图片
   搜索是 DashScope 的，官方没有）。放开前**用官方 key 跑一条**确认 `sources` 是否需要
   `include`。
3. 抽屉里的说明写清成本：一次搜索回答实测 45.7K 输入 token、112 s，另按次计费。
4. 看门狗不用动：首事件 54 s < 120 s 起步，每个 `web_search_call` 的 `output_item.added`
   都会发出 `serverTool` 块并重置空闲计时。
5. `url_citation` 标注暂不处理（正文里已有 markdown 链接）；`tool_usage.web_search.num_requests`
   记进用量是后续事，等计费表（`issues/tiered-pricing.md`）需要时再说。

### P5 `include: ["reasoning.encrypted_content"]` —— **需要官方 key**

**缺口**：官方文档的无状态写法是 `store:false` + `include`。本项目只发 `store:false`。
两台中转站上 reasoning 条目**总是自带**加密内容，所以没出过问题；官方端点不带的话，
回传的 reasoning 条目只剩服务端没存的 `rs_…` id，工具第二轮可能 400。

**方案**：先测（官方 key，一轮带工具、effort `high`，确认第一轮真的产出 reasoning 条目）。
若官方需要：只在 `openai_responses`（官方）上发 `include`；compat 不发——千问的 Responses 面
没有 `encrypted_content`，中转站已经自带，未知字段对千问是否无害也没验。
中转站上发了 `include` 实测 200，所以官方侧即使多发也不会坏。

### P6 `reasoning.mode: "pro"`（sol）—— **暂缓**

两台中转站、`[Pro]` 与 `[Plus]` 两档、sol 与 terra 都回显 `standard`，本项目没有任何渠道
能确认它生效。它是「更贵的另一档」，没有证据前不加入口。有官方 key 后若确认，做成
`responses-effort` 类目上的一个附加开关，而不是新类目。

### P7 `tool_search`（延迟加载工具）—— **后一期**

各族的协议事实已单独成篇：[`tool-search.md`](tool-search.md)（2026-09-14 文档调研，未实测）。
要点：OpenAI（GPT-5.4+）、Anthropic（4.5+）、xAI 有原生支持，Gemini 与所有 Chat Completions
端点没有。

评估的起点不是「要不要按需加载」——本项目已经在做（`lore_write` / `lore_organize` 由运行状态
自动装载，[`agent-tool-context-lld.md`](../feature/agent/agent-tool-context-lld.md) §5）——而是
**§6 否掉 `load_tools` 的那条理由在原生方案下还成不成立**：让模型自己搜工具，弱模型实测做不成。
原生搜索解决的是缓存，不是这条。

所以后一期若做，顺序是：

1. 先看**不需要模型配合**的那一个原生机制——OpenAI 的 `additional_tools` 条目——能不能把 5a 的
   装载改成缓存友好的写法（今天 5a 是往 `tools` 数组尾部追加，② 族上会从工具表那一截起失效缓存）。
2. 让模型自己搜（`tool_search` / Anthropic 的 regex·bm25）要等 §6 的重开条件：一个强模型在同样的
   间接下稳定完成 §4.3 第三格。需要官方 key 实测。
3. 无论哪条，`isEchoItem` 都要先学会回传 `tool_search_call` / `tool_search_output` /
   `additional_tools`，否则加载过的工具下一轮静默消失。

### 不做

- **Chat 面 `web_search_options`**：非 search 模型上被静默忽略，只对 `*-search-*` 型号有意义。
- **`code_interpreter` / `file_search` / `mcp`**：`[Plus]` 档不给或不稳定，且与写作无关；
  `image_generation`、`shell`、`local_shell`、`apply_patch`、`computer_use_preview` 按作者
  要求不纳入。
- **`reasoning.context`**：默认 `all_turns` 就是本项目回传条目想要的效果，没有理由改。
- **按型号裁剪力度菜单**：维持 `reasoning.ts` 的现行规则，越界由端点 400 说话。
- **给带档位前缀的 id（`[Plus]gpt-5.6-terra`）补查表**：`modelLimits` / `jsonMode` 按前缀
  查不到它们，但作者可以手动声明；剥前缀的规则会把别的中转站的别名也吞进来。

## 4. 执行顺序

| 片 | 内容 | 状态 |
| --- | --- | --- |
| A | P2 回显比对（done 块 `wireRewrites` → API 日志 + 执行日志 `round-done` 行）· P3 `text.verbosity` 模型声明 · P4.1 `open_page` / `find_in_page` / `query` 解析 · P4.2 放开官方 `web_search`（其余 id 在官方线上被滤掉）· P4.3 抽屉说明写上成本 | ✅ 与本文同一个 PR |
| B | P1 报错翻译 + 抽屉提示、P5 `include`、P6 `mode:"pro"` | 暂不做（作者决定）；要做时先用官方 key 实测 |
| C | P7 `tool_search` 延迟加载工具 | 后一期 |

P4.2 与计划原文有一处偏离：没有等官方 key 确认 `sources` 是否需要 `include` 就放开了。
理由是 `sources` 只影响执行日志里能列出几个网址——没有它，搜索照样执行、回答照样带
`url_citation`，日志里的 `search` 调用只是结果为空，不会让请求失败。实测结果回填 `responses.md` 与 `landscape.md`。
