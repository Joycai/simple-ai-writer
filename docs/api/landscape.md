# 协议地图：四个族、部署变体、马甲层

> 边界见 [`README.md`](README.md)：本文只写协议事实。

## 1. 总览对照

| | ① Chat Completions | ② Responses | ③ Google GenAI | ④ Anthropic Messages |
| --- | --- | --- | --- | --- |
| **端点** | `POST /v1/chat/completions` | `POST /v1/responses` | `POST /v1beta/models/{m}:generateContent`<br>流式 `:streamGenerateContent?alt=sse` | `POST /v1/messages` |
| **鉴权** | `Authorization: Bearer` | 同左 | `x-goog-api-key` 头（或 `?key=`，会泄进日志） | `x-api-key` + `anthropic-version` 头 |
| **历史容器** | `messages[]` | `input[]`（或裸字符串） | `contents[]` | `messages[]` |
| **模型侧角色名** | `"assistant"` | 无角色，用 item `type` | `"model"` | `"assistant"` |
| **system 放法** | `messages[0].role = "system"`（新模型用 `"developer"`） | 顶层 `instructions` | 顶层 `systemInstruction` | 顶层 `system` |
| **文本载体** | `content` 为字符串或 part 数组 | 输入 `input_text` / 输出 `output_text` | `parts[].text` | `content` 为字符串或 block 数组 |
| **图片载体** | `{type:"image_url", image_url:{url}}` | `{type:"input_image"}` | `{inline_data:{mime_type,data}}` | `{type:"image", source:{type:"base64",media_type,data}}` |
| **工具定义** | `tools[].function.{name,description,parameters}`（**嵌套**） | `tools[].{type,name,description,parameters}`（**扁平**） | `tools[].functionDeclarations[]` | `tools[].{name,description,input_schema}` |
| **工具选择** | `tool_choice` | `tool_choice` | `toolConfig.functionCallingConfig.mode`<br>`AUTO`/`ANY`/`NONE` | `tool_choice.type`<br>`auto`/`any`/`tool`/`none` |
| **模型发起调用** | `assistant.tool_calls[]`（带 `id`） | output item `type:"function_call"`（带 `call_id`） | `parts[].functionCall`（**无 id**） | content block `type:"tool_use"`（带 `id`） |
| **结果回传** | `role:"tool"` + `tool_call_id` | input item `type:"function_call_output"` + `call_id` | `role:"user"` + `parts[].functionResponse`，**靠函数名匹配** | `role:"user"` + block `type:"tool_result"` + `tool_use_id` |
| **流式机制** | 匿名 chunk，客户端**拼接 delta**，`data: [DONE]` 收尾 | **类型化事件** `response.*` | 每个 chunk 是一个**完整响应对象**，parts 累加 | **类型化事件** `message_start` / `content_block_delta` / … |
| **结束信号** | `finish_reason`：`stop`/`length`/`tool_calls`/`content_filter` | `status` + `incomplete_details.reason` | `finishReason`：`STOP`/`MAX_TOKENS`/`SAFETY`/`RECITATION` | `stop_reason`：`end_turn`/`tool_use`/`max_tokens`/`refusal` |
| **输出上限字段** | `max_tokens` → `max_completion_tokens` | `max_output_tokens` | `generationConfig.maxOutputTokens` | `max_tokens`（**必填**，无服务端默认） |
| **usage 字段** | `prompt_tokens` / `completion_tokens` | `input_tokens` / `output_tokens` | `promptTokenCount` / `candidatesTokenCount` / `thoughtsTokenCount` | `input_tokens` / `output_tokens` + `cache_read_input_tokens` / `cache_creation_input_tokens` |
| **缓存计数口径** | cached 是 input 的**子集** | 同左 | 同左 | **三桶不重叠**，需相加才可比 |
| **服务端状态** | 无 | `store` + `previous_response_id` | 无 | 无 |

三处最容易在跨族移植时静默出错的地方：

1. **Gemini 的工具结果没有 id。** 靠函数名回指，所以同一轮里并行调用同一个函数
   两次，结果与调用的对应关系在协议层就是不可表达的。跨族适配时必须自己维护
   一张 `id → name` 表，且要接受这个信息损失。
2. **Anthropic 的 usage 三桶不重叠。** 其余三族的"cached"是 input 的子集，
   Anthropic 的 `input_tokens` 只是未命中缓存的余量。直接读 `input_tokens`
   会在长 prompt + 缓存命中时把输入量少报一个数量级。
3. **Gemini 流式每个 chunk 是完整响应对象**，不是增量。按"拼接 delta"的思路
   处理会重复累加。

## 2. ① OpenAI Chat Completions

**世界观**：一条扁平的消息数组，工具调用是 assistant 消息上的一个旁路字段。
最简单，也因此成了事实标准——几乎所有第三方"兼容 OpenAI"指的都是这一族。

