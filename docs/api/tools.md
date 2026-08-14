# 工具调用（function calling）

> 边界见 [`README.md`](README.md)：只写协议事实。族的编号沿用
> [`landscape.md`](landscape.md)：① Chat Completions ② Responses ③ Google GenAI
> ④ Anthropic Messages。

一次工具调用横跨四件事，四族在每一件上都不同：**怎么声明工具**、**模型怎么
发起调用**、**结果怎么送回去**、**怎么强制或禁止调用**。

## 1. 对照

| | ① Chat Completions | ② Responses | ③ Google GenAI | ④ Anthropic |
| --- | --- | --- | --- | --- |
| **声明** | `tools[].function.{name,description,parameters}`（**嵌套**在 `function` 下） | `tools[].{type,name,description,parameters}`（**扁平**） | `tools[].functionDeclarations[]` | `tools[].{name,description,input_schema}` |
| **schema 字段名** | `parameters` | `parameters` | `parameters` | **`input_schema`** |
| **模型发起** | `assistant.tool_calls[]` | output item `type:"function_call"` | `parts[].functionCall` | content block `type:"tool_use"` |
| **调用 id** | `id` | `call_id` | **无** | `id` |
| **参数载体** | `function.arguments`（**JSON 字符串**） | `arguments`（**JSON 字符串**） | `args`（**已解析的对象**） | `input`（**已解析的对象**） |
| **结果消息** | `role:"tool"` | input item `type:"function_call_output"` | `role:"user"` 的 `parts[].functionResponse` | `role:"user"` 的 `tool_result` block |
| **结果关联** | `tool_call_id` | `call_id` | **靠函数名 `name`** | `tool_use_id` |
| **选择策略** | `tool_choice`：`none`/`auto`/`required`/`{type:"function",function:{name}}` | `tool_choice` 同形 | `toolConfig.functionCallingConfig.mode`：`AUTO`/`ANY`/`NONE`（+`allowed_function_names`） | `tool_choice.type`：`auto`/`any`/`tool`(+`name`)/`none` |
| **流式装配** | 按 `index` **分片拼接** `arguments` | `response.function_call_arguments.delta` 累积 | **整个 `functionCall` 一次给全**，不分片 | `input_json_delta` 累积 |

## 2. 三个跨族移植时会静默出错的点

**① Gemini 的工具结果没有 id。** `functionResponse` 靠 `name` 回指，所以同一轮里
并行调用同一个函数两次，"哪个结果对应哪次调用"在协议层就是不可表达的。从别族
移植过来时必须自己维护 `id → name` 的映射，并接受这个信息损失。

**② 参数是字符串还是对象，两族一半一半。** ①② 给 JSON **字符串**（要自己
`JSON.parse`，且模型可能吐出非法 JSON）；③④ 给**已解析的对象**。写一个跨族的
适配层时，这是最容易漏掉的类型分歧。

**③ 工具结果不是独立角色，只有 ① 是。** ③④ 都把结果塞进 `role:"user"` 的消息里，
② 是一个独立的 input item。按 ① 的心智模型去写 ③④ 会得到一个被拒绝的请求。

## 3. 配对是硬要求，且违反的后果是永久的

**每一个 `tool_calls`/`tool_use`/`functionCall` 都必须有对应的结果消息**，四族
一致。OpenAI 的报错原话是 "An assistant message with 'tool_calls' must be
followed by tool messages responding to each tool_call_id"，Gemini 与 Anthropic
同样拒绝。

危险之处在于**这个错误不会自愈**：会话历史是累加的，一次缺失的结果会留在历史里，
之后每一轮都带着它重发，于是整段对话从此不可用。任何可能中途退出的实现
（用户中止、异常、超时）都必须保证：要么两条消息都不写进历史，要么写进去的
调用一定配上一条结果——哪怕内容是"未执行"。

## 4. ① Chat Completions（及其兼容层）

```jsonc
// 声明
"tools": [{ "type": "function", "function": {
  "name": "get_weather", "description": "…",
  "parameters": { "type": "object", "properties": { "location": { "type": "string" } },
                  "required": ["location"] }
}}],
"tool_choice": "auto"

// 模型发起 → 结果送回
{ "role": "assistant", "content": null,
  "tool_calls": [{ "id": "call_1", "type": "function",
                   "function": { "name": "get_weather", "arguments": "{\"location\":\"Hangzhou\"}" } }] },
{ "role": "tool", "tool_call_id": "call_1", "content": "24℃" }
```

细节：

- **assistant 的 `content` 是 `nullable` 但 required** —— 字段必须存在，值可以是
  `null`。省略整个字段与发 `null` 不是一回事。