```jsonc
POST /v1/chat/completions
{
  "model": "…",
  "messages": [
    { "role": "system", "content": "…" },
    { "role": "user",   "content": "…" },
    { "role": "assistant", "content": null,
      "tool_calls": [{ "id": "call_1", "type": "function",
                       "function": { "name": "f", "arguments": "{…}" } }] },
    { "role": "tool", "tool_call_id": "call_1", "content": "…" }
  ],
  "tools": [{ "type": "function",
              "function": { "name": "f", "description": "…", "parameters": { /* JSON Schema */ } }}],
  "tool_choice": "auto",
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

流式：SSE，每行 `data:` 是一个匿名 chunk，`choices[0].delta` 携带增量，
**tool_calls 的 `arguments` 按 `index` 分片拼接**，最后 `data: [DONE]`。
usage 只在开了 `stream_options.include_usage` 时随最后一个 chunk 到达——
这个开关是很多兼容层没实现的第一个东西。

族内演化（同端点，不换 shape）：`max_tokens` → `max_completion_tokens`、
`function_call` → `tool_calls`、`role:"system"` → `role:"developer"`、
推理模型加 `reasoning_effort`。旧字段大多仍被接受。

## 3. ② OpenAI Responses

**世界观**：一条**条目（item）流**，而不是消息数组。推理、消息、工具调用是并列的
item 类型；服务端可以替你存住上一轮。

```jsonc
POST /v1/responses
{
  "model": "…",
  "instructions": "…",                 // system 在这里，不在 input 里
  "input": [
    { "role": "user", "content": [{ "type": "input_text", "text": "…" }] },
    { "type": "function_call_output", "call_id": "call_1", "output": "…" }
  ],
  "tools": [{ "type": "function", "name": "f", "parameters": { /* … */ } }],  // 扁平，无 function 包装
  "reasoning": { "effort": "medium", "summary": "auto" },
  "text": { "format": { "type": "json_schema", /* … */ } },
  "max_output_tokens": 4096,
  "store": false,
  "previous_response_id": "resp_…",
  "stream": true
}
```

响应的 `output[]` 是 item 数组，常见类型：`reasoning`（含 `summary[]`，无状态模式下
还有 `encrypted_content`）、`message`（`content[]` 里是 `output_text` 或 `refusal`）、
`function_call`（带 `call_id`）。

流式是**类型化命名事件**（`response.output_text.delta`、
`response.function_call_arguments.delta`、`response.completed` 等），
不需要客户端猜哪个字段是增量——这是它相对 Chat Completions 的主要工程改善，
也是两族无法合并的主要原因。

**有状态**是另一个分水岭：`store: true` + `previous_response_id` 让客户端不必
回传完整历史。代价是历史存在服务端，且这条路径在任何第三方兼容层都不存在。

## 4. ③ Google GenAI

**世界观**：`contents` 是回合数组，每回合由 `parts` 组成；**part 是唯一的内容单位**，
文本、图片、工具调用、工具结果都是 part。生成参数集中在 `generationConfig`。

```jsonc
POST /v1beta/models/{model}:streamGenerateContent?alt=sse
{
  "system_instruction": { "parts": [{ "text": "…" }] },
  "contents": [
    { "role": "user",  "parts": [{ "text": "…" }] },
    { "role": "model", "parts": [{ "functionCall": { "name": "f", "args": {} } }] },
    { "role": "user",  "parts": [{ "functionResponse": { "name": "f", "response": { "content": "…" } } }] }
  ],
  "tools": [{ "functionDeclarations": [{ "name": "f", "description": "…", "parameters": { /* … */ } }] }],
  "toolConfig": { "function_calling_config": { "mode": "AUTO" } },
  "generationConfig": { "maxOutputTokens": 4096, "thinkingConfig": { /* … */ } },
  "safetySettings": [ /* … */ ]
}
```

### 4.1 ③ 族有两套 surface（截至 2026-08）

Google 上线了 **Interactions API**，与经典 `generateContent` 并存：

| | 经典 `generateContent` | Interactions |
| --- | --- | --- |
| 端点 | `/v1beta/models/{m}:generateContent` | `POST /v1beta/interactions` |
| 输入 | `contents[]`（Content + Part） | `input` |
| 输出 | `candidates[0].content.parts[]` | `steps[].content[]` |
| 多轮 | 客户端回传完整历史 | `previous_interaction_id`，**服务端存状态** |
| 结构化输出 | `generationConfig.responseMimeType/Schema` | 顶层 `response_format[]` |
| 流式 | `:streamGenerateContent` | 同端点 + `stream=true` |
| 思考 | 见下 | `generation_config.thinking_level` / `thinking_summaries` |

官方定位：*"The Interactions API is now generally available. We recommend using
this API for access to all the latest features and models."* 但同时明确
**经典 surface 不弃用**：*"While `generateContent` remains fully supported, we
recommend the Interactions API for all new development."*

**这与 ② Responses 对 ① Chat Completions 的关系高度同构**：同一厂商的第二套
接口、结构不兼容、有服务端状态、官方推荐新项目使用、旧的继续支持。按
[`README.md`](README.md) 的分类法，它够格算独立的一族 —— 但本目录暂不拆分，
因为本项目尚未接入，且拆分会让每张对照表多一列空格。**接入时再拆。**

#### 一个实践后果：Gemini 3+ 的思考文档只讲 Interactions

`generateContent` 上如何为 Gemini 3 配置思考，官方文档已经不再给示例。文档
只承认两者不同：*"The Interactions API handles thoughts and signatures
differently than the `generateContent` API"*，并称在 `generateContent` 里
*"there are no dedicated thought blocks"* —— 签名改为附着在 `functionCall`
或最终响应等 part 上。

**所以"经典 surface 上 Gemini 3 的思考长什么样"目前只能靠实测确定**，这是本
目录里少数几处"官方文档给不出答案"的地方之一。

三个别族没有的东西：

- **`safetySettings`** 是请求级的安全阈值，且**默认会拦**。别族的安全策略不可配。
  被拦时可能是 `promptFeedback.blockReason`（请求级）或 `candidates[0].finishReason`
  为 `SAFETY`/`RECITATION`（响应级），后者可能在已经吐出部分文本之后才到。
- **thought signature** —— 思考模型返回的 part 带 `thoughtSignature`，后续回合
  **必须原样回传**，否则多轮工具调用会失效。这意味着适配层不能把 part 归一化成
  自己的结构后丢弃原始对象。
- **模型名在 URL 里**，不在 body 里。换模型换的是路径。

## 5. ④ Anthropic Messages

**世界观**：`content` 是 block 数组，block 有类型（`text` / `image` / `tool_use` /
`tool_result` / `thinking`）。`system` 独立于 `messages`。

```jsonc
POST /v1/messages
Headers: x-api-key: …, anthropic-version: 2023-06-01
{
  "model": "…",
  "max_tokens": 4096,                        // 必填
  "system": "…",                             // 或 block 数组（可挂缓存断点）
  "messages": [
    { "role": "user", "content": "…" },
    { "role": "assistant", "content": [{ "type": "tool_use", "id": "toolu_1", "name": "f", "input": {} }] },
    { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "toolu_1", "content": "…" }] }
  ],
  "tools": [{ "name": "f", "description": "…", "input_schema": { /* JSON Schema */ } }],
  "tool_choice": { "type": "auto" },
  "stream": true
}
```

流式是类型化事件：`message_start` → (`content_block_start` →
`content_block_delta`* → `content_block_stop`)* → `message_delta` → `message_stop`，
delta 类型包括 `text_delta`、`input_json_delta`（工具参数）、`thinking_delta` /
`signature_delta`（思维链）。usage 分两次到：`message_start` 给输入，
`message_delta` 给最终输出。

特有约束：

- **`max_tokens` 必填**且没有服务端默认值。适配层必须自带一个兜底常量。
- **工具结果放在 `role:"user"` 消息里**，不是独立角色。
- **prompt caching 是显式的**：在 system / tools / messages 上打 `cache_control`
  断点。别族的缓存是自动的、不可控的。
- **思维链 block 在工具调用轮必须原样回传**（含 `signature`），与 Gemini 的
  thought signature 是同一类要求。

## 6. 部署变体（body 同族，外壳不同）

| 部署 | 族 | 差异 |
| --- | --- | --- |
| **Azure OpenAI** | ① | `api-key` 头（非 Bearer）、`?api-version=` 查询串、URL 里是 **deployment 名**而非模型名 |
| **Gemini Developer API** | ③ | `x-goog-api-key`，模型名形如 `gemini-…` |
| **Vertex AI (Gemini)** | ③ | OAuth 令牌、区域化域名、路径含 `projects/{p}/locations/{l}/publishers/google/models/…` |
| **Vertex / Bedrock 上的 Claude** | ④ | body 里**没有 `model`**（在路径里），改用 `anthropic_version` 字段；鉴权走各云的体系 |

这一轴的判断方法：**能不能只改 URL 与鉴权头就跑通？** 能，就是部署变体；
不能，就是另一个族。

## 7. 马甲层：谁兼容了谁

事实标准是 ①。以下都提供 Chat Completions 兼容端点：

DeepSeek、xAI (Grok)、Mistral、Moonshot (Kimi)、智谱 GLM、MiniMax、
阿里 DashScope（另有原生格式）、OpenRouter、以及本地栈 Ollama / LM Studio /
vLLM / llama.cpp。Google 与 Anthropic 也各自提供了一层 OpenAI 兼容端点。

**兼容 ≠ 等价。** 实际差异集中在这几处：

| 差异 | 表现 |
| --- | --- |
| **私有扩展字段** | DeepSeek 加 `reasoning_content` + `thinking`；OpenRouter 加 `reasoning`、`provider` 路由与 `reasoning_details`；各家推理字段互不相同 |
| **usage 缺失** | 不认 `stream_options.include_usage`，或返回全零 usage |
| **`/models` 不可信** | 返回空、返回全量目录、或返回该 key 无权访问的模型 |
| **工具调用降级** | 声明支持但实际不返回 `tool_calls`，或 `arguments` 不是合法 JSON |
| **强制 `tool_choice` 被拒** | DeepSeek V4（flash/pro）恒在思考模式，`required` 与具名工具一律 400 `Thinking mode does not support this tool_choice`；请求里**没有任何字段**能提前判断，只能从它自己的 400 学（`src/lib/ai/toolChoice.ts`） |
| **HTTP 200 + SSE 内错误** | 余额不足、上游故障、内容审核以 `data: {"error":…}` 事件送达，而非错误状态码 |
| **静默截断 prompt** | 本地栈（ollama 等）超出上下文时从头部丢弃，system 指令先没 |
| **`<think>` 内联** | 部分中继把思维链混进正文，用 `<think>…</think>` 包裹 |

**结论：对 ① 的适配必须按"最小公倍数发送、最大宽容接收"写。** 官方端点可以
乐观假设可选部分存在，兼容端点不行。

### 一个具体样本：New API（截至 2026-08）

自建中继里最常见的一种，值得记下来作为"兼容层长什么样"的标本。
[它的文档](https://www.newapi.ai/zh/docs/api/ai-model/chat/openai/createchatcompletion)
自称"兼容 OpenAI Chat Completions API"，实测对照下来：

- **body 形状与官方逐字相同**：同为 `POST /v1/chat/completions`、`Bearer` 鉴权、
  同一套字段。**没有任何结构性差异** —— 这正是兼容层的典型形态，也是"兼容层
  不配拥有独立协议族"的理由。
- **它列为"特有扩展"的四项全在响应侧**：`message.reasoning_content`（DeepSeek
  那一份扩展的传播结果）、`completion_tokens_details.reasoning_tokens`、
  以及 `usage` 里的 `audio_tokens` / `image_tokens`。
- **`reasoning_effort` 的取值只写了 `low`/`medium`/`high`** —— 官方枚举里的
  `none`/`minimal`/`xhigh`/`max` 都不在文档中。是中继只描述了公共子集，还是真
  只接受这三个，文档没说。
- **文档缺口**：流式响应格式整节缺失，`tools`/`tool_choice`/`response_format`/
  `stream_options` 的结构都只列了字段名不展开。

这四条合起来就是兼容层的典型知识形态：**结构上照抄，扩展在响应侧，枚举是子集，
而最需要确认的部分文档不写。** 只能实测。

### 另一个样本：MiniMax（截至 2026-08）

同样是 `POST /v1/chat/completions` + Bearer，body 形状与官方一致。但它暴露了
两个**兼容层普遍存在、而官方端点不会有**的行为，值得单独记：

- **思维链默认内联在 `content` 里**，形如
  `<think>…</think>\n\n正式回答`。流式下标签也是从 `delta.content` 分片到达
  的（`<thi` + `nk>` 属于正常情况）。它有 `reasoning_split: true` 可把思考拆到
  `reasoning_content` / `reasoning_details`，但那是私有字段。
  **含义**：任何把 `delta.content` 直接当作正文的消费者，都会把模型的思考过程
  一并收下。
- **失败用 `base_resp.status_code` 报告，HTTP 状态仍是 200。**
  `0` 为成功，`1004` 鉴权失败、`1008` 余额不足、`1002` 限流、`1039` token
  超限。这是"200 + 体内错误"的**第二种拼法**（第一种是 `error` 字段），一个只
  认 `error` 的客户端会把过期密钥读成一次正常的空回复。
- 思考开关是 `thinking: {type: "disabled"|"adaptive"}`（与 DeepSeek、Anthropic
  同形），**没有 `reasoning_effort`**。M2.x 系列的思考无法关闭。
- `max_tokens` 已弃用，改用 `max_completion_tokens`。
- 多模态多一个 `video_url` 内容块类型。

**这两条合起来说明一件事**：兼容层的差异往往不在请求体，而在**响应的解释方式**
——同一段 JSON，官方端点和兼容端点想让你读出不同的东西。

### 第三个样本：兼容层也做 ④ 族（截至 2026-08）

前两个样本（New API 的 OpenAI 格式、MiniMax）都是 ① 族。中继同样会提供
**Anthropic 原生格式**的端点，New API 的
[`POST /v1/messages`](https://www.newapi.ai/zh/docs/api/ai-model/chat/createmessage)
即是。对照官方：

- **鉴权两套都收**：`Authorization: Bearer` 与 `x-api-key` 都接受。这印证了
  ④ 族兼容端点需要一个鉴权方式开关——官方端点只认 `x-api-key`，而生态里
  `ANTHROPIC_AUTH_TOKEN → Bearer` 同样是一等约定，网关文档常常不说自己要哪个。
- **`anthropic-version` 请求头必填**，与官方一致。
- **`usage` 的四个桶齐全**（`input_tokens` / `output_tokens` /
  `cache_creation_input_tokens` / `cache_read_input_tokens`），说明它没有把
  Anthropic 那套"三桶不重叠"的口径压平成 OpenAI 的形状。
- **`thinking` 列在请求体里**，但 **`output_config` 没有** —— 而 4.6+ 的
  `effort` 就住在那里面。
- **`temperature` / `top_p` / `top_k` 被列为可用**，而官方 4.6+ 对这三个的
  非默认值**无条件 400**（与是否思考无关）。
- 响应的 content block 只画了 `{type, text}`：`thinking`、`redacted_thinking`、
  `signature` 一个都没提，流式事件也没写。

### 第四个样本：MiniMax 的 ④ 族端点（截至 2026-08）

同一家厂商**同时提供 ① 与 ④ 两种格式**（`/v1/chat/completions` 与
`/anthropic/v1/messages`），是"协议族与厂商正交"最直白的证据：选哪个族是调用方
的事，不是厂商的属性。

与官方 ④ 的差异：

- **端点带前缀**：`/anthropic/v1/messages`，不是 `/v1/messages`。
- **`anthropic-version` 不要求**（官方必填）。多发一个头无害，少发在官方会挂。
- **鉴权 Bearer 与 `x-api-key` 都收**，与 New API 一致 —— 两个 ④ 族兼容层
  样本都这样，可见这个开关不是个例需求。
- **`thinking: {type: "disabled" | "adaptive"}`**，**默认 `disabled`**。
  官方那边当前代默认开或需显式 adaptive，这里必须显式开才有思考。
  `display` 字段没有出现在文档里。
- **`tool_choice` 只有 `auto` / `none`** —— **没有 `any`，也没有 `tool`**。
  这是与官方差距最大的一条：**强制单个工具在这里做不到**，任何依赖
  forced tool 的结构化输出都得有退路。
- **没有 `output_config`**，所以 effort 无处安放（与 New API 相同）。
- **thinking block 带 `signature`，且文档明确"多轮续写必需"** —— 回传规则与
  官方一致，这一点是兼容的。
- usage 四个桶齐全；流式事件名与官方一致，多一个 `ping` 心跳。
- 扩展：`service_tier`（priority 1.5 倍价）、`metadata.user_id`、`system` 接受
  带 `cache_control` 的数组。
- **有服务端工具**（`web_search`），且**只在 ④ 族端点上有** —— 同一家的 ①
  族端点没有。见下。

#### 服务端工具：④ 族独有的一类"工具"

MiniMax 在 ④ 族端点上实现了 Anthropic 的**服务端工具**约定（beta）。它与普通
工具调用是两件事，混起来会写出一个永远配不上对的循环：

```jsonc
// 声明 —— 没有 input_schema，因为参数不是调用方定义的
"tools": [{ "type": "web_search_20250305", "name": "web_search" }]
```

- **类型带日期版本号**（`web_search_20250305`），与官方的服务端工具命名一致。
- **模型调用、服务端执行、结果直接进同一次响应**：`content` 里按执行顺序出现
  `text` → `server_tool_use`（`{id, name, input.query}`）→
  `web_search_tool_result`（`{tool_use_id, content:[{title, url, page_age,
  content}]}`）→ `text`。
- **调用方无事可做**：没有 `tool_result` 要回传，也没有"拒绝执行"这一步 ——
  请求发出去时权限就给出去了。相应地，**`server_tool_use` 不能当成普通
  `tool_use` 处理**：给它回一条 `tool_result` 是对一次已完成的调用回话。
- `tool_choice` 与它无关（那个枚举管的是调用方声明的工具）。
- 代价是延迟：一次请求里含一次真实检索。

**实测（2026-08-14）：它的服务端循环少跑一步。** 官方端点在一次请求内部跑完
「搜索 → 结果 → 模型接着写」；MiniMax 把结果送回来之后**不再叫一次模型**，直接
`stop_reason: "end_turn"` 收工 —— 响应的最后一个 content block 就是
`web_search_tool_result`，模型只留下搜索前那句开场白。八次搜索、输入 123k、
输出 784 token（几乎全在思考与查询上），而**响应是一个格式完好的成功**，没有
任何字段说少了东西。

**这是"服务端工具"这一类最值得记的一条：一次请求里可能装不下一个完整回答，
而"装不下"有两种说法**，只有一种是明说的：

| | 谁会发 | 怎么发现 |
| --- | --- | --- |
| `stop_reason: "pause_turn"` | 官方 ④ 族 | 明说，读 stop_reason 即可 |
| 停在 `*_tool_result` 上、报 `end_turn` | MiniMax（实测） | **无信号**，只能看"结果之后模型还说话了吗" |

两者都需要同一趟往返：把未完成的 assistant turn 送回去再发一次。**但 MiniMax
不收自己发出来的块** —— 原样回传得到
`400 invalid params, tool result's tool id(call_019ffefc…) not found`，那个 id
正是它上一次响应里自己生成的。协议规定的续跑方式，恰好是它唯一不接受的形状；
可移植的兜底是把结果渲染成纯文本当普通消息送回（见 [`tools.md`](tools.md) §6.1）。

**这是"兼容层"最值得记的一个样本**：它把响应侧抄全了，请求侧没抄 —— 于是同一
个数据结构，它发得出来、收不回去。

> ①/③ 族没有对应物 —— 它们的"联网"要么是厂商在模型侧内置、调用方看不见，要么
> 得自己实现一个工具。**服务端工具是 ④ 族形状**，这也是"选哪个族"会改变能力
> 清单的少数几个地方之一。

**最值得记住的一条**：④ 族兼容层可能**砍掉 `tool_choice` 的强制档**。官方的
`any` / `tool` 是结构化输出最可靠的手段（见
[`structured.md`](structured.md) §1），而这里没有 —— 于是"强制工具调用失败就
退回 JSON 模式"从一个防御性设计变成了必需品。

### 第五个样本：New API 的 ③ 族端点（截至 2026-08）

路径与官方一致（`/v1beta/models/{m}:generateContent`、
`:streamGenerateContent?alt=sse`），body 结构照抄。两处差异都会**静默失败**：

- **鉴权用 `Authorization: Bearer`，不是 `x-goog-api-key`。** 这是 401 ——
  唯一一个会响的。但它同时打到聊天、模型列表、能力探测与图像四条路径，
  只改一处会得到"能聊天但拉不到模型列表"这种难懂的半残状态。