- **`tool` 消息的 `content` 是字符串**，不是对象。要送结构化结果就自己序列化。
- **流式下 `arguments` 是分片的**，按 `delta.tool_calls[].index` 拼接。同一轮的
  多个调用交错到达，`index` 是唯一可靠的分组键（`id` 也可能分片）。
- **`tools` 上限 128 个**（DeepSeek 文档明示；OpenAI 同量级）。
- `function.strict` 是可选的严格 schema 模式，兼容层普遍不实现。

### DeepSeek 的差异（截至 2026-08）

拼接流程与 OpenAI **完全一致**——官方示例就是 `messages.append(response.choices[0].message)`
再 append 一条 `{"role":"tool","tool_call_id":…,"content":…}`。`tool_choice` 的
四种取值、128 上限、`stream_options.include_usage` 都对得上。

**唯一的实质差异来自思考模式**：模型进行了工具调用时，assistant 消息里的
`reasoning_content` 必须一起回传，否则 API 返回 400。详见
[`reasoning.md`](reasoning.md) §3——这条是工具调用与思考模式的交界，
只读工具调用那一页文档不会看到它。

## 5. ③ Google GenAI

```jsonc
"tools": [{ "functionDeclarations": [{ "name": "f", "description": "…", "parameters": { /* … */ } }] }],
"toolConfig": { "function_calling_config": { "mode": "AUTO" } }

// 模型发起（role: "model"）        → 结果（role: "user"）
{ "parts": [{ "functionCall": { "name": "f", "args": {} } }] }
{ "parts": [{ "functionResponse": { "name": "f", "response": { /* … */ } } }] }
```

- `mode` 取 `ANY` 时可用 `allowed_function_names` 限定到具体函数集。
- **思考模型返回的 part 带 `thoughtSignature`，后续回合必须原样回传**，否则多轮
  工具调用失效。这意味着适配层不能把 part 归一化成自己的结构后丢弃原始对象。

## 6. ④ Anthropic Messages

```jsonc
"tools": [{ "name": "f", "description": "…", "input_schema": { /* JSON Schema */ } }],
"tool_choice": { "type": "auto" }

{ "role": "assistant", "content": [{ "type": "tool_use", "id": "toolu_1", "name": "f", "input": {} }] },
{ "role": "user",      "content": [{ "type": "tool_result", "tool_use_id": "toolu_1", "content": "…" }] }
```

- schema 字段叫 **`input_schema`**，是四族里唯一不叫 `parameters` 的。
- `tool_choice.type` 的 `any` 相当于别族的 `required`；指定单个工具用
  `{type:"tool", name}`。
- **强制工具选择只与「手动」思考模式冲突**：`thinking:{type:"enabled"}` 下用
  `tool_choice: any` 或 `tool` 会报错；**adaptive 思考支持强制工具调用**。
  这条区分很容易记反，见 [`reasoning.md`](reasoning.md) §3.1。
- **一次工具循环 = 一个 assistant 回合**，整个回合跑在同一个思考配置下，中途
  不能切换。
- 工具轮必须带上该轮的 thinking block 及其 `signature`，同 ③ 的
  `thoughtSignature`。
- **`tools` 里可以混入服务端工具**（`{type:"web_search_20250305", name:"web_search"}`
  一类，无 `input_schema`）。它们由服务端在同一次请求内执行完，响应里是
  `server_tool_use` + `web_search_tool_result` 两个 content block，**不需要
  `tool_result`** —— 把 `server_tool_use` 当普通 `tool_use` 去配一条结果，是
  对一次已完成的调用回话。与 ② 族同形（那边是 item，这边是 content block），
  ①③ 族没有对应物。详见 §6.1。
- **兼容层可能砍掉 `tool_choice` 的强制档**（只留 `auto`/`none`），于是"强制
  失败就退回 JSON 模式"在那些端点上是唯一出路，见 `structured.md` §1。

### 6.1 服务端工具：`pause_turn` 是"没结束"，不是结束

服务端工具（`web_search` / `web_fetch` / `code_execution`…）声明在同一个
`tools` 数组里，但生命周期与普通工具**完全相反**：模型调用它，**服务端自己
执行**，结果直接进同一次响应，调用方无事可做也无从拒绝。

```jsonc
"tools": [{ "type": "web_search_20250305", "name": "web_search", "max_uses": 10 }]

// 响应 content 按执行顺序：
{ "type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search", "input": {"query": "…"} }
{ "type": "web_search_tool_result", "tool_use_id": "srvtoolu_1",
  "content": [{ "type": "web_search_result", "url": "…", "title": "…",
                "page_age": "…", "encrypted_content": "EqgfCioIARgB…" }] }
```