- **文档只写 camelCase**（`inlineData` / `mimeType`）。Google 自己两种都收
  （proto3 JSON 允许），中继未必。**而未识别的键是被忽略而不是被拒绝的** ——
  发 `inline_data` 的后果不是报错，是图片压根没到模型那里。

第二条是本目录里"静默失败"的最纯粹形态：请求成功、响应正常、模型只是看不见
你发的图。

**由此得出一条可移植的规则：面向兼容层时，在"官方两种都收"的地方要选中继
文档写的那一种。** 官方的宽容不是中继的宽容。

### 第六个样本：阿里千问AI平台（百炼 / DashScope）（截至 2026-09-03，① ④ 两族已实测）

一个 host（`dashscope.aliyuncs.com`）、一把 key，挂着**四种**接口面：

| 面 | 路径 | 本项目 |
| --- | --- | --- |
| ① Chat Completions | `/compatible-mode/v1/chat/completions` | `openai_compat`，预设「通义千问 (DashScope)」 |
| ② Responses | `/compatible-mode/v1/responses`（另有 `GET/DELETE …/{id}`、`GET …/{id}/input_items`） | 未接（见 [`qianwen-compat-plan.md`](qianwen-compat-plan.md) §4） |
| ④ Anthropic Messages | `/apps/anthropic/v1/messages` | `anthropic_compat` 可直接用，尚无预设 |
| DashScope 原生 | `/api/v1/services/aigc/{text,multimodal}-generation/generation` | 只用于出图（见下一小节） |

目录只有 ① 面有：`GET /compatible-mode/v1/models` 返回 OpenAI 形态、249 条（2026-09-03），
同一模型常有 `kimi-k3` / `kimi/kimi-k3`、`glm-5.2` / `ZHIPU/GLM-5.2` 两种 id——不带前缀的是
「阿里云直供」，带前缀的是第三方直供，二者参数支持面不同。国际部署
`dashscope-intl.aliyuncs.com` 是独立 host 与 key。

实测方法：用仓库里的真实 adapter（`streamOpenAI` / `streamAnthropic` / `streamCompletion` /
`testProviderConnection`）跑 `src/lib/__tests__/live.qianwen.test.ts`（设 `QIANWEN_KEY`
才运行），外加 curl 矩阵。模型：qwen3.8-flash、qwen3.7-flash、deepseek-v4-pro-0813、
kimi-k3、glm-5.2、MiniMax-M2.5、qwen3-vl-plus。

#### ① 面：本项目现有 adapter 逐字节可用

- **流式形状与 DeepSeek 同名**：思维链在 `delta.reasoning_content`，首块带
  `role`+空 `content`+空 `reasoning_content`，usage 在末块（`stream_options.include_usage`
  被尊重），`completion_tokens_details.reasoning_tokens` 有值。7 个模型全部如此，
  `REASONING_CONTENT_FIELDS` 无需新增。
- **默认思考按模型分裂**：除 qwen3-vl-plus 外 6 个模型**默认开**。这和文档里
  「商业款默认关」的旧说法相反——3.7/3.8 代全部默认开。
- **关闭思考有三种拼法，都被认**：`enable_thinking:false`、`reasoning_effort:"none"`、
  以及**文档没写的顶层 `thinking:{type:"disabled"}`**（DeepSeek 拼法）。三种在 6 个
  思考模型上都生效。例外 **MiniMax-M2.5：任何一种都 400**
  （`The value of the enable_thinking parameter is restricted to True`）。
- **`thinking_budget`**：kimi-k3 直接 400（`Parameter thinking_budget is not supported`），
  两个面都是；其余模型接受。
- **`reasoning_effort` 只有 3.8 代真的分档**（low/medium/xhigh）；3.7-flash 接受但
  无视（low 仍思考 1000+ 字）。DeepSeek/GLM/Kimi 认 `high`/`max`，其余值被折叠。
- **GLM 档的固定片段 `thinking:{clear_thinking:false}` 在非 GLM 模型上 400**
  （`'type' must be in thinking`）——这个端点把顶层 `thinking` 解析成 DeepSeek 形状，
  缺 `type` 就拒；glm-5.2 与 kimi-k3 接受（大概率忽略）。千问自己的 `clear_thinking`
  是顶层布尔，不在 `thinking` 里。
- **思考中强制 `tool_choice`**：qwen3.8-flash 与 MiniMax-M2.5 400
  （`The tool_choice parameter does not support being set to required or object in thinking mode`），
  **其余 5 个接受**——文档说的「思考模式不支持强制」并非全端点常态。报文含
  `tool_choice` 字样，`streamCompletion` 的一次性重试（`lib/ai/toolChoice.ts`）能接住，
  7 个模型的 forced 请求最终都拿到了工具调用。并行工具调用**默认就发生**
  （不发 `parallel_tool_calls` 也回两个调用），与文档「默认关」不符。
- **工具轮回传 `reasoning_content`**：带与不带都 200，6 个思考模型均如此——这里
  没有 DeepSeek 官方那种 400。
- **结构化输出**：`json_object` 与 `json_schema`（strict 与否）在 Qwen / DeepSeek /
  Kimi / GLM 上都出合法 JSON，思考开着也照常分流。`json_object` 缺 "json" 字样的
  400 只有 **Qwen 与 DeepSeek** 执行，Kimi / GLM / MiniMax 不检查。
  **MiniMax-M2.5 对 `response_format` 基本无视**：同一请求两次分别回了带 ```` ```json ````
  围栏的 JSON 和纯散文，只靠 prompt 里的 JSON 字样约束。
- **图片**：`image_url` 收 `data:` URL；qwen3.8/3.7-flash、qwen3-vl-plus、kimi-k3 看得见；
  deepseek 与 glm **不报错但无视图片**（答错颜色）；MiniMax 回「看不到图片」。
  **小于 10px 的图 400**（`height:1 or width:1 must be larger than 10`）。
- **错误信封是 OpenAI 形状**（`{error:{message,type,code}}` + 顶层 `request_id`），
  探测模型 404 + `model_not_found`，坏 key 401，与连接测试的判据一致。
- **`max_tokens` 的含义随模型不同**：DeepSeek V4 与 qwen3.8-max 上是正文+思维链之和，
  glm-5.2 上取决于有没有发 `thinking_budget`，其余模型只算正文；`max_completion_tokens`
  一律含思维链。本项目 ① 面不发上限，暂不受影响。

#### ④ 面：`/apps/anthropic`，本项目 `anthropic_compat` 直接可用

- **Base 是根地址** `https://dashscope.aliyuncs.com/apps/anthropic`（客户端补 `/v1/messages`），
  正是 `anthropicUrl` 的约定。`x-api-key` 与 `Authorization: Bearer` 都收，
  `anthropic-version` 可省。**没有 `/v1/models`**（404，文档明说），连接测试靠
  `probeCompletionEndpoint` 降级：假模型名答 400 + `{"code":"InvalidParameter","message":…,"request_id":…}`
  ——**不是 Anthropic 的 `{type:"error",error:{…}}` 信封**，`apiErrorMessage` 的裸
  `message` 分支接住了它。坏 key 是 **403** `{"message":"invalid api-key","type":"authentication_error"}`。
  流式错误走 `event:error` + 同样的裸 `{code,message}`。
- **本项目发出的每种 `thinking` 形状都被接受**：`{type:"adaptive",display:"summarized"}`
  （默认 `claude-adaptive` 档，文档枚举只有 enabled/disabled）、`{type:"enabled",budget_tokens}`
  （kimi-k3 除外，400）、`{type:"disabled"}`（MiniMax-M2.5 除外，400）。`output_config.effort`
  接受 low…max。**`budget_tokens` 必须小于 `max_tokens`**（报文写的是
  `max_completion_tokens [N] must be greater than thinking_budget [M]`），与官方规则同向。