**两条会静默毁掉功能的规则：**

**①「一次请求 = 一个完整回答」不成立。** 服务端可能把 turn 停在半路，而
**只有一种停法是明说的**：

- **`stop_reason: "pause_turn"`** —— 官方 ④ 族的说法，读 stop_reason 就知道。
- **停在 `*_tool_result` 上、报 `end_turn`** —— 兼容层实测存在（MiniMax，见
  [`landscape.md`](landscape.md) §7 第四个样本）：它把搜索结果送回来后不再叫
  模型，于是响应是个格式完好的成功，模型却只留下搜索前那句开场白。**没有任何
  字段说少了东西**，唯一的判据是「结果之后模型还说话了吗」。

两者补救**理论上**相同：把未完成的 assistant turn 原样送回去再发一次。但见下面
那条警告 —— 兼容层可能连自己发出来的块都不收。

**① 的官方形态：`pause_turn`。** 服务端把一个跑得久的
turn 挂起了，要求调用方**把那条 assistant 消息原样送回**再发一次，模型接着写。
官方原文：*"The API can pause a long-running search turn and return
`stop_reason: "pause_turn"`. To continue, send the paused assistant message back
unchanged in a new request."*

把它当成正常结束，症状是**搜索全都跑了、模型写了一句开场白、然后没了，且没有
任何报错** —— 这是本目录里最难自行发现的一种失败，因为响应是 200、文本也确实
有一段。

**② 回传时 `encrypted_content` 必须一字不改。** 官方原文：*"send the assistant's
content blocks back exactly as you received them, including each result's
`encrypted_content` … If `encrypted_content` is missing or modified, the request
fails with a 400 validation error."* 服务端靠解密它来恢复模型看到的搜索内容。

**推论：适配层不能"理解后重建" content block。** 只保留自己认识的字段再拼回去，
恰好会丢掉 `encrypted_content` —— 与 ③ 族 `thoughtSignature` 是同一条教训
（§5）：**跨轮要回传的东西必须整块留存，不能归一化。**

**③ 兼容层可能拒收自己发出来的服务端工具块。** MiniMax 实测（2026-08）：把它的
`server_tool_use` + `web_search_tool_result` 原样送回，得到

```
400 invalid params, tool result's tool id(call_019ffefc…) not found (2013)
```

那个 id 正是它自己在上一次响应里生成的。**推断**：请求侧校验器把任何
`*_tool_result` 都当客户端工具的结果、去找同 id 的 `tool_use`，而
`server_tool_use` 不是那个东西。响应侧实现了、请求侧没有 —— beta 的典型形态。

于是在这类端点上，**协议规定的续跑方式恰好是唯一不被接受的形状**。可移植的兜底
是把结果**渲染成纯文本**当普通消息送回：丢掉引用机制（`encrypted_content` 与
citation 只对签发方有意义），但不依赖对方懂不懂服务端工具。

其他：

- **混合调用走另一条路**：同一组并行调用里既有服务端工具又有调用方工具时，
  `stop_reason` 是 `tool_use` 而**不是** `pause_turn`，且搜索**尚未执行** ——
  先回传调用方的 `tool_result`，服务端在下一轮才跑搜索。
- **失败是 200 里的一个 block**，不是 HTTP 错误：
  `{"type":"web_search_tool_result_error","error_code":"max_uses_exceeded"}`，
  `content` 此时是单个对象而非数组。错误码有
  `too_many_requests` / `invalid_tool_input` / `max_uses_exceeded` /
  `query_too_long` / `request_too_large` / `unavailable`。**搜到 0 条不是错误**，
  是空数组。
- **计费两头都算**：按次（官方 $10/1000 次）+ 搜索结果按 input token 计，
  且**在同一轮的多次迭代与后续轮次里反复计**。`usage.server_tool_use
  .web_search_requests` 给出次数。`max_uses` 是唯一的刹车。

## 7. ② Responses

```jsonc
"tools": [{ "type": "function", "name": "f", "parameters": { /* … */ } }],   // 扁平，无 function 包装

// output 里
{ "type": "function_call", "call_id": "call_1", "name": "f", "arguments": "{…}" }
// 送回时作为 input item
{ "type": "function_call_output", "call_id": "call_1", "output": "…" }
```

工具与消息在同一个 item 流里并列，没有"assistant 消息挂一个旁路字段"这一层。
`tools` 里还可以混入服务端内置工具（`file_search`、`web_search`、`computer` 等），
它们的调用/结果也是 item 类型。