- **thinking block 的 `signature` 恒为空串**；工具轮把上一轮 `content` 原样带回（含空签名
  的 thinking block）或删掉 thinking block，两种都 200。关掉思考时响应里仍有一个
  `{type:"thinking",thinking:"",signature:""}` 空块，adapter 已能容忍。
- **事件序列**：`ping` 先于 `message_start`；`message_start.usage` 只有两个字段，完整
  usage（含 `cache_*`，另塞了一个非标准的 `prompt_tokens_details`）在 `message_delta`。
- **强制 `tool_choice`**：`{type:"tool"}` 在 qwen3.8-flash 与 MiniMax-M2.5 思考中 400，
  `{type:"any"}` MiniMax 接受、qwen3.8-flash 仍拒；glm-5.2 都接受。报文同样含
  `tool_choice`，重试逻辑通用。
- **`output_config.format`（json_schema）**：Qwen / DeepSeek / Kimi 出 JSON，
  MiniMax 出散文。本项目 ④ 族的结构化输出仍走强制工具，不用它。
- **温度范围是 [0, 2)**，与 Anthropic 官方的 [0, 1] 不同；本项目 clamp 到 1，只是少了半段。

#### ② 面：Responses（只探了一次，未接）

`POST /compatible-mode/v1/responses` 对 qwen3.8-flash 可用：`output[]` 里是
`reasoning`（`summary[{type:"summary_text",text}]`）+ `message`（`content[{type:"output_text"}]`），
`reasoning.effort` 有 7 档。**MiniMax-M2.5 上 400（`<500> InternalError.Algo: 'agent_api_metadata'`）**
——文档的支持面只列 Qwen / DeepSeek / GLM / Kimi。文档没有 `text.format`（无结构化输出），
不支持 `background`，流式事件表里**没有 `response.function_call_arguments.delta`**
（参数可能整块到达），有 `response.reasoning_text.delta`。接入评估见
[`qianwen-compat-plan.md`](qianwen-compat-plan.md) §4。

#### 文档与实测不符之处（截至 2026-09-03）

| 文档说 | 实测 |
| --- | --- |
| kimi-k3 `enable_thinking` 只能 `true` | `false` 与 `reasoning_effort:"none"` 都关得掉 |
| `parallel_tool_calls` 默认 `false` | 不发也并行回两个调用 |
| 思考模式不支持强制 `tool_choice` | 只有 qwen3.8-flash、MiniMax-M2.5 拒；其余 5 个接受 |
| ④ 面 `thinking.type` 只有 enabled/disabled | `adaptive`（含 `display`）被接受 |
| `json_object` 要求 "json" 字样 | 只有 Qwen / DeepSeek 执行 |
| 3.7 代接受 `reasoning_effort` | 接受但无视，只认 `thinking_budget` |

工具调用与随请求跑的能力（2026-08-17 补，**未实测**部分）：

- **服务端联网搜索是顶层 `enable_search: true`**（可选 `search_options` 配
  `search_strategy: turbo|max|agent|agent_max` 等）。关键限制文档明载：
  **Chat Completions 模式不返回搜索来源、不支持角标引用**——搜索对客户端完全
  不可见，答案直接吸收检索结果；来源与引用只在 DashScope 原生和 Responses API
  上有。按次计费（turbo ¥0.003/千次，max/agent ¥0.004/千次），叠加正常 token 费。
- **PDF 理解仅 qwen3.8-max**：用户消息 content 里放
  `{type:"file", file:{file_url:"https://…"}}` 或
  `{type:"file", file:{file_data:"data:application/pdf;base64,…", filename:"…"}}`
  （base64 形态**必须带 `filename`**）。单文件 ≤150MB / ≤500 页，首响应可达
  300s；计费两段：抽取出的文本图片按输入 token + 处理费 ¥0.02/页。
  Responses API 暂不支持该能力。file 内容块与 ① 族官方（gpt-4o/4.1 的 PDF
  输入）同形，是镜像而非私有发明。
- **`preserve_thinking`**（qwen3.8-max 默认开）要求把历史 `reasoning_content`
  **完整**回传；本项目只在工具轮回传上一轮的思维链，纯对话轮不回传——3.8-max
  上是否因此报错未验。

#### DashScope 的图片模型：不在兼容层上，走原生协议（截至 2026-08，未实测）

qwen-image / wan / z-image 系列**不经过** `compatible-mode` —— 出图走原生
`/api/v1`（同 host、同 key，只是路径不同；本项目在 `lib/ai/image.ts` 的
`dashscope` route 里从兼容层 base 推导原生 base）：

- **同步**（qwen-image-3.0\*、qwen-image-edit\*、z-image-turbo、wan 改图）：
  `POST /api/v1/services/aigc/multimodal-generation/generation`。
- **异步**（wan2.7-image\* 文生图只有这条）：
  `POST /api/v1/services/aigc/image-generation/generation` + 请求头
  `X-DashScope-Async: enable`，返回 `output.task_id`；轮询
  `GET /api/v1/tasks/{id}`，`task_status: PENDING/RUNNING → SUCCEEDED/FAILED`，
  官方建议 ~3s 间隔。
- **body 两段式**：`input.messages[].content` 是 `{image}`/`{text}` part 数组
  （改图 = image part 在前、指令 text 在后；image 收公网 URL 或
  `data:<mime>;base64,…`），旋钮全在 `parameters`（`n`、`size` 写作
  `宽*高`、`negative_prompt`（wan2.7 不支持）、`seed`、`watermark`、
  `prompt_extend`；wan 专属 `enable_sequential` / `color_palette` /
  `bbox_list`，`size` 另收 `"1K"/"2K"/"4K"`）。
- **响应**：`output.choices[0].message.content[]` 里 `{image:"<URL>"}`（wan
  任务另见 `output.results[].url` 形状），`usage` 报张数与像素而非 token。
  **图片 URL 24 小时过期**——必须当场下载落盘。
- **错误是顶层 `{code, message}`**（任务失败时嵌在 `output` 里）：
  `Throttling`（429）、`DataInspectionFailed`（内容审核拒绝——是"理解了但
  拒绝"，不是"端点不存在"，不能触发降级重生成）。

#### 出图参数的三套方言（2026-08 对官方文档校准）

同一件事——"这张图多大、什么画幅"——各家族用完全不同的参数说：

- **Gemini 图像系（Nano Banana）**：`generationConfig.imageConfig` 里
  `aspectRatio` ∈ `1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9`（十档），
  `imageSize` ∈ `"1K"/"2K"/"4K"`（**必须大写 K**；gemini-2.5-flash-image 没有
  该参数，只有 1024px 一档——省略即人人都收）。没有像素尺寸参数。
- **OpenAI GPT-Image 系（gpt-image-1 / 1-mini / 1.5 / 2）**：
  `/images/generations` 收 `size` ∈ `1024x1024 / 1536x1024 / 1024x1536 / auto`，
  **gpt-image-2 额外接受任意 `宽x高`**——两边都要被 16 整除、比例限
  1:3~3:1、上限 3840x2160（2560x1440 以上官方标注 experimental）；
  `quality` ∈ `low/medium/high/auto`（价差极大：1024² 约 $0.006 / $0.053 /
  $0.211）；另有 `output_format`（png/jpeg/webp）、`output_compression`、
  `background`（transparent/opaque/auto）、`moderation`（low/auto）。
  **不收 `response_format`**（恒返回 b64）。`/images/edits` 文档只列预设
  size（auto + 三档），编辑另收 `input_fidelity` ∈ `high/low`。
- **万相 Wan 2.7（DashScope 原生）**：`parameters.size` 收正方形简写
  `"1K"/"2K"/"4K"`（1024²/2048²/4096²）或自定义 `宽*高`，边长限 768~4096
  （`wan2.7-image` 只到 2K，`-pro` 到 4K），**省略时默认 2K**；
  **`n` 默认 4（！）**——不显式发 n 就出四张收四张的钱，1~4 张
  （enable_sequential 时 1~12）；2.7 **不支持 `negative_prompt` /
  `prompt_extend`**（2.6 支持）。**改图**（输入图 0~9 张、≤20MB、比例
  1:8~8:1）的 size 只收 `1K`/`2K` 或 [768*768, 2048*2048] 内的宽高，
  且**输出画幅跟随最后一张输入图**——改图发档位而不是算出的 `宽*高`。
  同步/异步两个端点都在（wan2.7 文生图两者皆可，与 PR5 时"文生图仅异步"
  的口径已不同）。

本项目把这几套各自封成一个「参数方言」（`lib/ai/imageDialects.ts`，
`ImageCaps.dialect` 声明），UI 按方言给出画幅/分辨率/质量选项，请求侧由
方言算出该端点真正认识的字段。

### 第七个样本：OrcaRouter，一台主机上的三个族（截至 2026-09，探测与免费档已实测）

[OrcaRouter](https://docs.orcarouter.ai/zh/introduction) 是与 New API 同类的
中继，但它把 ①③④ 三族**都**挂在同一个主机、同一把 key、同一份目录上：

| 族 | 端点 | 文档 |
| --- | --- | --- |
| ① | `POST https://api.orcarouter.ai/v1/chat/completions`（另有 `/v1/responses`） | [openai-compat](https://docs.orcarouter.ai/zh/native-formats/openai-compat) |
| ④ | `POST https://api.orcarouter.ai/v1/messages` | [anthropic](https://docs.orcarouter.ai/zh/native-formats/anthropic) |
| ③ | `POST https://api.orcarouter.ai/v1beta/models/{model}:generateContent` / `:streamGenerateContent` | [gemini](https://docs.orcarouter.ai/zh/native-formats/gemini) |

对照本目录已有的样本，它的知识形态如下：

- **body 三族都自称与官方逐字相同**，① 族是翻译层（任何模型都能从这里
  调，跨族的请求由它翻成上游原生形态），③④ 是"直接透传"。这印证了
  New API 一节的结论——兼容层不配拥有独立协议族——所以本项目**没有新增
  `ApiStandard`**，只在 `PROVIDER_PRESETS` 加了三行（一族一行，与 MiniMax
  相同）。
- **鉴权统一 `Authorization: Bearer sk-orca-…`**，密钥页说"所有端点、所有 SDK"
  都用这一种。`x-api-key` 只承诺在 Anthropic 形态的路径上识别、
  `x-goog-api-key` 与 `?key=` 只承诺在 `/v1beta/…` 上识别——而 `/v1/models`
  两者都不是。按第五个样本得出的规则（官方两种都收的地方选中继写的那种），
  ③④ 两行 preset 的 `authMode` 都是 `bearer`；① 族本来就是 Bearer。
- **模型 id 带厂商前缀**（`openai/gpt-4o-mini`、`anthropic/claude-sonnet-4.6`、
  `google/gemini-2.5-flash`、`deepseek/…`、`grok/…`、`qwen/…`、`kimi/…`、
  `minimax/…`、`z-ai/…`），裸名只在管理员配了别名时才可能有。`normalizeModelId`
  剥前缀之后，输出上限表与 strict json_schema 名单照常命中。③ 族的路径因此
  是 `/v1beta/models/google/gemini-2.5-flash:…`——id 里的斜杠**原样进路径**，
  与它文档的 curl 一致，`geminiUrl` 不做编码。
- **一份目录，三种形态，按鉴权头挑（实测）。** `GET /v1/models` 带 Bearer
  返回 OpenAI 形态（191 条，每条带 `supported_endpoint_types`，如 Claude 是
  `["openai","anthropic"]`、GPT 只有 `["openai","openai-response"]`），带
  `x-api-key` 返回 **Anthropic 形态**（`display_name` / `created_at` /
  `has_more`，**没有** `supported_endpoint_types`）；`?limit=1` 被忽略。
  `GET /v1beta/models` **存在**——文档说 `generateContent` 之外的操作"目前不
  通过本接口路由"，已过时——返回 Gemini 形态、同样 191 条、`name` 不带
  `models/` 前缀、150 条带 `inputTokenLimit`/`outputTokenLimit`（Claude 全系
  1M / 64K–128K），Bearer 与 `x-goog-api-key` 都收；但单条
  `/v1beta/models/{id}` 404 `Invalid URL`。`/v1/models/{id}`（OpenAI 形态）
  带 `context_length` / `max_completion_tokens` / `architecture` / `pricing`，
  与 OpenRouter 同形，本项目的能力探测 Step-0 本来就读这两个键。
  `fetchRemoteModels` 的 ④ 分支据 `supported_endpoint_types` 把不在本面上的
  模型滤掉（缺省即保留），所以 Claude 格式那行**只在 `bearer` 模式下**拿到
  过滤后的 20 条——这也是 preset 选 Bearer 的又一个理由。
- **思考强度在 ① 族有统一语法**：`reasoning_effort`（`low`/`medium`/`high`，
  部分模型多 `minimal`/`max`）或模型名后缀 `-high`，网关翻成各家原生字段
  （Claude → `thinking.budget_tokens` 1280/2048/4096，`claude-opus-4.6` →
  adaptive + `output_config.effort`；Gemini → `thinkingConfig`）。思维链在上游
  给 `reasoning_content` 时透出到 chat-completion 响应上，与 DeepSeek 同名。
- **结构化输出**：① 族 `json_object` 与 `json_schema` 都接（Gemini 翻成
  `responseMimeType` + `responseSchema`，DeepSeek 的 `json_schema` 标为"请核对"），
  Anthropic 模型两者都 ❌——与本项目 `resolveStructuredOutput` 对 ④ 族恒为
  `off` 的处理一致，但注意这里是**① 族端点上的 Claude 模型**也不接，网关不
  会替它翻成 tool_use。
- **图片输入**：`image_url` 的 base64 data URL 只保证对 OpenAI 与 Gemini 目标
  有效，**Claude 与 Grok 建议改用 https 托管图或原生格式**。本项目发的全部是
  data URL，所以给 Claude 看图要走 Claude 格式那行——这是三行 preset 里
  ④ 那行存在的最实际的理由。
- **图片生成分两条路**，与 New API 相同：`/v1/images/generations` 收
  gpt-image / Imagen / Grok Imagine，`/v1/images/edits` 只写了 `gpt-image-2`；
  Gemini 的 image 系列（`google/gemini-2.5-flash-image` 等）**只能**走
  `/v1/chat/completions`，回包形态文档自己都写"data URL 或 inline_data 块，
  取决于 SDK"——需要实测再定 `ImageCaps.route`。
- **服务端联网搜索**：① 族上 `web_search_options` 对 OpenAI search-preview
  与 Claude 模型有效（后者翻成 Anthropic 的 `web_search` 服务端工具），Gemini
  靠一个**保留函数名** `googleSearch`（还有 `codeExecution` / `urlContext`）
  ——发一个没有 parameters 的 function 工具，网关换成原生内置工具。这三种都
  是 `serverTools.ts` 那一类"端点自己跑、本地无事可做"的工具，目前**没有接**。
- **错误信封是 OpenAI 形态**（`error.{message,type,code}`），`type` 区分网关
  自身（`orcarouter_api_error`）与上游透传（`upstream_error` / `claude_error` /
  `gemini_error`）。**流中错误**：① 族是 `data: {"error":…}` 后接 `[DONE]`，
  ④ 族是 `event: error`——两种拼法本项目的 adapter 都已处理。403 有五种
  互不相同的原因（周期花费上限 / 余额 / 单 key 额度 / 模型不在白名单 / 免费档
  耗尽），文档建议按 `error.code` 加消息前缀匹配，消息会本地化。
- **每个响应带 `X-Orca-Request-Id`**，回退链触发时另有 `X-Orca-Fallback-*`。
  它刻意**不**暴露哪家上游承接了请求。

**实测记录（2026-09-03，作者的 key，账户余额为零）：**

- **§5 的降级探测三面全过**：`__connection_probe__` 在 `/v1/chat/completions`、
  `/v1/messages`（Bearer 与 `x-api-key` 都行）、`/v1beta/…:generateContent`
  上一律 **404 + `{"error":{"code":"model_not_found","message":…}}`**，
  `apiErrorMessage` 读得出来，连接测试判为连通。坏 key 是 401。
- **402 是余额闸**（文档的状态码表里没有）：账户没钱时任何真实模型的任何
  一面都先答 `402 {"error":{"code":"insufficient_user_quota","message":"You're
  out of credits — this request needs $0.000074…"}}`，先于模型解析。它带完整
  的 JSON error，按 §5 原来的规则会被判成"连通、模型被拒"——于是
  `probeCompletionEndpoint` 现在把 402 单独报成失败并原样转出那句话。
- **免费档三个模型在 `/v1/chat/completions` 上真实出流**
  （`deepseek/deepseek-v4-flash-free` 1M 上下文 / 384K 输出、
  `qwen/qwen3.8-27b-free` 64K、`tencent/hy3-free` 262K；限流时 429，用量不扣
  钱包）：思维链走 `delta.reasoning_content`（DeepSeek 与混元先出一段再出
  正文），usage 在 `[DONE]` 前的末块、`completion_tokens_details.reasoning_tokens`
  在；Qwen 由 vLLM 直接托管（`system_fingerprint: vllm-0.27.1`），usage 是一个
  `choices: []` 的独立块——都是 ① 族 adapter 已经认识的形状。它们在目录里
  `supported_endpoint_types` 为 **null**。这三条现在是 OrcaRouter preset 的
  **starter models**：保存新供应商时顺带建行。
- **跨面翻译是真的**：DeepSeek 免费模型打 `/v1/messages` 回来的是完整的
  Anthropic message，**含 `thinking` block**（`signature` 就是 message id）；
  Qwen 免费模型打 `/v1beta/…:generateContent` 回 Gemini 形态（40 个 token
  全被思考吃掉，`parts: []` + `MAX_TOKENS`，`thoughtsTokenCount` 报 0）。
  付费的 GPT 打 `/v1beta` 与 `/v1/messages` 都走到了余额闸并**算出了价格**，
  说明路由已接受——`supported_endpoint_types` 看起来是建议而非硬限制，但没
  有余额无法确证。
- **未测**：付费模型的任何生成（含 Claude 原生的 thinking / `output_config`、
  Gemini 原生的 `thinkingConfig`）、工具调用流、`web_search_options`、
  Gemini image 系列在 chat 上的回包形态。

### 兼容层文档的通用规律（七个样本的共同点）

1. **结构照抄，扩展在响应侧。**
2. **枚举是子集**（reasoning_effort 只写三档、content block 只写 text）。
3. **最需要确认的部分不写**（流式格式、错误通道、回传规则）。
4. **文档滞后于上游。** ④ 族尤其明显——Anthropic 的接口面近年动得快
   （adaptive thinking、`output_config`、采样参数从"思考时禁用"变成"无条件
   禁用"），中继文档描述的往往是一年前的样子。

**推论：不能把兼容层文档当作能力清单。** "没列"既可能是不支持，也可能只是
没跟上；两种都要按"未知、需实测"处理，而不是按"确认缺失"。
## 8. 仍存活的自有格式（不主流，但会撞上）

- **Ollama `/api/chat`** —— 自有 shape（`messages` + `options`），与它的
  OpenAI 兼容层并存。原生接口能拿到 `num_ctx` 之类的本地参数。
- **Cohere `/v2/chat`** —— 自有 shape。
- **阿里 DashScope 原生** —— `input.messages` + `parameters` 两段式。
- **AWS Bedrock Converse `POST /model/{id}/converse`** —— 实际上是第五种独立
  body：`system` 是独立数组、content 恒为 block 数组、camelCase 命名、
  `inferenceConfig` / `toolConfig` 分组、`additionalModelRequestFields` 兜住厂商
  私有参数、usage 为 `inputTokens`/`outputTokens`/`cacheReadInputTokens`。
  设计意图与 OpenAI 兼容层相同（一次对接跑所有模型），但需要 SigV4 签名，
  在纯前端环境里成本高。**本目录不展开。**
