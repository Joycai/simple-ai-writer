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
| **图片细节档** | `image_url.detail`（**在对象里**） | `detail`（**与 image_url 平级**） | 无 | 无 |
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

`detail` 只有 ① ② 两族有，且**位置不同**：① 是 `image_url` 对象的成员，
② 是 `input_image` 的兄弟字段。取值 OpenAI 与 DeepSeek 都认 `low`（端点先缩到
512×512）/ `high` / `auto`；DeepSeek 另有 `original`，但它自己的表里写明
`high` 等价于 `original`，所以本项目只发 low/high 两个值就够覆盖。**不发这个
字段与发 `auto` 是同一个请求**，因此 `lib/ai/imagePart.ts` 的默认是不发——没碰
过设置的作者，请求与这个字段存在之前逐字节相同。

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

### 2.1 DeepSeek 的图片理解（官方直连，2026-09-17 三族已实测）

记在这里而不是马甲层：DeepSeek 是官方端点，且它的图片面**没有任何私有扩展**
——本项目发出去的 part 一个字都不用改。实测由
`src/lib/ai/__tests__/live.deepseek-vision.test.ts` 钉住（`DEEPSEEK_KEY`，走本项目
自己的适配器，① / ② / ④ 三族各一遍）。

- **模型**：`/models` 只列 `deepseek-flash`（DeepSeek-V4.1-Flash）和
  `deepseek-v4-pro`，只有前者看得见图。旧的 `deepseek-v4-flash-vision-exp` 已下线。
  **`deepseek-v4-pro` 带图不报错**：200 返回，图被静默丢掉（`prompt_tokens` 29，
  同一请求 flash 是 208），回答是瞎猜——实测给青色图答过 "Skyblue"、"Unable to
  determine."、"NOIMAGE"。所以作者把它的类型设成「多模态」时，app 这边什么都拦不住，
  也看不到错误；类型是作者声明的，这一条只能靠文档。
- **三种传法**，都是标准 ① 族 block 数组：base64 `data:` URL、公网 http(s)
  URL、Files API 的 `file_id`。本项目只用第一种。
- **`detail` 可选**：`low`（推理前缩到 512×512）/ `high` / `original` / `auto`
  （当前等价 `original`）。本项目经 `lib/ai/imagePart.ts` 只发 `low` / `high`
  （`high` 在 DeepSeek 表里与 `original` 等价），作者不设置就一个字段都不发。
  实测四个值都收；2000×2000 的图 `low` 计 197 token，不发 / `high` 计 1007。
- **硬约束：图片只能出现在 `user` 消息里**，`system` / `assistant` 带图 400。
  实测报错原文 `Image in system message is unsupported`。本项目天然满足——
  `lib/agent/imageHistory.ts` 的 `ImageMessage` 把 `role: "user"` 写进了类型，工具返回的图也是另起一条 user 消息
  （`lib/agent/runtime.ts`）。
- **限额**：格式 JPEG/PNG/GIF/WebP（按字节判定，不看文件名）；单图 32 MiB
  （Files API 64 MiB）、请求体 48 MiB、单请求最多 600 张、单边最长 8192px
  （≥15 张时降到 4096px）。**实测 8192 收、8193 拒**（宽、高两个方向都是），
  但拒绝的报错说的是格式：`You have uploaded an unsupported image. Please make
  sure your image is valid and has one of the following formats: webp, png,
  jpeg, and gif.`——撞上它的作者会以为是格式问题，这是 `MAX_IMAGE_EDGE` 在作者关掉
  缩放时也要守住的又一个理由。**没有下限**：9×9 照收（千问要 >10，第六个样本），
  `MIN_IMAGE_EDGE` 的放大对这里无害。`data:` 头里写错 MIME（PNG 标成 jpeg）也照收，
  与"按字节判定"一致。本项目对应的三道闸：单图 12 MiB（`MAX_IMAGE_BYTES`）；
  长边默认 4096、设置项上限 8192，作者关掉缩放时也仍按 8192 缩
  （`MAX_IMAGE_EDGE`，image-normalize-plan.md §2.2）；**一次请求的图片合计
  ≤ 24 MiB**（按 data URL 字符数计，`MAX_REQUEST_IMAGE_CHARS`，§2.9）——这一道是
  为 Anthropic 的 32 MB 请求上限定的，DeepSeek 的 48 MiB 顺带满足。单请求张数
  到不了 15（对话每条 5 张（2026-09-23 前是 4）、历史留 3 条、看图子代理 8 张，且都先撞上合计上限）。
- **计费**：进模型前统一缩放（小于约 544² 放大，更大的缩到约 1300² 的总像素），
  因此**每张图最多 1024 token**——`lib/ai/tokenEstimate.ts` 的 800/张是同量级。
- **另外两族同款**：`https://api.deepseek.com/anthropic` 收 ④ 族的
  `{type:"image",source:{type:"base64"|"url"|"file"}}`；Responses 面收
  `input_image` + `detail`。两条本项目的适配器都已经按这个形状发
  （`lib/ai/anthropic.ts` 的 `blocksOf`、`lib/ai/responses.ts`），实测三族读图
  计费一致（同一张图都是 +~180 token）。④ 族的 base 填
  `https://api.deepseek.com/anthropic`（适配器补 `/v1/messages`）；② 族的 base 填
  `https://api.deepseek.com`，`/responses` 与 `/v1/responses` 实测都通。文档还说
  ② 族的 `input_image` 可以放进 `function_call_output` 的 `output`——本项目工具返回
  的图走另起一条 user 消息，用不到。
- **不收 PDF，三族都不收**（文档里平铺的 `{type:"file", file_data, filename}`
  是**传图片**的另一种写法，不是文档输入）。实测：
  - ① 族：本项目的嵌套形状 `{type:"file", file:{…}}` 根本不被解析
    （400 `file must have a file_id or file_data`）；改成文档的平铺形状能解析，
    但 PDF 被拒（400，同上那句"只收 webp/png/jpeg/gif"）。平铺形状传 PNG 能读。
  - ④ 族 `document` 块、② 族 `input_file`：**200 返回，文件被换成
    `[Unsupported Document]` 占位**（模型的思考里原样看得到这串字，`input_tokens`
    57），不报错。
  - 结论：**不改 file part 的形状**——改成平铺只是把一个 400 换成另一个 400，而
    本项目只有 PDF 子代理造 file part。PDF 子代理本来就只绑模型抽屉里打开了
    「PDF 文件输入」的模型（`subagent.ts`，没打开直接失败），所以 DeepSeek 的
    模型**不要打开这个开关**；打开了，① 族会报上面那句难懂的 400，② ④ 族会让
    子代理在看不到文件的情况下作答。

## 3. ② OpenAI Responses

> 2026-09 按 GPT-5.4 / 5.5 / 5.6 的参考页与实测重写（此前是 o 系列时代的口径）。
> 逐字段的实测记录在 [`responses.md`](responses.md)，这里只留骨架与分水岭。

**世界观**：一条**条目（item）流**，而不是消息数组。推理、消息、工具调用是并列的
item 类型；服务端可以替你存住上一轮。

```jsonc
POST /v1/responses
{
  "model": "gpt-5.6-sol",
  "instructions": "…",                 // system 在这里，不在 input 里；不发则用端点默认
  "input": [
    { "role": "user", "content": [{ "type": "input_text", "text": "…" }, { "type": "input_image", "image_url": "data:…" }] },
    { "type": "function_call_output", "call_id": "call_1", "output": "…" }
  ],
  "tools": [{ "type": "function", "name": "f", "parameters": { /* … */ }, "strict": false }],  // 扁平；strict 省略＝自动 strict
  "tool_choice": "auto" | "required" | { "type": "function", "name": "f" },
  "reasoning": { "effort": "medium", "summary": "auto", "context": "auto", "mode": "standard" },
  "text": { "format": { "type": "json_schema", "name": "x", "schema": { /* … */ } }, "verbosity": "medium" },
  "max_output_tokens": 4096,
  "store": false,                      // 默认 true
  "previous_response_id": "resp_…",   // 或 conversation；二者互斥
  "stream": true
}
```

响应的 `output[]` 是 item 数组：`reasoning`（`summary[]`，`store:false` 时**默认带
`encrypted_content`**）、`message`（`content[]` 里是 `output_text` 或 `refusal`，
5.x 的助手消息带 `phase: "commentary"|"final_answer"`）、`function_call`（带 `call_id`）。

**思考控制按模型裁剪**：`reasoning.effort` 的七档词表每款只认子集，越界是 400 而不是
折叠（5.4 到 `xhigh`，5.6 到 `max`）；默认值也按模型（5.4 `none`，5.5 / 5.6 `medium`）。
`summary` 不发就没有思维链事件；`context`（5.5 / 5.6 默认 `all_turns`）决定往轮推理
渲不渲染回下一轮；`mode: "pro"` 是 5.6 独有的深推理档。

流式是**类型化命名事件**（`response.output_text.delta`、
`response.function_call_arguments.delta`、`response.reasoning_summary_text.delta`、
`response.completed` 等），不需要客户端猜哪个字段是增量——这是它相对 Chat Completions
的主要工程改善，也是两族无法合并的主要原因。`response.output_item.done` 带的就是
回传用的完整条目。

**有状态**是另一个分水岭：`store: true`（默认）+ `previous_response_id` 让客户端不必
回传完整历史。代价是历史存在服务端，且这条路径在任何第三方兼容层都不存在。无状态
（`store:false`）下回传 `output[]` 原样即可；**少回传不报错**，代价只在质量上。

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

① 族的 `/v1` 不能省：无 key 探测（2026-09-19）根路径 `/chat/completions` 回 nginx
的 404 HTML，`/v1/chat/completions` 回 401 JSON。平台行因此把 ① 的路径记为
`/v1` —— 此前记的是空串，新建的 ① 渠道一律 404。

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
| ② Responses | `/compatible-mode/v1/responses`（另有 `GET/DELETE …/{id}`、`GET …/{id}/input_items`） | `openai_responses_compat`（见 [`qianwen-compat-plan.md`](qianwen-compat-plan.md) §4；服务端工具见下「联网搜索与网页抓取」「代码解释器」） |
| ④ Anthropic Messages | `/apps/anthropic/v1/messages` | `anthropic_compat` 可直接用，尚无预设 |
| DashScope 原生 | `/api/v1/services/aigc/{text,multimodal}-generation/generation` | 只用于出图（见下一小节） |

目录只有 ① 面有：`GET /compatible-mode/v1/models` 返回 OpenAI 形态、249 条（2026-09-03），
同一模型常有 `kimi-k3` / `kimi/kimi-k3`、`glm-5.2` / `ZHIPU/GLM-5.2` 两种 id——不带前缀的是
「阿里云直供」，带前缀的是第三方直供，二者参数支持面不同。国际部署
`dashscope-intl.aliyuncs.com` 是独立 host 与 key。

实测方法：用仓库里的真实 adapter（`streamOpenAI` / `streamAnthropic` / `streamCompletion` /
`testProviderConnection`）跑 `src/lib/ai/__tests__/live.qianwen.test.ts`（设 `QIANWEN_KEY`
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
  **小于 10px 的图 400**（`height:1 or width:1 must be larger than 10`）。qwen3-vl-plus 的格式、
  token 计价、高分辨率开关、视频与 ASR 见下「视觉理解」小节（2026-09-14）。
  ⚠️ 这里的 deepseek 是**本平台上架的 `deepseek-v4-pro-0813`**，它本来就没有视觉；
  别把这条读成「DeepSeek 不能看图」。官方直连的 `deepseek-flash`（DeepSeek-V4.1-Flash）
  支持图片理解，收的正是同一个 `image_url` + `data:` URL 形状 —— 见 §2.1。
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
[`qianwen-compat-plan.md`](qianwen-compat-plan.md) §4。图片（`input_image`）2026-09-14 已实测：
qwen3.8-flash 可用，qwen3-vl-plus 在这个面上根本不存在，见下「视觉理解」。

#### 联网搜索与网页抓取（`web_search` / `web_extractor`，2026-09-14 实测）

官方文档：`platform.qianwenai.com/docs/developer-guides/tool-calling/web-scraping`。实测用
`src/lib/ai/__tests__/live.qianwen.test.ts` 的「server tools」组 + curl，提示词统一为
「用两句话概括 https://www.rust-lang.org/ 首页讲了什么」。本项目的实现在
`src/lib/ai/serverTools.ts`（`openaiServerToolsBody` / `responsesServerTools` /
`responsesServerToolEvent`）。

- **抓取离不开搜索，三条线都一样**：② 面只声明 `{type:"web_extractor"}` 时，HTTP 200 后
  第一个事件就是 `response.failed`，`error.message` 为
  `<400> InternalError.Algo.InvalidParameter: The web_extractor tool must be executed with web_search tool.`
  所以本项目把 `web_extractor` 存成 `web_search` 的**附加档**，单独出现时丢弃（`normalizeServerTools`）。
- **② 面（Responses）**：`tools:[{type:"web_search"},{type:"web_extractor"}]`，qwen3.8-flash
  不开思考参数也可用。抓取过程**可见**：
  - `response.output_item.added` 送出 `{type:"web_extractor_call", id, urls:[…], goal, status:"in_progress"}`，
    `output_item.done` 再补上 `output`（端点按 `goal` 提炼过的正文，不是原始 HTML，以
    `The useful information in <url> for user goal … as follows:` 开头）。
  - 搜索是 `{type:"web_search_call", action:{type:"search", queries:[…]}}`，`done` 时
    `action.sources:[{type:"url", url}]`（**没有标题**，同一 URL 可能重复出现），另有
    `response.web_search_call.{in_progress,searching,completed}` 三个进度事件。
  - 模型觉得不需要搜时，会只抓取、不搜索：计次只有 `web_extractor`。
  - 用量：`usage.x_tools.{web_search,web_extractor}.count`，另有 `usage.x_details[].plugins`
    重复同一数字；本项目暂不读。
  - 这些 item 不需要回传（本项目的 echo 只收 reasoning / function_call / message）。
- **① 面（Chat Completions）**：抓取没有独立字段，是 `enable_search:true` +
  `search_options:{search_strategy:"agent_max"}`。过程**完全不可见**（流里只有普通的
  `reasoning_content` / `content`），只能从输入 token 看出发生了什么：

  | 模型 | 请求 | 结果 | prompt_tokens |
  | --- | --- | --- | --- |
  | qwen3.8-flash | `agent_max`（开不开 `enable_thinking` 都一样） | **400** `The current model does not support the "agent" search strategy.` | — |
  | qwen3-max | `enable_search` 不带策略，开思考 | 凭记忆作答，**根本没搜** | 29 |
  | qwen3-max | `agent_max`，开思考 | 读到页面 | 1610 |
  | qwen3-max | `agent_max`，**关思考** | 读到页面 | 1199 |
  | qwen3.5-plus | `agent_max`，开 / 关思考 | 读到页面 | 1668 / 1530 |

  文档说 ① 面 qwen3-max 「必须开思考」，实测关掉也行（见下表）。400 发生在流开始之前，
  是普通的 HTTP 错误，作者能直接看到；本项目**不做降级重试**（agent_max → 普通搜索），
  因为那等于悄悄收回作者开的能力。
  **例外：带函数工具的请求**。`agent_max` 是 DashScope 的「agent 模式」，与函数工具同发一律 400
  （`Agent mode does not support tools. You need to either avoid using enable_code_interpreter or avoid using the agent mode with enable_search.`，
  2026-09-17 在 qwen3.5-plus 上复现；同样的请求只发 `enable_search` 则正常搜索，prompt_tokens 5111）。
  这是请求形状决定的、必然失败的组合，不是模型能力问题，所以 `openaiServerToolsBody` 在本轮带函数工具时
  只发 `enable_search`、不发 `agent_max`——agent / 对话助手的轮次在 ① 面上只搜不抓；搜索子代理不带函数工具，照常抓取。
  （这个问题从 2026-09-14 接入抓取起就在，当时只测了不带工具的请求。）
- **计费**（文档口径）：抓取限时免费；搜索 ¥4/千次；抓回的正文算输入 token。
- **没测的**：④ 面的 `web_fetch_<日期>`（文档没给版本号），所以本项目 ④ 族不提供抓取开关。

#### 图片搜索（`web_search_image` 以文搜图 / `image_search` 以图搜图，2026-09-14 实测）

官方文档：`platform.qianwenai.com/docs/developer-guides/tool-calling/image-search`。qwen3.8-flash，② 面。

- **只有 ② 面有**。① 面猜的 `search_options:{enable_image_search:true}` 不报错、被静默忽略
  （模型回「没有可直接打开的图片 URL」）。本项目只在 `openai_responses_compat` 上提供这两个开关。
- **不需要搜索陪同**：只声明 `{type:"web_search_image"}` 或 `{type:"image_search"}` 都能跑；
  四个工具（`web_search` / `web_extractor` / `web_search_image` / `image_search`）同时声明也正常，
  「雪豹分布在哪 + 给两张照片」一问里模型各调了一次搜索和以文搜图。
- **item 形状像函数调用，不像 `web_search_call`**：`output_item.added` 给
  `{type:"web_search_image_call"|"image_search_call", name, arguments, status:"in_progress"}`，
  `arguments` 是 **JSON 字符串**——以文搜图是 `{"queries":[…]}`（模型自己扩成中英文多条），
  以图搜图是 `{"img_idx":0,"bbox":[0,0,1000,1000]}`（第几张输入图、归一化到 1000 的框）。
  `done` 时加 `output`，**也是 JSON 字符串**：`[{"title","url","index"}]`；没搜到是 `"[]"`，不是错误。
- **以图搜图的输入图**：`data:` URL 被接受（本项目发的就是这个形状）；公网 URL 要端点自己抓得到——
  一个 upload.wikimedia.org 的 jpg 直接 `response.failed`
  （`The provided URL does not appear to be valid`），换一张国内站点的图就有结果。
- **只声明不触发是安全的**：带 `image_search` 的纯文字请求（「天空什么颜色」）正常作答，
  没有 `image_search_call`——所以它能像其他服务端工具一样做成「按模型常开」的声明。
- 用量：`usage.x_tools.web_search_image.count` / `image_search.count`。
- **计费**（文档口径）：以文搜图 ¥24/千次，以图搜图 ¥48/千次，都远高于联网搜索的 ¥4——
  这是它们各自单独开关、不挂在搜索下面的原因。单次最多 100 条结果。

#### 代码解释器（`code_interpreter`，2026-09-17 实测）

官方文档：`platform.qianwenai.com/docs/developer-guides/tool-calling/code-interpreter`。实测用 curl
扫了一遍 `/models` 里的候选 id，再用 `live.qianwen.test.ts` 的「server tools: code_interpreter」组
走真实 adapter 复核；提示词「请用代码计算 123 的 21 次方」（44 位数，模型背不出来，答对即说明真跑了）。
本项目的实现在 `src/lib/ai/serverTools.ts` 与 `capabilities.ts`（`code_interpreter` 的模型 id 格 / `openaiServerToolsBody` /
`responsesServerTools` / `codeInterpreterEvent`）。

- **两个面的拼写和条件都不一样**：

  | | ① Chat Completions | ② Responses |
  | --- | --- | --- |
  | 声明 | 顶层 `enable_code_interpreter: true` | `tools:[{type:"code_interpreter"}]` |
  | 非流式 | **400** `Non-streaming mode does not support Code interpreter.` | 可以（返回完整 `output`） |
  | 同时带函数工具 | **400** `Agent mode does not support tools. You need to either avoid using enable_code_interpreter or avoid using the agent mode with enable_search.` | **可以**，qwen3.5-plus 一问里先调了 `get_weather`、下一轮再跑代码 |
  | 关思考 | qwen3.5-plus、qwen3-max 都照常跑（与文档「qwen3-max 需开思考」不符） | `reasoning.effort:"none"` 或 `enable_thinking:false` → `response.failed`：`Normal mode does not support Code interpreter. Please set enable_thinking to true.` |
  | 与 `enable_search` / `web_search` 同开 | 可以（含 `agent_max`，但只在不带函数工具时——带工具时 `agent_max` 本身就 400，见上「联网搜索与网页抓取」） | 可以 |
  | 过程可见 | **不可见**，只有 prompt_tokens 从 ~30 涨到 700–1600 | 可见，见下 |

  文档说「与 function calling 互斥」，实测只在 ① 面成立。本项目的处理：① 面上**本轮带函数工具就不发**
  `enable_code_interpreter`（agent 的工具不能让），所以 ① 面上它只惠及不带工具的请求；② 面上
  **思考档位为「关闭」就不发**这个工具。两处都是按请求丢掉，而不是发一个必然失败的请求。
- **支持哪些模型，按 id 判断**（`capabilities.ts` 里 `DASHSCOPE_CODE_INTERPRETER` 的 `runs` / `refuses` 两组正则：`runs` 里的 id 是「能发」，`refuses` 里的 id 没有开关（已开着的显示「不发送」），两组都没有的 id 给开关、标「未实测」、照发——见 [`capability-gating-plan.md`](capability-gating-plan.md) §8.7）：

  | 模型 | ① 面 | ② 面 |
  | --- | --- | --- |
  | qwen3-max、qwen3-max-2026-01-23 | ✅ | ✅ |
  | qwen3-max-preview | 不报错、**静默忽略**（prompt 24） | ❌ `does not support the code_interpreter tool` |
  | qwen3.5-plus（含日期版）、qwen3.6-plus、qwen3.7-plus、qwen3.7-max、qwen3.6-max-preview | ✅ | ✅ |
  | qwen3.5-flash、qwen3.6-flash | ✅ | ✅（qwen3.6-flash 有一次思考完就挂住、150 秒超时，未复现） |
  | qwen3.8-flash、qwen3.8-max、qwen3.8-27b | ❌ `does not support the code_interpreter tool` | ✅（含 qwen3.8-max-0902、qwen3.8-2.4t-a95b） |
  | qwen3.5-397b-a17b | ✅ | ✅ |
  | qwen3.5-27b、qwen3.6-35b-a3b | 未测 / 未测 | ✅ |
  | qwen3.6-27b | 未测 | ❌ `Unsupported model` |
  | deepseek-v4-pro、deepseek-v4.1-flash | 未测 | ✅ |
  | qwen-max、qwen3.5-omni-plus | 静默忽略 | 未测 / `Unsupported model` |
  | qwen-plus | 未测 | ❌（开思考后又报 `result_format` 必须是 `message`） |
  | qwen3-vl-plus、qwen3-235b-a22b-thinking-2507 | 未测 | ❌ |

  ① 面「静默忽略」是按 id 判断而不是「开了试试」的原因：作者看不到任何报错，只会得到一个没算过的答案。
  所以实测静默忽略的 id 进 `refuses`，没有开关；3.8 之后的新一代先落在「未实测」，开关旁写明可能被静默忽略；等官方文档的支持列表更新了再补进 `runs`（见 capability-gating-plan §8.7「名单从哪来」）。qwen3-coder-plus 在 ① 面也跑了，但文档没列，未收。
  另：qwen3-max 在 ① 面**开思考**时有一次思考文本来回重复、180 秒没出结果（1453 个数据块），只出现过一次。
- **② 面的 item**：`output_item.added` 就带完整代码
  `{type:"code_interpreter_call", id, code, container_id:"", status:"in_progress"}`，之后是
  `response.code_interpreter_call.{in_progress,interpreting,completed}` 三个进度事件（只有 `item_id`），
  `output_item.done` 补上 `outputs:[{type:"logs", logs}]`——`logs` 外面包着一层 markdown 代码围栏。
  - **Python 异常不算失败**：`1/0` 的 item 仍是 `status:"completed"`，traceback 在 `logs` 里，模型据此作答。
    执行日志的结果列取输出的最后一行，正好是 `ZeroDivisionError: division by zero`。
  - **画图**：matplotlib 的图以 markdown 图片的形式**写在 `logs` 里**，指向带签名的 OSS 地址
    （`dashscope-cn-beijing.oss-cn-beijing.aliyuncs.com/code-interpreter/temp_files/…`），
    `Expires` 约 12 小时后。最终回答正文里**不带**这个链接。本项目只当文本记进日志，不下载、不保存。
  - 用量：`usage.x_tools.code_interpreter.count`（`x_details[].plugins` 重复同一数字）。
  - 这些 item 不需要回传；多轮里 echo 照旧只收 reasoning / function_call / message，实测第二轮正常。
- **计费**（文档口径）：限时免费；但一次回答会触发多轮推理，token 用量明显增加
  （qwen3.8-flash 一问约 1.1k tokens，不开时约 30）。所以本项目自己发起的后台请求——前情摘要
  （`memoryStore`）、合集摘要（`digestStore`）、Sakura 翻译（`translate/run.ts`）、设定图片描述
  （`lore/vision.ts`），以及早已如此的结构化任务与历史压缩——一律不带服务端工具：
  处理的都是手头已有的文本或图片，没什么可查、可算的，带上只会多花钱。
- **官方 api.openai.com 的 `code_interpreter` 不是这个工具**：它要求 `container` 参数，本项目不对 `openai_responses` 提供此开关。

#### 视觉理解（qwen3-vl 系列，另附视频与 ASR 在 ① 面上的样子，2026-09-14 实测）

实测用真实 adapter（`streamCompletion`）走一次性探测，稳定的事实固化进
`src/lib/ai/__tests__/live.qianwen.test.ts` 的「vision: qwen3-vl-plus」组（夹具在测试里现生成：
纯色 PNG 编码器 + 两个 16px 的 webp / gif 常量）。主测模型 qwen3-vl-plus，① 面，除注明外都是它。

`/compatible-mode/v1/models` 里的视觉 id：`qwen3-vl-plus` / `qwen3-vl-flash`（各带日期快照）、
`qwen-vl-max`、`qwen-vl-plus`、`qwen-vl-ocr`（`-latest`）、`qwen3.5-ocr`、`qvq-max` / `qvq-plus`，
以及 omni 家族。

**格式与边界**

| 输入 | 结果 |
| --- | --- |
| 16px 纯红 png / jpeg / webp / gif（`data:` URL） | 都读成「红色」，输入 token 相同（81） |
| 两帧动图 gif（红 → 蓝） | **只看第一帧**，还说「这是静态图片（单帧）」 |
| 两张图（红、蓝）同一条消息 | 顺序正确「红,蓝」 |
| 9×9 | **400** `The image length and width do not meet the model restrictions. [height:9 or width:9 must be larger than 10]` |
| 10×10、200×10 | 通过——下限是**每边 ≥10px**，报文里的 "larger than" 实为「不小于」 |
| `image_url.detail: low / high` | **无视**：16px 与 2048² 上两档输入 token 完全相同 |
| 纯文字提示（不带图） | 正常作答，**默认不思考**（qwen3-vl-flash 同） |
| 图 + `tools` + `qwen-budget` 思考 | 先思考，再按图里读到的城市名调用 `get_weather{city:"Hangzhou"}` |

**图片 token 计价**：约每 32×32 像素块 1 个 token（≈ 像素数 / 1024），另有默认上限。纯文字基线
（「回答OK」）是 10 个输入 token，下表是带一张纯灰方图后的总输入 token：

| 边长 | 默认 | `vl_high_resolution_images: true` |
| --- | --- | --- |
| 64 | 76 | — |
| 512 | 268 | — |
| 1024 | 1036 | — |
| 2048 | **2512**（已触顶） | 4108 |
| 4096 | **2512**（同上） | **16396**（上限约 16384） |

- 默认上限约 **2500 图片 token**：2048² 与 4096² 被缩到同一个价。`vl_high_resolution_images`
  是 ① 面的**顶层**布尔（本项目经 `extraBody` 发），把上限抬到约 16384。
- 缩放不等于看不清：3000² 白底中央一串 11pt 数字，默认档（2526 token）与高分辨率档（8862 token）
  **都读对**。高分辨率是花 3.5 倍的钱换极小字的余量，不是看图的前提。

**别的线路与模型**

| 线路 / 模型 | 结果 |
| --- | --- |
| ② 面 Responses，qwen3-vl-plus | **`Unsupported model: 'qwen3-vl-plus'`**（png / webp / 多图都一样）——这个模型不在 ② 面上 |
| ② 面 Responses，qwen3.8-flash + `input_image`（data URL） | 读对，且照常思考 |
| ② 面 Responses，`video_url` part | HTTP 200、**空输出、无报错**（adapter 当时把这个 part 静默丢了；本 PR 改为报错） |
| ④ 面 `/apps/anthropic`，qwen3-vl-plus，png / webp | 读对，**默认思考**（`claude-adaptive` 档） |
| qwen-vl-ocr-latest | 读出图中文字；也会调工具；纯文字提示照答 |

**视频**（① 面，qwen3-vl-plus 除非另注；本项目据此接了对话 `@` 视频，见 [`../feature/video-input.md`](../feature/video-input.md)）

| 请求 | 结果 |
| --- | --- |
| `{type:"video_url", video_url:{url:"data:video/mp4;base64,…"}}`，1.5s 红 + 1.5s 蓝拼接，320×240 10fps | **400** `Invalid video file.`（加 `fps` 也一样；同尺寸单次编码的 3s 片段正常，疑为拼接编码问题） |
| 同上，3s + 3s，640×480 25fps | 通过，1822 输入 token，按时间戳描述了红 → 蓝；`fps` 字段被接受 |
| 640×480，**1s** | **400** `The video file is too short` |
| 640×480，2s | 通过——**下限在 1–2 秒之间**，本项目按 2 秒拦 |
| 40s 1080p，17.5MB mp4（base64 约 23MB） | **400** `Exceeded limit on max bytes per data-uri item : 20971520` |
| 60s 720p，11.3MB mp4（base64 约 15MB） | 通过（默认 fps 125 秒才出结果）——原文件要 ≤ 约 15MB |
| 4s webm（`video/webm`）、4s mov（`video/quicktime`） | 都读对（mov 一次因网络断开重试后通过） |
| `fps` 放在哪 | 内容块上、`video_url` 的**兄弟字段**：`{type:"video_url", video_url:{url}, fps:0.5}` |
| qwen3-vl-flash、qwen3.8-flash，6s 320×240 | 都读对 |
| qwen3.5-omni-flash，带人声的视频（流式） | 读画面**且转写出人声** |
| qwen3-vl-plus，同一段带人声的视频 | 「没有语音内容」——**不听音轨** |
| `{type:"video", video:[data URL…]}` 帧序列，2 帧 | **400** `the range of sequence images should be (4, 2000)` |
| 同上，4 帧 | 通过 |

**视频 token 计价**（`usage.prompt_tokens_details.video_tokens`）：

| 片段 | `fps` | video_tokens |
| --- | --- | --- |
| 640×480，2s / 3s | 不发 | 602 / 902（约 300/秒） |
| 320×240，3s / 6s | 不发 | 242 / 482（约 80/秒） |
| 320×240，6s | 1 / 0.5 | 242 / 162（到了至少 4 帧的下限） |
| 1280×720，60s | 不发 / 4 / 0.5 | 35,642 / 71,282 / 8,912 |

- 默认 fps 约 **2**；token 与 fps 成正比，每帧像素折算（约每 32×32 一个 token）在 720p 附近封顶（每两帧约 594）。
- 复现以上每个点的规律：帧 = round(时长×fps)，至少 4、取偶；每两帧 min(round(宽/32)×round(高/32), 594)；+2。**这是反推，不是文档**，本项目只把它当估算（≈）。

**音频走 ① 面**（本项目的转写有两条：原生面 filetrans 异步，和这条同步——模型行 `asrFormat: "dashscope-sync"`，
`lib/asr/sync.ts`；设计与取舍见 [`../feature/asr/00-research.md`](../feature/asr/00-research.md) §1.3 补记。2026-09-14 实测）

| 模型 | 请求 | 结果 |
| --- | --- | --- |
| qwen3-asr-flash（别名） | 只一个 `{type:"input_audio", input_audio:{data:"data:audio/wav;base64,…", format:"wav"}}` | 逐字转写正确；`message.annotations: [{type:"audio_info", language:"zh", emotion:"neutral"}]`；`usage: {seconds: 6, prompt_tokens_details:{audio_tokens:169}}` |
| qwen3-asr-flash-2026-02-10（日期快照） | 同上（mp3 同） | 逐字转写正确，但**没有 `annotations`、没有 `usage.seconds`**，只有 `audio_tokens`（25 token / 秒）——计费秒数只能反推 |
| 同上 | user 消息再加一个 text part | **400** `The dedicated task \`asr\` corresponding to the current service does not support this input.` |
| qwen3-asr-flash | 前置 `system` 消息（text part，「专有名词：西湖、杭州」） | 接受，`text_tokens: 7` |
| qwen3-asr-flash | 顶层 `asr_options: {language:"zh", enable_itn:true}` | 接受，`text_tokens: 3` |
| qwen3-asr-flash | `stream: true` + `stream_options.include_usage` | 可用；每个 delta 都带 `annotations`，`usage.seconds` 在最后一块 |
| qwen3-asr-flash | m4a / ogg / flac | 都正确；mp4（视频容器）读音轨，3 秒 |
| qwen3-asr-flash | 286 秒 mp3（1.1MB） | 200，`seconds: 286`，`audio_tokens: 7169` |
| qwen3-asr-flash | 330 秒 mp3（1.3MB） | **400** `InternalError.Algo.InvalidParameter: The audio is too long` |
| qwen3-asr-flash | 13MB wav | **400** `InternalError.Algo.InvalidParameter: Multimodal file size is too large`（文档口径 ≤ 5 分钟 / ≤ 10MB） |
| qwen-audio-3.0-asr-flash、fun-asr-flash-2026-06-15 | 同一形状 | **400** `format is empty`（`UNSUPPORTED_FORMAT`）——不在这条线上 |
| qwen3.5-omni-flash | text + `input_audio` | 听懂并概括了内容 |

延迟：6 秒音频多数 1.3–15 秒。响应 `content` 是整段纯文字——没有时间戳、没有说话人，这是同步路径做不到的部分。

**本项目据此做了什么**：模型类型加「视觉理解」与「音频 ASR」两类（v1.57.0）；图片发出前按每边 10px
下限处理；模型可声明 `vl_high_resolution_images`（v1.57.0 加入；上表说明默认档多数时候已够读小字，开它是按需加钱）。
视频输入（2026-09-14）：模型可声明「视频输入」与抽帧频率，对话里 `@` 视频作为 `video_url` 发出，只走 ① 面（[`../feature/video-input.md`](../feature/video-input.md)）。
① 面同步 ASR（2026-09-14）：`asrFormat` 加 `dashscope-sync`，user 消息只放音频，≤10MB / ≤5 分钟 / 六个格式在批准前拦，
上面三句 400 原话改口成作者能照做的话（`sync.ts` 的 `syncErrorOf`），日期快照缺 `seconds` 时按 audio_tokens / 25 向上取整。

#### 文档与实测不符之处（截至 2026-09-03）

| 文档说 | 实测 |
| --- | --- |
| kimi-k3 `enable_thinking` 只能 `true` | `false` 与 `reasoning_effort:"none"` 都关得掉 |
| `parallel_tool_calls` 默认 `false` | 不发也并行回两个调用 |
| 思考模式不支持强制 `tool_choice` | 只有 qwen3.8-flash、MiniMax-M2.5 拒；其余 5 个接受 |
| ④ 面 `thinking.type` 只有 enabled/disabled | `adaptive`（含 `display`）被接受 |
| `json_object` 要求 "json" 字样 | 只有 Qwen / DeepSeek 执行 |
| 3.7 代接受 `reasoning_effort` | 接受但无视，只认 `thinking_budget` |
| ① 面网页抓取（`agent_max`）在 qwen3-max 上必须开思考（2026-09-14） | 关思考照样抓取（prompt_tokens 1199）；qwen3.8-flash 无论开关都 400 |

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
  Responses API 暂不支持该能力（出处：[千问 PDF 理解文档](https://platform.qianwenai.com/docs/developer-guides/tool-calling/pdf-understanding)；
  所以模型抽屉的「PDF 文件输入」开关虽然对 ② 族开放，提示里写明千问要在 ① 族服务商下开）。file 内容块与 ① 族官方（gpt-4o/4.1 的 PDF
  输入）同形，是镜像而非私有发明。
- **`preserve_thinking`**（qwen3.8-max 默认开）要求把历史 `reasoning_content`
  **完整**回传；本项目只在工具轮回传上一轮的思维链，纯对话轮不回传——3.8-max
  上是否因此报错未验。

#### DashScope 的图片模型：不在兼容层上，走原生协议（2026-09-04 已实测 qwen-image-3.0-pro 与 wan2.7-image-pro）

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

**2026-09-04 实测**（`src/lib/ai/__tests__/live.dashscope-image.test.ts`，驱动真实的
`generateImage`，`DASHSCOPE_IMAGE_KEY` 才跑；key 是千问AI平台的 `sk-ws-…` 工作空间 key，
打的仍是 `dashscope.aliyuncs.com`）——本项目的 body **一个字节没改就通了**，上面的
协议事实全部成立，另外几条文档没写的：

- **qwen-image-3.0-pro 的 `size` 只收 `宽*高`**：发 `"1K"` 答 400
  `InvalidParameter: Expected format: '<width>*<height>'`（0.2s，不计费）；
  **省略 `size` 默认出 2048×2048，按 2K 计费（¥0.5，1K 是 ¥0.25）**。本项目对
  qwen-image 没有方言，尺寸来自作者手填的框——不填就是双倍价，值得补一个方言。
  wan2.7 两种写法都收（`"1K"` 与 `768*1376` 都实测通过）。
- **输入图收 data URL**：qwen 改图与 wan 参考图都用 `data:image/png;base64,…`
  直接过（wan 同一请求里混一张 https 也行）。wan 的参考图按 token 计入 `usage`
  （两张 1024² 参考图 `input_tokens: 18790`），qwen 报 `input_image_count` 与
  `input_image_type: qima_input_1k`。
- **wan2.7-image-pro 同步与异步都在**：同步 `multimodal-generation` 14–20s 一张；
  异步 `image-generation` + `X-DashScope-Async` 提交 0.16s 返回 `PENDING`，之后
  `RUNNING` 约 24s 后 `SUCCEEDED`，**成功的任务也用 `output.choices[].message.content[].image`**
  （不是 `results[].url`——本项目两种都认）。wan 的 part 多一个 `type:"image"` 键。
- qwen-image-3.0-pro 一张 40s；`output.rewrite_status: "success"` 说明它改写了提示词，
  但改写后的文本不回传。
- 图片 URL 在 `dashscope-*.oss-accelerate.aliyuncs.com`，`content-type: image/png`，
  字节确实是 PNG。

#### 出图参数的四套方言（2026-08 对官方文档校准；Qwen-Image 3.0 于 2026-09-04 实测）

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

- **Qwen-Image 3.0（DashScope 原生，2026-09-04 实测）**：`parameters.size` **只收**
  `宽*高`——发 `"1K"` 答 `400 InvalidParameter: Expected format: '<width>*<height>'`；
  约束是**总像素**在 512²~2048² 之间而不是边长（2720*1536 被接受）；计费按**面积**分
  `qima_output_1k` / `qima_output_2k` 两档（¥0.25 / ¥0.5），**省略 `size` 出 2048² 并按
  2K 收费**；改图不发 size 时画幅跟随输入图但同样放大到 2K 面积（768×1376 输入出
  1520×2736）。所以这套方言永远发尺寸、默认 1K 面积，改图在作者没点画幅时按输入图
  自己的比例在所选档位重算（`ImageParamOptions.inputSize`，调用点从 data URL 头部
  读尺寸）——「跟随输入」在这个端点上没有不花双倍钱的写法。

本项目把这几套各自封成一个「参数方言」（`lib/ai/imageDialects.ts`，
`ImageCaps.dialect` 声明），UI 按方言给出画幅/分辨率/质量选项，请求侧由
方言算出该端点真正认识的字段。

#### 输出格式能不能选（2026-09-05 查官方文档）

四套方言里**只有 GPT-Image 系能选输出格式**；其余三家要么固定 PNG，要么参数只在
另一个 surface 上生效。之前在中转站 ③ 路由上看到的 JPEG 字节（第九个样本）是那条
渠道自己转的，不是模型的设置——这也是「mime 读字节、声明只作兜底」不能撤的原因。

| 模型 | 能否选 | 参数 | 默认 | 备注 |
| --- | --- | --- | --- | --- |
| gpt-image-2（`/images/generations` 与 `/images/edits`） | **能** | `output_format` ∈ `png` / `jpeg` / `webp`；`output_compression` 0–100（仅 jpeg / webp）；`background: transparent` 仅 png / webp | png | 官方指南：「`jpeg` 比 `png` 快，在意延迟就优先 jpeg」。但 openai-node #1850（2026-04-28，未见回复）实测 gpt-image-2 **对 `webp` 静默忽略、返回 PNG 字节**，`jpeg` 正常。走 chat 路由时没有任何格式参数 |
| Gemini 3.1 Flash Image（`generateContent`） | **开发者 API 不能** | SDK 类型里有 `imageConfig.outputMimeType` / `outputCompressionQuality` / `imageOutputOptions`，但 js-genai 文档逐条标注 "This field is not supported in Gemini API"，**只在 Vertex AI 上生效**（Google 自己的 3.1 Flash Image 笔记本用的就是 Vertex 的 `output_mime_type="image/png"`） | `inlineData.mimeType` 为 `image/png` | 新的 Interactions API 另有 `response_format.mime_type`（`image/jpeg` / `image/png`），是另一个 surface。顺带：js-genai #1461（2026-04，未解决）报 3.1-flash-image-preview **无视 `imageSize`，永远 1K** |
| wan2.7-image / -pro（DashScope） | **不能** | `parameters` 只有 size / n / seed / watermark / thinking_mode / enable_sequential / color_palette / bbox_list | PNG | 文档原话：「生成图像的 URL，图像格式为PNG。链接有效期为24小时」；2026-09-04 实测字节确是 PNG |
| qwen-image-3.0 / -pro（DashScope） | **不能** | prompt_extend / prompt_extend_mode / enable_thinking / n（1–6）/ size / negative_prompt / seed / watermark | PNG | 文档写「图像格式：png」，24 小时过期；输入图收 JPG / PNG / BMP / TIFF / WEBP / GIF |

**推论**：GPT-Image 方言若要暴露输出格式，只给 png / jpeg 两档（webp 在官方端点上是假的）；
Gemini 路由不加格式字段，加了在 Gemini API 上也不生效。

来源：OpenAI 图像生成指南（developers.openai.com/api/docs/guides/image-generation）、
openai/openai-node#1850、js-genai `ImageConfig` 接口文档与 googleapis/js-genai#1461、
GoogleCloudPlatform/generative-ai 的 `intro_gemini_3_1_flash_image_gen.ipynb`、
阿里云百炼「万相-图像生成与编辑2.7 API参考」与「Qwen-Image-3.0 文生图/图像编辑 API参考」。

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
  调，跨族的请求由它翻成上游原生形态），③④ 是"直接透传"（第十八个样本：回包是原样，请求侧不是）。这印证了
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
  `gemini_error`）——文档如此；第十八个样本实测时 ③④ 的上游错误都被改写成 OpenAI 形，
  ④ 的 `type` 甚至是 `"<nil>"`，没见到 `claude_error` / `gemini_error`。**流中错误**：① 族是 `data: {"error":…}` 后接 `[DONE]`，
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
  Gemini image 系列在 chat 上的回包形态。**除最后一项外，2026-09-26 由
  第十八个样本补上**——那里也改了本节三处判断：③④ 回包是上游原样，但请求
  侧会被重新序列化；① 与 ② 的默认线路背后是一层 OpenRouter 形态的翻译；上游错误信封
  被改写而非透传（上面两处已就地标注）。

### 第八个样本：New API 中转站上的 ② 族（`[Pro]` 档 GPT-5.4 / 5.5 / 5.6-sol，2026-09-03 实测）

协议事实本身在 [`responses.md`](responses.md)，这里只记**中转站自己干的事**。样本是
`hk.chenmoai.com`，New API 软件，`[Pro]` 档＝ChatGPT Pro 账号背后的 Codex 后端；同一
host 上还挂着 `[Plus]` / `[官key]` / `[次数]` / `[kiro]` 等档位，同名模型不同后端。
目录 `GET /v1/models` 是 OpenAI 形态并带 `supported_endpoint_types`（与 OrcaRouter 同款，
第七个样本）。

- **不发 `instructions` 就注入 Codex 的系统提示**（"You are Codex, a coding agent based on
  GPT-5…"，响应的 `instructions` 字段原样回显），一次请求输入 **4.4K–7.5K token**；发了
  自己的 `instructions` 则只有自己的（15 token）。这是本目录里最贵的一条静默行为：
  不报错、不影响输出、只影响账单和上下文。**规则：对这类中转站永远显式发 system。**
- **`text.format` 显式 `strict: true` 时整个 `format` 被丢掉**（回显 `{type:"text"}`，
  输出不按 schema）；省略 `strict` 则正常透传并被官方自动升成 strict。同一中转站上
  ① 族的 `response_format: json_schema` strict 正常。
- **`reasoning.mode: "pro"` 回显 `standard`**（5.6-sol）；是这一档不给 pro 还是中转站
  吞了字段，分不清。
- **`stream_options.include_obfuscation: false` 无效**，delta 里仍有 `obfuscation`。
- **上游 60s 超时**：nginx 504 HTML 页，或 `{error:{message:"bad response status code 502"}}`；
  约 90 次请求里 9 次，5.6-sol 最多（多轮回传两次都没跑成）。**HTML 404/504 不是 API
  错误信封**，探测逻辑不能把它读成"端点在说话"。
- **假模型名答 503**（`{error:{code:"model_not_found", type:"new_api_error"}}`，流式请求
  也是 HTTP 503 + JSON），不是 404；坏 key 401 `Invalid token`。
- **① 族是翻译出来的**：同一批模型打 `/chat/completions`，`delta.reasoning_content`
  有内容（官方 ① 族没有这个字段）、思考开着也能带工具（官方文档说 5.4 起不行）——
  中转站把 ① 翻成 ② 再打后端。**在这种中转站上验不了"官方 ① 族对 5.4+ 的限制"**。
- 未知顶层键被忽略（与官方 ② 族一致）。

### 第九个样本：同一中转站上的两条生图路由（`[R]gpt-image-2` 经 ①、`[R]gemini-3.1-flash-image-preview` 经 ③，2026-09-04 实测）

生图没有协议——① 族的 Chat Completions 根本没有图片字段，③ 族有（`inlineData`）但
中转站照样各自发挥。实测工具是 `src/lib/ai/__tests__/live.relay-image.test.ts`（驱动真实的
`generateImage`，`RELAY_IMAGE_KEY` 才跑），每条用例一张图；结论已回填 `lib/ai/image.ts`
与 `imageClient.test.ts`。样本仍是 `hk.chenmoai.com`（第八个样本那台）。

**`[R]gpt-image-2` 走 `/chat/completions`（本项目的 `chat` 路由）：**

- **同一个模型名背后不止一条渠道，回包形状随渠道变。** 第一小时：生成回包把**同一串裸
  base64 放了三处**——`message.content`（不带 `data:` 前缀、不带 markdown）、
  `message.images[0].b64_json`、`message.image_b64_json`；一小时后同一请求改答**一条裸的
  S3 预签名 URL**（`X-Amz-Expires=86400`）当 `content`，别的字段都没有。本项目原先只认
  `images[].image_url.url`、markdown `![](…)` 和 part 数组，这两种都解析成「模型只回了
  文字」——NoImageError，还把 base64 当模型的原话截 200 字挂在错误里。现在四种都收，
  且**按值去重**（三处同一张图只算一张）。
- **字符串 `content` 会 400。** 同一条 curl，`content: "…"` 在 14:2x 返回 200，14:38 起
  一律 `400 images[0] must be an http/https URL or image data URI`；换成一元 part 数组
  `[{type:"text",text:"…"}]` 就 200。是中转站把这条 chat 翻成 images 请求时的 bug，
  但没有别的办法绕：**`chat` 路由现在无论有没有输入图都发 part 数组**。
- **`[R]` 之外的档位不走 chat**：`gpt-image-2` / `[C]gpt-image-2` / `[原生4k]gpt-image-2`
  答 `400 This model is not supported on the Chat Completions endpoint`；`[codex]` 同 `[R]`
  的 400。**`/v1/images/generations` 上 `[R]gpt-image-2` 正常**（`data[].url`，OpenAI 形状
  的 usage 带 `output_tokens_details.image_tokens`），所以这台机器上 `openai_compat` 的
  默认路由也能用；chat 路由的意义在别的中转站（newAPI 上 `/images` 只认 Imagen）。
- **`n: 2` 撞 60s 上游超时**：nginx 504 HTML（第八个样本的同一堵墙）。一张 45–52s，
  两张就超。本项目发 `n` 只在 > 1 时，界面已注明多数中转返回一张。
- 参考图（两张 `image_url` data URL part）和图生图（一张）都 200；编辑回包是 URL 形。
- 一次生成 1024×1024，`completion_tokens: 1756`，`prompt_tokens` 7–14。

**`[R]gemini-3.1-flash-image-preview` 走 `/v1beta/models/{id}:generateContent`（`gemini` 路由）：**

- **`inlineData.mimeType` 说谎**：写 `image/png`，字节是 JPEG（`/9j/`）。原先直接信
  `mimeType`，存盘就是一个内容是 JPEG 的 `.png`。现在 `inlineData`、`b64_json`、data URL
  和下载回来的字节**一律嗅探魔数**，声明的类型只作兜底（`sniffImageMime`）。
- `x-goog-api-key` 与 `Authorization: Bearer` 都通（同第五个样本，但这台两种都收）。
- `imageConfig.aspectRatio` / `imageSize` 接受不报错，比例被遵守（默认出 1408×768，`9:16`+`1K` 出 768×1376）；
  `candidateCount: 2` 不报错但**只回一个候选**。
- 图生图与两张参考图（`inlineData` part）都 200，14–19s 一张，`candidatesTokenCount`
  1070–1176。
- **`[C]` 档 503**：`{code:"model_not_found", type:"new_api_error", message:"No available
  channel for model 「CS」gemini-3.1-flash-image-preview"}`——中转站把 `[C]` 前缀映射到
  一个当时没有可用渠道的组，chat 与 gemini 两个端点上一样；`[K]` 档 60s 504。所以
  同名模型换个前缀就是换后端，可用性要逐个前缀试。
- 路径里的 `[R]` 不用编码，编码成 `%5BR%5D` 也认。

**可移植的规则**：`chat` 路由的回包**没有**约定形状，只有"目前见过的形状"——每接一台
新中转都要跑一遍 live 文件，而不是照文档写解析；生图的 mime 永远读字节。

### 第十个样本：另一台 New API 上的 ② 族（`[Plus]` 档 GPT-5.6-terra / -sol，2026-09-14 实测）

协议事实回填在 [`responses.md`](responses.md) §2、§10，这里记**中转站自己干的事**，以及它和
第八个样本（同为 New API、`[Pro]` 档）的异同。样本是 `42.240.165.241:3000`，目录里同名
模型挂着 `[Plus]` / `[Pro]` / `[Azure]` / `[AWSb]` / `[官key]` / `[次数]` / `[特价Pro]` 七档
（5.6 全家三款都在，`[Plus]` 与 `[次数]` 档没有 luna），`supported_endpoint_types` 一律 `openai`。
取样：terra 跑全套（adapter 实测 12 条 + 线路探针 27 条 + 内置工具 13 条），sol 只补
与 terra 可能不同的几条（默认力度、`max`、`mode:"pro"`、`high`、`xhigh`）——两款共有的能力
只在 terra 上验，控制 token 成本。

- **不发 `instructions` 就注入系统提示**，与第八个样本同一条：`input_tokens` 8,778，其中
  7,680 命中缓存；**Chat 面也注入**（不带 system 消息的请求 `prompt_tokens` 8.8K–13.2K）。
  带 `instructions` 的 Responses 请求只有 74 token。规则不变：永远显式发 system。
- **`temperature` 被静默改写**：发 `0.5`，响应回显 `1.0`，不报错（Chat 面同样 200）。
  是中转站丢了字段还是后端强制 1，分不清——官方端点对 GPT-5 发非 1 的 temperature 的反应
  **未验**。
- **`reasoning.effort` 的回显不可信**：
  - terra：`low` / `xhigh` / `max` 原样回显，`reasoning_tokens` 46–64，summary 条目随 `summary:"auto"` 出现。
  - terra：**`effort:"none"` 回显 `medium`、`reasoning_tokens` 50**，单发与和 `temperature:0.5` 同发各一次，结果相同——这一档关不掉思考。
  - sol：不发 effort 回显 `medium`、有推理。**发 `max` 与发 `{effort:"medium", mode:"pro"}` 都回显 `effort:"none"`**、`reasoning_tokens: 0`，输出里多一条 `phase` 缺失、文本为一个空格的 `message`。
  - sol 发 `xhigh`：200，但响应**根本没有 `reasoning` / `text` / `temperature` 字段**，`input_tokens` 706（同题别的请求 37–111），`message` 无 `phase`，`reasoning_tokens: 0`；`high` 一次 240 s 超时。响应形状不同说明**同一档位背后不止一个上游**，每次请求落到哪个没法从请求侧决定。
  - 同一请求的输出正确，只是没推理——**这是本目录里第二条"不报错、只降质"的中转站行为**（第一条是注入系统提示）。
- **`reasoning.mode:"pro"` 回显 `standard`**（terra、sol 都是），与第八个样本 `[Pro]` 档一致。
  两台中转站、两档都不给 pro，**这个字段在中转站上验不了**。
- **`max_output_tokens: 16` 被无视**：terra 照常写完三段，`status: completed`，没有
  `incomplete`（第八个样本上这条是生效的）。本项目 Responses 路径本来就不发它，影响只在
  「截断」这条状态永远不会出现。
- **`include` 无关紧要**：`store:false` 时 reasoning 条目**不发 `include` 也自带
  `encrypted_content`**（1,356–1,484 字节），发了 `["reasoning.encrypted_content"]` 同样 200。
  所以「官方端点不发 `include` 就没有加密推理」这件事在中转站上**仍验不了**。
- **Chat 面是翻译出来的**：`reasoning_effort:"medium"` + `tools` 拿到 `tool_calls`（官方文档
  说 5.4 起不行）；`xhigh` 带回 39 字符的 `reasoning_content`（官方 ① 族没有这个字段）。
- **内置工具**（terra，Responses 面，只测与写作相关的；`image_generation` 报 403
  `Image generation is not enabled for this group`，`shell` / `local_shell` / `apply_patch` /
  `computer_use_preview` 不在本项目范围，结果不收）：

  | 工具 | 结果 |
  | --- | --- |
  | `web_search` | ✅ **可用但慢且贵**。一次回答里 5 个 `web_search_call`：`action.type` 为 `search`（带 `query`、`queries`、12–16 条 `sources`）或 `open_page`（只有 `url`）；答案带 `url_citation` 标注；`tool_usage.web_search.num_requests: 3`。**首个事件 54 s、总 112 s、`input_tokens` 45,712**（搜回的网页按输入计）。同样请求另一次在第 43 s 以 `response.failed`（`server_error` "overloaded"）结束——失败发生在已经搜过两次之后。非流式请求 180 s 超时 3/3 |
  | `web_search_preview` / 强制 `tool_choice:{type:"web_search"}` | 非流式 180 s 超时，未得结论 |
  | `code_interpreter`（`container:{type:"auto"}`） | **不稳定**：一次 400 `Unsupported tool type`，一次 HTTP 200 但 245 s 内零事件后断流。按不可用算 |
  | `file_search` / `mcp` | 400 `Unsupported tool type`（这一档没开） |
  | `tool_search` | 400 `tools.tool_search requires at least one deferred tool`——**端点认识它**，要求同时有延迟加载的函数工具 |
  | Chat 面 `web_search_options` | 200，**被静默忽略**：模型答"无法访问实时网页"，无 `annotations` |

- **上游不稳**：线路探针 27 条里 12 条在 150 s 处超时（非流式），分布无规律（同一字段换个
  值就过）；sol 比 terra 慢一个量级（同一题 51–76 s 对 5–15 s）。adapter 实测用流式，
  12 条里除 `max_output_tokens` 外全过。
- **sol 的 `input_file`（2026-09-14 补测，同一台、`[Plus]gpt-5.6-sol`，adapter 用例连跑 6 次）**：
  **4 过 2 败**，过的 3.4–9.6 s 读出 `PINEAPPLE`。两次失败形状不同：一次 3 s 内
  `response.failed`「Upstream request failed」（线路问题）；另一次 108 s 后**正常结束、答非所问**——
  「I'll locate the PDF, extract its text…」，即**文件没到模型手里，也不报错**。对照组同模型的
  `input_image` 2 次里 1 次 120 s 超时、纯文本 2 次全过。结合上面「同一档位背后不止一个上游」，
  判断是**部分上游丢 `input_file`**，不是 sol 不会读 PDF。对作者的影响：绑成 PDF 理解子代理时，
  偶发一次「模型说要去找文件」式的空答，重试即可；官方端点**未验**。
- 目录里的模型 id 带档位前缀（`[Plus]gpt-5.6-terra`），响应的 `model` 回显去掉前缀
  （`gpt-5.6-terra`）——按 id 前缀查表（`modelLimits` / `jsonMode`）的逻辑认不出带前缀的 id，
  与第八个样本一致。

### 第十一个样本：xAI Grok 的 ② 族（2026-09-14，官方端点实测 grok-4.5 / 4.6，另用 grok-4.3 做线路探针）

> **实测结论先于下面的文档对照表**（表是实测前按文档写的，⚠️/❌ 以这里为准）：
>
> - **adapter 实测**（`live.openai-responses.test.ts`，官方 `https://api.x.ai/v1`，按 `openai_responses_compat`）：
>   grok-4.5、grok-4.6 各 12 条**全过**——文本流、`response.completed` 带 usage、思考摘要、截断
>   （`max_output_tokens:16` → `incomplete`）、工具轮回传、强制 `tool_choice`、`json_schema`、`json_object`、
>   `input_image`、`input_file`。
> - **effort**：4.5 / 4.6 **拒 `none`**（400 `This model does not support \`reasoning_effort\` value \`none\``），
>   `low` / `medium` / `xhigh` 收，**默认回显 `high`**；`max` 在 4.3 / 4.5 / 4.6 都是 400 `Invalid reasoning effort.`。
>   4.5 发 `xhigh` 原样回显 `xhigh`（文档说按 `high` 处理，回显看不出）。4.3 收 `none`。
>   **本项目的「关闭」芯片在 4.5 / 4.6 上是 400**——越界由端点说话的规则下这是预期的，但作者没有
>   别的办法关掉思考，因为这两款根本关不掉。
> - **加密推理 ❌→✅**：不发 `include` 时 reasoning 条目**没有** `encrypted_content`（文档属实），发了 2,904 字节；
>   但**不带加密内容的原样回传，第二轮照样 200 且答对**（4.3 / 4.5 / 4.6 工具轮都过）。缺的只是往轮推理的延续。
> - **`input_file` ❌→✅**：`file_data` 里放 `data:` URL 与放纯 base64 **都读得出**（`PINEAPPLE`）。
> - **终止事件 ⚠️→✅**：流里有 `response.completed`（带完整 usage），另有 `[DONE]` 收尾；adapter 读到的用量正常。
> - **图片最小尺寸**：16×16 PNG 400 `Image has 256 total pixels (16x16), which is below the minimum of 512 pixels`；
>   1×1 400 `Both width and height must be at least 8 pixels`。32×32 通过。webp 未测（本机无编码器）。
> - **采样**：`temperature:0.5` 原样回显（默认回显 `0.7`）；推理模型上发 `frequency_penalty` **200 未报错**（文档说会报错）。
> - **`json_schema` 带 `strict:true`**：200，回显里 `strict` 被去掉，输出合 schema。
> - **`web_search`**（4.3）：200，`web_search_call` 的 `action.type` 是 `open_page`（`url`），答案带 `url_citation`；
>   usage 里 `server_side_tool_usage_details.web_search_calls: 1`，**一次搜索 6,851 输入 token**。本项目 P4 的
>   `open_page` 解析在这里正好用得上。
> - **tool search**：带 `defer_loading` 发，**403** `The tool_search tool and defer_loading are only available for alpha users`。
> - **usage 形状**：OpenAI 形 + `num_sources_used` / `num_server_side_tools_used` / `cost_in_usd_ticks` /
>   `context_details`；**`phase` 在 message 上缺失**（`null`）。4.6 同题输入 666 token、4.3 是 222——4.6 自带更长的系统前缀。
>
> **对本项目**：主路无需改 adapter。可做的两件小事：`ProviderDrawer` 加一条 `xAI (Grok)` 预设
> （`openai_responses_compat` + `https://api.x.ai/v1`）；思考类目的「关闭」在这两款上会 400，可在抽屉提示里点一句。

xAI 把 Responses 当成主路：迁移页称它是「推荐的交互方式」，对照表把 Chat Completions 标成
**Deprecated**（但仍作 legacy 端点提供，未给下线日期）；Anthropic SDK 兼容（`/v1/messages`）
「完全弃用」，未给日期。2026-05-15 下线了 `grok-4-1-fast-*` / `grok-4-fast-*` / `grok-4-0709` /
`grok-3`，旧 id 重定向到 `grok-4.3`（推理档 effort `low`、非推理 `none`）。现役文本模型：
`grok-4.6`（500K）、`grok-4.5`、`grok-4.3`、`grok-4.20-0309-reasoning` / `-non-reasoning`、
`grok-4.20-multi-agent-0309`、`grok-build-0.1`。

**接法**：`openai_responses_compat`，地址 `https://api.x.ai/v1`，Bearer。逐项对照本项目的
Responses adapter：

| 项 | xAI 文档 | 本项目现在发 / 读 | 结论 |
| --- | --- | --- | --- |
| `store` | 默认 `true`（存 30 天）；ZDR 下有状态模式不可用；发图时建议不存 | 恒 `store:false` | ✅ 正合适 |
| `instructions` | 支持；不能与 `previous_response_id` 同用 | 恒发，不用 `previous_response_id` | ✅ |
| `reasoning.effort` | 按模型：4.6 `low/medium/high(默认)/xhigh`；4.5 到 `high`（`xhigh` 当 `high`）；4.3 `none/low/medium/high`；不支持的值**报错**；multi-agent 上 effort 是 agent 数（4 / 16） | 菜单 `off/low/medium/high/xhigh/max` 不按型号裁剪 | ⚠️ `max` 与越界值由端点 400——与本项目「越界让端点说话」的规则一致；multi-agent 的语义完全不同，作者需知道 |
| `reasoning.summary` | 「仅为兼容保留」，恒 `detailed`；4.6 有摘要 | 随 effort 发 `auto` | ✅ |
| 加密推理 | **只在 `include:["reasoning.encrypted_content"]` 时返回** | 平台行 `responsesInclude` 声明，只对 xAI 发 | ✅（2026-09-19 起）。此前不发：回传的 reasoning 条目没有加密内容，第二轮照样 200，往轮推理静默断开。官方 OpenAI 是否同样要 `include` 仍未验（[`gpt56-plan.md`](gpt56-plan.md) P5），故不对它发 |
| 函数工具 | 扁平；`strict`「不支持，仅为兼容」（实际恒 strict）；≤350 个 | 扁平 + `strict:false` | ✅ 字段被忽略；**恒 strict** 意味着参数一定合 schema |
| `tool_choice` | 规格收扁平 `{type:"function", name}`；函数调用指南的表写的却是嵌套形——**文档自相矛盾** | 扁平 | ✅（按规格） |
| `text.format` | `json_schema` 的 `name` / `strict` 仅为兼容；含 `maxContains`/`minContains`/数组形 `items` 的 schema 400 | `json_schema` 不发 `strict`；`grok-*` 不在自动抬升表，默认 `json_object` | ✅ |
| `input_image` | data URL 或公网 URL，**只收 jpg/png**，≤20MiB | data URL | ⚠️ webp / gif 会被拒 |
| `input_file` | `file_id` / `file_url` / `file_data` 三选一；`file_data` 是**纯 base64**，需 `filename` | `file_data` 里是 **`data:` URL** | ✅ 实测 `data:` URL 与纯 base64 都读得出（见上）。模型抽屉的「PDF 文件输入」开关因此也对 ② 族开放（原先只在 ① 族显示） |
| 采样 | `presencePenalty` / `frequencyPenalty` / `stop` 对推理模型**报错**；另收非标准 `top_k` / `min_p` | 仅 Sakura 翻译任务设 `frequency_penalty` | ✅ 实际不会撞上 |
| `max_output_tokens` | 含推理 token，默认 128,000 | 不发 | ✅ |
| 流式事件 | 名字与 OpenAI 一致（text / reasoning summary / reasoning text / function args / `output_item`）；**`response.completed` / `incomplete` / `failed` / `error` 文档里都没写**；以 `data: [DONE]` 结束 | 读终止事件拿 usage 与停止原因；流读完没终止事件也会 `finish()` | ⚠️ 不会失败，但若真没有 `response.completed`，**用量记 0**、停止原因缺失。实测前不改 |
| usage | OpenAI 形；另有 `num_server_side_tools_used`、`server_side_tool_usage_details`、`cost_in_usd_ticks`；参考里有一处示例仍是 `prompt_tokens` 键 | 读 `input_tokens` / `output_tokens` / `cached_tokens` | ✅（按规格） |
| 内置工具 | `web_search`→`web_search_call`（$5/千次）、`x_search`→`x_search_call`、`code_interpreter`（别名 `code_execution`）、`file_search`（别名 `collections_search`）、`attachment_search`、`mcp`；`include` 可取 `web_search_call.action.sources` | compat 线上发 `{type:"web_search"}`、解析 `web_search_call` | ✅ 联网搜索大概率直接可用；`web_extractor` 与两个图片搜索是千问的名字，开了会被拒；`x_search` 没有建模 |
| tool search | 规格里有 `defer_loading` 与 `{type:"tool_search", execution:"server"}`，无文档页 | 未用 | 见 [`tool-search.md`](tool-search.md) |
| 明确不支持 | `background`、`metadata`、`truncation`；`context_management`「解析但未执行」；`logprobs` 在 4.20+ 静默忽略 | 都不发 | ✅ |

**小结**：主路（文本、思考、函数工具、强制 `tool_choice`、结构化输出、图片、联网搜索）按
文档应当直接可用；两处 ❌（加密推理的 `include`、`input_file` 的 base64）和一处 ⚠️（终止事件）
需要 xAI key 实测后再定。旧的 `openai_compat`（Chat Completions）配置仍可用，但已被标为弃用。

来源（2026-09-14）：`docs.x.ai` 的 `developers/model-capabilities/text/comparison`、
`legacy/chat-completions`、`rest-api-reference/inference/responses`、`…/inference/legacy`、
`model-capabilities/text/reasoning`、`images/understanding`、`tools/overview`、`pricing`、
`migration/may-15-retirement`、`models`，以及 `https://docs.x.ai/openapi.json`。

### 第十二个样本：火山方舟 Agent / Coding Plan（① ② ④ 三族，2026-09-18 实测 doubao-seed-2.0-lite / -mini / 2.1-turbo）

> **实测结论**（`live.volcengine.test.ts`，`SEEDDACE_KEY` 设为套餐 key，三条线路 39 条**全过**；平台画像 `volcengine-plan`）：
>
> - **两种 key，两条前缀，同一主机** `ark.cn-beijing.volces.com`：套餐 key 只在 `/api/plan` 下有效，
>   在按量的 `/api/v3` 上 401 `AuthenticationError`；反之亦然（按量 key 未实测，按文档）。因此画像分成
>   **两个平台**：`volcengine`（按量，`/api/v3`，Chat · Resp，按文档未实测）与 `volcengine-plan`
>   （套餐，`/api/plan/v3` Chat · Resp、`/api/plan` Anth，已实测）。`inferPlatform` 为此支持了带路径的
>   `hosts` 条目（最长前缀、段边界匹配）；抽屉里只填主机时保留作者选的那个（`platformForAddress`）。
> - **套餐前缀下没有的**：`/models`（① 族 `/api/plan/v3/models` 404；④ 族 `/v1/models`
>   对有效 key 回 **401**——误导性的）。**`/responses` 是有的**，在 `/api/plan/v3/responses`（200）——首轮探测
>   打在了没有 `/v3` 的路径上得了 404，据此把 ② 线路漏掉了，复核联网搜索文档时补回。连通测试因此改为：兼容端的模型列表回 404 / 401 / 403 都再发
>   一次空补全，由补全端点定论（错 key 在那里也是 401；造的模型 id 回 404 `UnsupportedModel`）。
> - **图片**：① `image_url`（data URL）与 ④ `image` 块三款都读得出（64² 纯色 → Teal，计 ~1,360 输入 token）。
> - **PDF**：① 的 `{type:"file", file:{file_data, filename}}`（本项目 `file` 片段原样）与 ④ 的 base64
>   `document` 块**都真读到了内容**（PELICAN 7342）——④ 族上读 PDF 的第一个实测样本（DeepSeek 的 ④ 面是
>   静默换成占位符，§2.1）。扁平的 `{type:"file", file_data}` 400 `missing messages.content.file`。
>   平台画像为此加了 `pdfFamilies`，`readsPdf` 改为按渠道的「平台 × 线路」回答。
> - **思考，① 面**：默认**开**（「用一句话说你好」想了 590 token）。`thinking:{type:"disabled"}` 关；
>   `reasoning_effort` 收 `none / minimal / low / medium / high / xhigh / max`，乱写 400 并列出参数名；
>   `minimal` 与 `none` 都是 0 推理。**`high` + `disabled` 同发 400**「Invalid combination of reasoning_effort
>   and thinking type」——所以新类目 `doubao` 的「关闭」只发开关，不带强度（与 `deepseek` 同一拼法），
>   菜单 `off / low / medium / high`（`medium` 是真的一档：同题 1,541 token，`max` 反而 136）。
>   推理从 `reasoning_content` 流出，`usage.completion_tokens_details.reasoning_tokens` 有数。
> - **思考，④ 面**：同样默认开；`thinking:{type:"disabled"}` 关，`adaptive` 与 `enabled+budget_tokens` 都收，
>   `output_config.effort` 不报错（效果未比）。thinking 块**没有 `signature`**，原样回传后工具轮第二轮照样 200。
>   （**2026-09-23 更正**：这只对 2.0 系成立；2.1-turbo 的 thinking 块带 `signature`，见下方补测「④ 的签名」。）
>   Claude 的两个类目关不掉它（`claude-budget` 不论档位都发 `enabled`，`off` 什么都不发 = 在想），所以加了
>   `doubao-switch`（adaptive / disabled，同 MiniMax 的拼法）；**强制 `tool_choice` 在思考开时照常可用**
>   （① `required` / 具名、④ `{type:"tool"}` 三种都 200），所以它不像 `minimax` 那样把强制降成 auto。
> - **思考，② 面**：同样默认开；`reasoning:{effort}` 收 `none` … `max` 全部七档，`none` 三款都是 0 推理——
>   `responses-effort` 类目原样可用（「关闭」发 `effort:"none"`）。也认顶层 `thinking:{type:"disabled"}`，本项目不用。
> - **工具**：① 函数调用、② 扁平 `function`（`strict:false`）、④ `tool_use` 都正常；带思考的工具轮三族都能走完
>   （① `reasoning_content`、② 整条 output item、④ thinking 块的回传都被接受）。① 的 `tool_choice`
>   `required` / 具名 / `none` 在思考开关两种状态下都 200（强制时推理 token 为 0，静默跳过思考）。
>   ① `response_format: json_schema`（strict）输出合 schema。
> - **服务端工具**：厂商「联网搜索工具」页只列 Responses 与 Messages 两种接口（Chat 没有）。④ 的 Anthropic 版本化
>   `web_search_20250305` + `max_uses` 三款都**真跑了**（`server_tool_use` + `web_search_tool_result`，结果带
>   `encrypted_content`、`url` 为空串；`usage.server_tool_use.web_search_requests` 计数）。② 的 `{type:"web_search"}`
>   三款都跑出 `web_search_call`；文档要求豆包搜索 Custom 版显式写 `sources:["doubao"]`，但套餐 key 上**不写也
>   记在 `doubao` 源下**（`usage.tool_usage_details.web_search.doubao`），所以本项目的拼法不用改 → ②④ 画像都记 `yes`，
>   ① 记无。按量 key 上不写 `sources` 可能落到需另开通、按次计费的「联网内容插件」，未实测，按量画像仍是 `unknown`。
> - **上限**：`max_tokens` 上限按模型：2.0-mini 两族都 ≤ 131,072（超了 400 并报上限），2.1-turbo 两族都收
>   262,144。起步模型的 `maxOutput` 照此填。上下文 256k（套餐概览页）。
> - **鉴权**：④ 面 `x-api-key` 与 `Authorization: Bearer` 都收。
> - **条款**：套餐概览页写明文本模型「不可用于 API 调用，在非 AI 工具中使用……可能被识别为滥用」。本应用是
>   AI 写作工具，属于其列；抽屉的平台提示条照实写了这一句。
>
> **对本项目**：adapter 一处没改（② 线路也是原样的 `openai_responses_compat`）。新增：两个平台画像、`doubao` / `doubao-switch` 两个思考类目、
> `pdfFamilies` 与 `wireReadsPdf`、三个起步模型（多模态 + PDF，Anth 线路停放 `doubao-switch`）、
> 连通测试在 401 时的二次确认、抽屉里的平台提示条（设计稿 05k TURN 2）。

> **补测（2026-09-23，同一把套餐 key；对照厂商「流式输出」「深度思考」「结构化输出(beta)」「文档理解」四页）**：
>
> - **思考摘要与加密原文，① 面**：2.1 系（及 seed-evolving、2.0-lite-260428 起）默认开「思考摘要」——`reasoning_content`
>   只是摘要，原始思维链加密在 `encrypted_content` 里。流式下它**整串出现在某一个 delta 上**
>   （`{"delta":{"reasoning_content":"\n","encrypted_content":"djEN…"}}`）。厂商要求工具轮把两者一起回传
>   （`encrypted_content` 优先；只回传摘要「推理效果下降」但不报错——上面 39 条全过正因如此）。此前 ① 适配器只收
>   `reasoning_content`；现在 `_reasoning.encrypted` 带上它和产出它的模型，同一模型才回传（换模型解不开）。
>   ② 不受影响：整条 reasoning output item 本来就原样回传，`encrypted_content` 默认就在。
>   密文只按模型 id 绑定（与 `_thinkingBlocks` / `_responseItems` 同一约定）：同一个 id 换了渠道（套餐 ↔ 按量 ↔ 中继）
>   再回传能否解密**未测**；厂商只说篡改过的密文「无法还原」，没说报不报错。
> - **usage**：① 末尾 `choices:[]` 的 chunk 带 `completion_tokens_details.reasoning_tokens`；② 是
>   `output_tokens_details.reasoning_tokens`。本项目两族都不读它（`completion_tokens` 已含，计费不受影响）。
> - **结构化输出的 strict 语义**：schema 让 `answer` 只能是 `7`，prompt 却要真实结果并多给一个 `reason` 字段——
>   只有真被约束才会守住。2.1-turbo：① `strict:true` 2/2 守住，① 不带 strict 1/2 越过；② 本项目的 `text.format`
>   （不带 `strict`）2/2 守住。2.0-lite：① strict 与 ② 都答了 `2` 加 `reason`（**不守 schema**）；2.0-mini：① 守住，
>   ② 值守住但多出字段。→ 套餐画像 ①② 的 `jsonSchema` 记实测 `yes`，`KNOWN_JSON_SCHEMA` 只收 2.1 系，2.0 仍停在
>   `json_object`（作者手动声明照发）。`strictify` 把可选字段写成 `type:["string","null"]` 并列入 `required`，①（strict）② 都收下（200，两键齐全）。
> - **PDF，② 面**：`input_file`（base64 `file_data` + `filename`）三款都读到 PELICAN 7342（`live.volcengine.test.ts`
>   三族同跑；上文只写了 ①④）。
> - **Files API**：套餐 key 用不了——见下一段 2026-09-23 复测（本条原写「`file_id` 与 `file_url`（仅 ②）只可能在按量
>   key 上用」，后半句被复测推翻：`file_url` 在套餐 ①②④ 都通）。
> - **思考开关**：厂商文档列出的模型只写 `enabled`（默认）/ `disabled`，没有一个列 `auto`，所以 `doubao` 类目不发
>   `thinking:{type:"enabled"|"auto"}` 不是缺口；`reasoning_effort` 七档对 2.x 的映射（xhigh / max → high，
>   minimal / none = 关）与 `off / low / medium / high` 菜单一致。

> **Files API 复测（2026-09-23，同一把套餐 key；对照厂商「文件输入(Files API)」页，2026.09.08 版）**：
>
> - **套餐前缀没有 Files API**：`/api/plan/v3/files`、`/api/plan/files`、`/api/plan/v1/files` 的 `GET`（列表）与
>   `POST`（multipart `purpose=user_data` + `file`）全 **404**，`/api/plan/v3/files/{id}` 的 `GET` / `DELETE` 也 404——
>   是路由不存在，不是鉴权失败。同一把 key 打按量的 `/api/v3/files`：**401** `AuthenticationError`，套餐 key 过不了
>   按量鉴权。厂商这页没提套餐；「接入视觉模型」页给 `/api/plan` 列的端点只有 chat / responses / images / 视频任务。
>   → 与百炼不同：火山的 Files API 只对按量 key 开放。
> - **`file_id` 字段在套餐对话端点是认的**：①（`{type:"file",file:{file_id}}`）② （`input_file.file_id`）给一个假 id
>   都回 **404 `ResourceNotFound`**「The specified resource file is not found」，不是字段错的 400——端点会去查，只是套餐
>   这边没有上传的入口。按量 key 上传的文件能不能被套餐 key 引用：**未测**（没有按量 key）。
>   ④ `document` 的 `source.type:"file"` 是 400，报错列出支持值 `base64` / `text` / `url` / `content`。
> - **`file_url` 三面都通**（公网 PDF，w3.org 的 `dummy.pdf`，2.1-turbo，思考关）：② `input_file.file_url`、
>   ① `{type:"file",file:{file_url}}`、④ `document` + `source:{type:"url",url}` 都 200 并答出首行「Dummy PDF file」。
>   厂商文档写 `file_url` **仅 ②**，① 实测也收。对本项目用处不大：作者的 PDF 在本地，公网 URL 无从谈起，
>   base64 内联仍是唯一实用的路。
> - **④ 的签名**：2.1-turbo 的 thinking 块带 `signature`（非流式在块上，流式走 `signature_delta`，`dj…` 开头，
>   与 ① 的 `encrypted_content` 前缀相同，推测是同一种密文）；2.0-mini / 2.0-lite 流式非流式都没有。上文「thinking 块没有
>   `signature`」只对 2.0 系成立。工具轮把第一轮 content 回传时，**原样、篡改末尾、删掉 `signature` 三种都 200**——
>   与 Anthropic 官方文档的口径（篡改即 400；本次未对官方端点复测）不同，回传错了不会响。`anthropic.ts` 本来就累加 `signature_delta` 并整块回传
>   `_thinkingBlocks`，不用改；删签名是否像 ① 那样让推理变差，未比。

来源（2026-09-18）：方舟控制台文档「文本生成」「图片理解」「文档理解」「联网搜索工具」「Function Calling」「Agent Plan 套餐概览」
（`console.volcengine.com/ark/region:cn-beijing/docs/ark/…`），与上面的实测。

### 第十三个样本：火山方舟 Seedream 出图（`ark` 出图接口，2026-09-18 实测 5.0 lite / 5.0 pro）

> **实测结论**（`live.volcengine-image.test.ts`，`SEEDREAM_IMAGE_KEY` 设为套餐 key，4 条全过，计费 2 张）：
>
> - **路径与 OpenAI 生成端点同形、body 不同**：`POST {base}/images/generations`，base 就是渠道 Chat 线路的
>   `…/api/v3`（按量）/ `…/api/plan/v3`（套餐）。`model` / `prompt` / `size` / `response_format` 同名同义；
>   **没有 `n`、`quality`**；参考图是 JSON 的 `image` 字段（一张字符串、多张数组，`data:image/<fmt>` 的 fmt
>   须小写），不是 `/images/edits` 的 multipart——所以配了一个新的出图接口值 `ark`，而不是 `images-api` 的开关。
> - **`watermark` 上游默认 `true`**（右下角「AI 生成」，照常计费）。adapter 恒发 `false`，排在 `extraBody` 之前，
>   作者要水印可以自己加回来。
> - **尺寸**：档位（`1K`…`4K`，**按版本不同**：5.0 pro 1K/1.5K/2K，5.0 lite 2K/3K/4K，4.5 2K/4K，4.0 1K/2K/4K）
>   或 `WxH`，不能混发。只发档位时比例由模型从提示词里猜，所以选了比例就发文档「档位 × 比例」表里的像素——
>   **查表不计算**：同是 2K 16:9，pro 是 2816x1584、lite 是 2848x1600；`WxH` 约束的是总像素（lite 下限
>   2560x1440）。实测 lite 按 `2848x1600` 回的字节正是 2848×1600，pro 改图按 `1248x832` 回的正是 1248×832。
> - **套餐 key 的模型**：`doubao-seedream-5.0-lite` / `-5.0-pro` 可用；按量文档里 lite 的正式 id
>   `doubao-seedream-5-0-260128` 回 404 `UnsupportedModel`。发一个非法 `size`（`1x1`）零成本区分：支持的模型
>   400（生成前就拒）、不支持的 404。
> - **响应**：`data[]` 每项 `b64_json`（或 24 小时的 `url`）+ `size`；组图里单项可以只有 `error{code,message}`
>   （审核不过），其余照常——整次失败只在一张都没有时（顶层 `error`）。`usage.output_tokens` = 像素/256 只是参考，
>   **按张计费**（`generated_images`），所以不当 token 用量上报。回显的 `model` 不带日期。
> - **耗时**：一张 26–43 s（Image AI Toolkits 同日实测），本次两张共 ~85 s。
>
> **对本项目**：`ImageRoute` 加 `ark`（永不作推导默认）、三个参数方言 `seedream-5-pro` / `-5-lite` / `-4`，
> 两个火山方舟平台各带两个 Seedream 起步模型（套餐用 `5.0` 拼写，按量用带日期的 id）。取舍见
> `docs/feature/image-generation-plan.md` PR7。协议事实的另一份（含 5.0 pro 图层拆分 / 透明背景）在
> Joycai Image AI Toolkits 的 `docs/api/volcengine-ark.md`。
>
> **2026-09-23 增补**（对照 09-22 版文档：新增 5.0 flash、透明背景两款都支持；套餐 key，**31 次零成本探测**
> + **4 张计费**——3 张 curl、1 张 live 用例）。**每个不支持的参数都在出图前 400**，报错文案点名字段，所以下面的
> 探测都不花钱：
>
> | 请求 | 回应 |
> | --- | --- |
> | 5.0 flash，三种拼法（`doubao-seedream-5.0-flash` / `-5-0-flash` / `-5-0-flash-260915`） | 404 `UnsupportedModel`——**flash 只在按量线路**；4.5 / 4.0 同样 404 |
> | pro 带日期 id `doubao-seedream-5-0-pro-260628` | 套餐也收（与 lite 不同） |
> | pro 11 张参考图 / lite 15 张 | 400「cannot exceed 10」/「cannot exceed 14」——数的是**全部输入图**，改图的源图也算 |
> | pro `sequential_image_generation:"auto"` / `stream:true` / `tools:[web_search]` | 各 400「is not supported by the current model」 |
> | lite `optimize_prompt_options.mode:"fast"` | 400「mode must be 'standard'」（fast 只 pro 收） |
> | `output_format:"webp"` | 400「must be one of: jpeg, png」 |
> | `background:"transparent"`，无图 / 两张图 | 400「transparent background requires exactly one input image」 |
> | 同上 + 一张 RGB PNG，或无 tRNS 的调色板 PNG | 400 `param:"image"`「requires a PNG input with at least one transparent pixel」 |
> | 同上 + RGBA PNG + `output_format:"jpeg"` | 400「must be png when background is transparent」 |
>
> **透明模式保的是「背景透明」，不是原图的形状**（pro，`background:"transparent"`，各 1 张）：
>
> - 透明底红色圆「改成蓝色」→ png，圆外依旧全透明 ✅（live 用例 `keeps a transparent PNG transparent` 复测一次）。
> - 透明底向右箭头「改成竖直向上」→ 箭头按新形状重画，新箭尖处（源图里透明）不透明、旧箭杆处变透明 ✅——
>   主体可以变形、换姿势。
> - 透明底红色圆「加上蓝天白云背景」→ 圆外**依旧全透明**，天空被画进了圆里 ❌——「要一个填满的背景」与这个
>   模式的承诺矛盾，模型折中成了在主体里画背景，照样计费。
>
> 响应 `data[]` 多了 `output_format:"png"`，`usage` 多了 `input_images:1`。
>
> **对本项目**：透明能力按 **ark 线路 + `seedream-5-pro` 方言** 推导（该方言恰好是 pro / flash）；改图工具的
> `keep_transparency` 由 agent 决定——结果要填满的背景时设 `false`；「没有透明像素」那条 400 免费，adapter 去掉
> 两个字段重试一次。按量平台加 5.0 flash 起步行（未实测）。取舍见 `docs/feature/image-generation-plan.md` PR7 的「09-23 增补」。

### 第十四个样本：智谱 BigModel 开放平台（① 族为主，② ④ 各探一次；2026-09-19 实测 glm-4.5-air / glm-4.7 / glm-5.3-flash）

> **实测结论**（先 curl 探形状，再用 `live.zhipu.test.ts` 驱动本项目真实 adapter，12 条**全过**；`GLM_KEY`，按量 key；平台画像 `zhipu`）：
>
> - **一台主机，四个前缀，一把 key 都通**：`open.bigmodel.cn` 下 ① `/api/paas/v4`（标准端点）、
>   ① `/api/coding/paas/v4`、④ `/api/anthropic`、② `/api/v1`。后三个是文档里 **GLM Coding Plan** 的「编程端点」，
>   同一把按量 key 在四处都回 200（④ 的 `/v1/models`、② 的 `/v1/models` 也都 200）。**key 不分两种**——
>   与火山方舟（两种 key 各自 401 在对方路径上，第十二个样本）相反：这里是**路径决定扣哪笔钱**，文档原话
>   「错误配置端点将导致无法使用 GLM Coding Plan 套餐额度」。套餐条款另有「仅限指定工具使用」「用于非支持
>   工具将被限制权益」，违规可封号——所以按量 key 走标准端点是唯一不踩条款的组合。
> - **`/models` 形状三样**：① 两个前缀是 OpenAI 的 `{object:"list", data:[{id,…}]}`（11 个 id，含
>   glm-4.5 … glm-5.3-flashx）；④ 是 Anthropic 的 `{data:[{id, display_name, created_at}]}`；
>   ② 的 `/api/v1/models` 却是 **Codex CLI 的模型目录**（`{models:[{slug, context_window,
>   supported_reasoning_levels, input_modalities, …}]}`，只列 glm-5.3 / 5.3-flash / 5-turbo 三个）。
> - **思考，① 面，三款三样**：
>   - **默认都开**（glm-4.5-air「用一句话说你好」想 180 字，4.7 想 261 token，5.3-flash 想 104 token）。
>   - **关**：`thinking:{type:"disabled"}`。4.5-air / 4.7 照关（0 推理）；**glm-5.3-flash 400**
>     `1210 该模型始终思考，不支持关闭思考；请使用 low、high 或 max。`
>   - **强度**：`reasoning_effort` **只在 5.3 代生效**，且只收 `low / high / max`；`medium` / `none` / 乱写
>     一律 400，**报的是同一句「不支持关闭思考」**——错误文案不指向出错的值。**glm-4.7 与 glm-4.5-air
>     对任何值（含 `none` 与乱写的 `bogus`）都 200 且照常思考**：字段被静默丢弃，没有档位可调。
>   - `reasoning_effort:"high"` + `thinking:{type:"disabled"}` 同发**不报错**（4.7 照关）——与豆包相反。
>   - 推理从 `reasoning_content` 流出；`usage.completion_tokens_details.reasoning_tokens` **4.7 / 5.3-flash
>     有、4.5-air 没有**（4.5-air 的推理算进 `completion_tokens`，无从拆分）。
>   - `thinking:{clear_thinking:false}`（缺 `type`）在三款上都 200——在千问转发时它在非 GLM 模型上 400，
>     智谱自家端点本来就是它的主场。
> - **工具，① 面**：函数调用三款都通；工具轮把 `reasoning_content` 原样回传 200（传与不传都 200，
>   传了 prompt 多计 ~38 token——交错思考用得上它，文档要求回传）。**`tool_choice` 文档写「默认且仅支持
>   `auto`」，实测三款三样**：
>
>   | | `required` | 具名 `{type:"function",…}` | `none` |
>   | --- | --- | --- | --- |
>   | glm-5.3-flash | 200，**不强制**（照常回答文本） | 200，**不强制** | 200，**照调工具**（被无视） |
>   | glm-4.7 | 200，**不强制** | 思考开时 **400** `1210 API 调用参数有误，请检查文档。`；关时 200 不强制 | 200，生效（不给工具） |
>   | glm-4.5-air | 200，**强制生效** | 200，**强制生效** | 200，生效 |
>
>   4.7 的 400 **不提 `tool_choice` 这几个字**——靠报错文案里的参数名认出「强制被拒」的办法在这里失效。
>   另有一次（约十分之一）4.7 在工具结果后回 `finish_reason:"stop"` + **空 content**，重试十次未复现。
> - **结构化输出**：`response_format` 文档只列 `text` / `json_object`。`json_object` 三款都出合法 JSON，
>   **不查提示词里有没有 "json" 字样**（与千问、DeepSeek 不同）。**`json_schema` 静默忽略**：200，回的是
>   包在 ```json 代码块里的文本，不合 schema——既不报错也不生效，是「看起来成功」的那种。
> - **流式**：`stream_options:{include_usage:true}` 收下不报错；usage 与 `finish_reason` 同在最后一块，
>   之后 `data: [DONE]`。`finish_reason` 除标准三个外还有 **`sensitive`**（内容审核拦截）、**`network_error`**
>   （推理异常）、`model_context_window_exceeded`——文档写明**流式中途失败不回错误码，只在 `finish_reason`
>   里说**。标准 `content_filter` 这个值它不用。
> - **错误通道**：HTTP 状态 + `{"error":{"code":"<业务码字符串>","message":"…"}}`。实测：模型名错 400 `1211`；
>   `temperature:1.5` 400 `1210 temperature参数非法：限制数值范围[0,1]`（**上限是 1**，不是 OpenAI 的 2）；
>   `max_tokens` 超上限 400 并报范围（4.5-air `[1,98304]`）；错 key **401 `{"code":"401","message":"令牌已过期或验证不正确"}`**；
>   流式请求的参数错也是非流式的 400（生成前就拒）。**未知顶层字段一律放过**（`foo_bar`、`frequency_penalty`、
>   `max_completion_tokens` 都 200）。
> - **多模态**：glm-5.3-flash 读得出 ① `image_url`（data URL，64² 纯色 → Teal）与 ① `{type:"file", file:{file_data, filename}}`
>   的 PDF（PELICAN 7342）——本项目的 `file` 片段原样可用（同一张青色图，默认强度答 Teal、`low` 答 Blue：看得见，辨色随强度浮动）。**文本模型收到非 text 片段直接 400**
>   `messages.content.type 参数非法，取值范围 ['text']`（4.7 / 4.5-air），不是静默丢图。5.3-flash 的图片
>   `prompt_tokens` 只计 ~50——计费口径与别家（~1,300）不同，不能拿 prompt 数判断图有没有送到。
> - **千问的两个视觉旋钮在这里是空操作**（2026-09-19 补测，glm-5.3-flash）：`vl_high_resolution_images:true` 收下、200，
>   3000² 的图开与不开都是 **7,938** 输入 token（`detail:"high"` 也一样）——既不报错也不起作用。① `video_url`
>   **读得出**（data URL mp4，3 秒先红后蓝 → 答「红、紫」/「红、紫、蓝」：看得见、辨色粗），但片段上的 `fps` 被无视：
>   0.5 与 2 都是 **367** token。所以「高分辨率读图」与「抽帧频率」归千问平台，不归 ① 族（`platforms.ts` 的
>   `qwenVisionParams`）；视频输入本身照常可用。
> - **联网搜索（① 面）**：是 `tools[]` 里的一项 `{type:"web_search", web_search:{enable, search_engine, …}}`，
>   不是顶层字段（千问是）。**默认开着「搜索意图识别」，意图不够就不搜——而模型照样回「根据联网搜索结果……」**
>   （4.5-air，prompt 22 token、响应无 `web_search` 字段：一次没搜，话术却说搜了）。`search_intent:false`
>   后三款都真搜：响应顶层多一个 `web_search[]`（标题 / 链接 / 摘要）。代价很重：`search_pro` 回 50 条、
>   **prompt 24k token**；`search_std` 10 条、6.7k（`count:3` 两个引擎都无视）。搜索另按次计费。
> - **② 面**（`/api/v1/responses`，只探两次）：推理是 `reasoning` output item，内容放在 **`content[].reasoning_text`**
>   而不是 `summary[]`（summary 是空数组）；`reasoning:{effort:"none"}` 在 4.5-air 上被无视（照想，
>   `reasoning_tokens` 却报 0）。
> - **④ 面**（`/api/anthropic`，只探两次）：glm-4.7 在这里**默认不思考**（只回 text 块），与 ① 面相反；
>   5.3-flash 回 `thinking` 块（无 `signature`）。`usage` 带 `server_tool_use.web_search_requests`。
> - **上限**（文档「核心参数」表，4.5-air 已实测）：5.x 与 4.6 / 4.7 默认 65,536、最大 131,072；4.5 系列最大 98,304；
>   4.6v 32,768；4.5v 16,384。上下文：5.3 / 5.3-flash / 5.2 1M，4.6–5.1 200K，4.5 系列 128K。
> - **耗时**：多数 0.3–10 s；4.7 偶有长尾（一次关思考的工具轮 136 s）。
>
> **逐模型校准**（这把 key 的 `/models` 列出的全部 11 个 id，同日实测；「强度」一列用一道需推理的应用题各档跑两次比
> `reasoning_tokens`，平凡题上各档差异淹没在噪声里）：
>
> | 模型 | `max_tokens` 上界 | 读图 | 默认思考 | `thinking:disabled` | `reasoning_effort` | 思考时具名强制 |
> | --- | --- | --- | --- | --- | --- | --- |
> | glm-5.3 | 131,072 | ✗ 400 | 开 | **400** | 只收 low/high/max，**真分档**（24–35 / 50 / 101–145） | 200，不强制 |
> | glm-5.3-flash | 131,072 | ✓ | 开 | **400** | 同上 | 200，不强制 |
> | glm-5.3-flashx | 131,072 | ✓（Teal） | 开 | **400** | 同上 | 200，不强制 |
> | glm-5.2 | 131,072 | ✗ | 开 | 关 | 七值都收、乱写 400；**`none` 关不掉**（与 `low` 同想 ~350）；`max` 多 ~35% | 200，不强制 |
> | glm-5.1 | 131,072 | ✗ | 开 | 关 | 乱写也 200——**无视** | 200，不强制 |
> | glm-5-turbo | 131,072 | ✗ | 开 | 关 | 乱写也 200——无视 | 200，不强制 |
> | glm-5 | 131,072 | ✗ | 开 | 关 | 乱写 400（文案是笼统的「参数有误」）；各档差异不稳定，按文档视为不支持 | 200，不强制 |
> | glm-4.7 | 131,072 | ✗ | 开 | 关 | 无视 | **400** |
> | glm-4.6 | 131,072 | ✗ | 开 | 关 | 无视 | **400** |
> | glm-4.5 | **131,072**（文档写 96K） | ✗ | 开 | 关 | 无视 | **400** |
> | glm-4.5-air | 98,304 | ✗ | 开 | 关 | 无视 | 200，**真强制** |
>
> 读图一列：文本模型收到 `image_url` 一律 400 `messages.content.type 参数非法，取值范围 ['text']`（生成前拒，不计费）。
> 5.3 代的 400 文案对所有非法值都说「不支持关闭思考」——连关思考时发的图片请求也报这句，不指向真正的原因。
> `reasoning_tokens` 在 glm-5 / 4.6 / 4.5 关思考时缺席（不是 0），其余模型给 0。上下文：5.3 / 5.3-flash(x) 1,048,576
> （`/api/v1/models` 与文档一致）、5-turbo 204,800（同上）、5.2 1M、5.1 / 5 / 4.7 / 4.6 200K、4.5 系列 128K（后几项按文档）。
>
> **独立工具端点**（同一把 key、同一个 `/api/paas/v4` 前缀，与对话无关，2026-09-19 实测）：
>
> - **网络搜索 `POST /web_search`**：body `{search_query, search_engine, search_intent, count?, search_domain_filter?,
>   search_recency_filter?, content_size?}`，前三个必填；回 `{search_intent:[{query, intent, keywords}], search_result:[{title,
>   content, link, media, icon, refer, publish_date}]}`，**没有 `usage`**（按次计费）。0.3–1.4 s。
>   - **这里 `search_intent` 默认 `false`**（意图恒为 `SEARCH_ALWAYS`）——与对话内 `web_search` 工具的默认（做意图识别）
>     正相反。设 `true` 时闲聊（「你好呀」）回 **0 条**、意图 `SEARCH_NONE`：没搜是看得见的，不像对话内那样被话术盖住。
>   - **`count` 四个引擎都无视**：`search_std` 回 ~10 条（`count:1` 也回 9 条），`search_pro` 与 `search_pro_sogou`
>     恒回 50 条（`count:3`、`count:20` 都一样），`search_pro_quark` 10 条。结果正文总量：std 8.7k 字、pro 32k 字，
>     `content_size:"high"` 把 std 抬到 13k 字。
>   - **过滤器按引擎部分生效**：`search_domain_filter` 在 `search_pro` / `search_pro_sogou` 上生效（15 条全在该域名），
>     在 `search_std` 上**无视**（38 条，杂站混入）；`search_recency_filter:"oneWeek"` 三个引擎都**无视**（照样出 2024 年的页面）。
>   - 超过文档的 70 字上限的查询不报错、照搜。引擎写错回 400 `1211 模型不存在`（引擎被当成模型）；缺引擎 400 `1214`。
> - **网页阅读 `POST /reader`**：body `{url, timeout?, no_cache?, return_format?, retain_images?, …}`；回
>   `{model:"web-reader", reader_result:{title, description, url, content, metadata, external}}`，同样无 `usage`。0.6–1.6 s。
>   - 默认 `markdown` 正文完整（tauri 文档页 3k 字，gov.cn 首页 5.7k 字含 47 张图的链接）。**`return_format:"text"` 是有损的**：
>     gov.cn 首页只剩 108 字的页脚。`retain_images:false` 与 `with_links_summary` 实测**无效果**（图链照旧）。
>   - **目标页 404 与主机不存在都回 500 `1234 网络错误，错误id：…，请稍后重试`**——分不出是页面不存在还是平台故障，且文案
>     劝人重试；非 URL 是 400 `1214 URL格式无效`。
>
> **对本项目**：见 [`zhipu-plan.md`](zhipu-plan.md)——哪些 adapter 原样可用、哪些是缺口、先做哪片。

来源（2026-09-19）：`docs.bigmodel.cn` 的「对话补全」（OpenAPI）「工具调用」「结构化输出」「流式消息」「思考模式」「深度思考」
「核心参数」「模型概览」「错误码」「GLM-5.3-Flash」「GLM Coding Plan 快速开始 / 接入工具 / 使用须知」「网络搜索」「网页阅读」各页的 `.md` 原文，与上面的实测。

### 第十五个样本：New API 中转站上 Kiro 渠道的 Claude（① ④ 两族，`[特价kiro量]claude-opus-4-6` / `-opus-5`，2026-09-23 实测）

> **实测结论**（先 curl 约 200 次探形状，再用 `live.relay-kiro.test.ts` 驱动本项目真实 adapter——④ `anthropic_compat` +
> `claude-adaptive`、① `openai_compat` + `openai-generic`，平台 `newapi`——31 条**全过**；`CHENMO_KEY`）。主机是第十个样本那台
> `42.240.165.241:3000`，走 `/v1/messages` 与 `/v1/chat/completions`；**没有 ② ③ 线路**（`/v1/responses`、`/v1beta` 都回 500
> `convert_request_failed`「not implemented」）。目录里 Kiro 渠道挂着 `[kiro]` `[kiro1]`…`[kiro3]` `[kiro-200k]` `[特价kiro量]` 等多档，
> `supported_endpoint_types` 一律 `null`。Kiro 是 AWS 的 IDE 产品，它的后端不是 Anthropic API——中转站在
> 两者之间翻译，**下面凡是「官方有、这里没有」的，都是翻译层没做，且几乎全部 200、不报错**。
>
> 两款模型在每一条上表现一致（同一请求的 usage 逐字相同、同一套模板文案），**从请求侧分不出背后是不是两个模型**。
>
> | 特性（官方写法） | 结果 |
> | --- | --- |
> | 基础对话、流式 | ✅ 2–10 s。流式事件序列完全标准（`message_start` → `ping` → block 三件套 → `message_delta` → `message_stop`），`thinking_delta` / `signature_delta` / `input_json_delta` 都有 |
> | 鉴权 | `x-api-key` 与 `Authorization: Bearer` 都收；**不带 `anthropic-version` 也 200** |
> | `system` | ✅ 生效。不像第八 / 十个样本那样注入大段系统提示（不带 system 的请求输入只报 70 token 上下） |
> | `max_tokens` | ❌ **无视**：发 8 / 16，照样写完 1–60，`stop_reason: end_turn`，永远不会出现 `max_tokens` |
> | `temperature` / `top_k` / `stop_sequences` | 都 200；`stop_sequences` 生效（`stop_reason: stop_sequence`），采样两项效果未比 |
> | `thinking: adaptive` / `enabled + budget_tokens` / `disabled` | ✅ 三种都照办。thinking 块带 `signature`（300–380 字符） |
> | `display: "summarized"` / `"omitted"` | 都无效果：**永远返回完整原文**，`omitted` 也不清空 |
> | `budget_tokens ≥ max_tokens` | 200（官方 400） |
> | `output_config.effort` | **只有 `low` 有效果**：同一道难题每档 3 次，输出 token 均值 low ≈ 750，medium / high / max 都 ≈ 1,050、分不出；简单题上 `low` 直接不想。**乱写的值（`bogus`）也 200**。不带 `thinking` 只发 effort = 不想（与官方 4.6 一致） |
> | 工具轮回传 thinking 块 | ✅；**签名不校验**：原样、篡改末尾、删掉 `signature` 三种都 200 且答对 |
> | 函数工具、`tool_choice: auto / none` | ✅ |
> | 强制 `tool_choice`（`any` / `{type:"tool"}`） | ❌ **流式下被无视**：每模型 × 思考开关 × 两种写法各 4 次，流式 32 次里 1 次调用（另一轮 adapter 实测关思考 6 次里 2 次，都像模型自己想调）；**非流式关思考 16/16 生效**，非流式开思考 `tool` 0/8、`any` 6/8。即翻译层只在非流式路径上实现了它。不报错，只是模型回了一段散文 |
> | `strict: true` 工具 | 200，照常调用（约束是否生效未验） |
> | 结构化输出 `output_config.format`（GA）与 `output_format` + beta 头 | ❌ 都 200、**都被静默忽略**：schema 把 `answer` 限死为 `7`，模型照答 `2` 并给 markdown |
> | 图片 base64 | ✅ 64² 纯色答出 Teal |
> | 图片 `source.type:"url"` | ❌ 静默丢弃（答 NOIMAGE） |
> | PDF `document` base64 / url | ❌ **静默丢弃**：模型答「没看到文档」；base64 那条要 33 s（别的请求 3 s） |
> | 纯文本 `document` + `citations.enabled` | 内容读到了，但**没有 `citations` 字段**，出处只是模型在正文里自己引 |
> | 服务端工具 `web_search_20250305` / `_20260209` | 见下一段——**中转站自己做**，行为取决于同发的工具和流式与否 |
> | `web_fetch_20250910` / `code_execution_20250825` / 造的 `type` | 全部静默丢弃，模型**假装**抓了页面、跑了代码（给出 `<h1>Example Domain</h1>`、一段没执行过的 Python） |
> | prompt caching（`cache_control`） | ❌ 同一 7.4k 前缀连发两次，**两次都报 `cache_creation_input_tokens: 7360`、`cache_read` 永远只有几十**——只写不读。若中转站按写缓存价计费，打断点比不打更贵 |
> | usage | **由中转站估算**：输入随内容增长（7.7k 前缀报 7,762），但缓存那两项是拼出来的——不带 `cache_control` 的请求也固定报几十 token 的 `cache_read`，流式的 `message_delta` 还报 `cache_creation: {ephemeral_5m_input_tokens: 265}` |
> | `/v1/messages/count_tokens` | 404 `Invalid URL` |
> | Files API `/v1/files` | 401 `Invalid token`（这把 key 没有这条路由） |
> | `/v1/models` | ① 族形状（`data[].id`），200 |
> | 不存在的模型 | 503 `model_not_found`「No available channel for model … under group default」（New API 的报法，不是 404） |
> | 模型回显 | 去掉档位前缀（`claude-opus-5`），与第十个样本一致 |
>
> **`web_search`：三种情形，三种结果**（都是中转站接管——Kiro 自己有联网搜索，由翻译层接上）：
>
> 1. **只挂 `web_search`、没有别的工具**（流式与否一样）：**整条请求被劫持**。中转站把**第一条** user 消息原文当搜索词
>    （多轮对话里搜的是开头的「Hi」），0.8–2 s 返回一段模板「I'll search for "…"」+ `server_tool_use` +
>    `web_search_tool_result`（`encrypted_content` 其实是明文摘要，`page_age` 为 null）+「Here are the search results for "…"」
>    列表。**模型根本没跑**：两款模型逐字相同，`output_tokens` 固定 644 / 568 / 478。请求里的写作指令得不到任何回答。
> 2. **与函数工具同发、流式**：✅ **真的在搜**。模型自己拟搜索词（「latest stable Rust version 2024」），结果带 `title` / `url` /
>    `page_age`，搜完接着思考、作答。本项目的 adapter 永远流式，agent 场景落在这一种。
> 3. **与函数工具同发、非流式**：`web_search` 被丢，模型说「我没有联网搜索工具，只有 get_weather」。
>
> **① Chat Completions 面**（New API 把它翻成 Messages 再发：`usage.billing_usage.source` 写着 `claude_messages`，
> 所以 ④ 面的缺口这里一样有，外加 ① 自己的几条）：
>
> | 特性 | 结果 |
> | --- | --- |
> | 基础对话、`system`、`stop`、流式（`stream_options.include_usage` 末块有 usage） | ✅ |
> | `max_tokens` / `max_completion_tokens` | ❌ 都无视 |
> | `reasoning_effort` | `low` / `medium` / `high` → 思考开，从 `reasoning_content` 流出（`completion_tokens_details.reasoning_tokens` 恒为 0，思考算在 `completion_tokens` 里）；**`max`、`none`、乱写的值 → 不想**。`openai-generic` 菜单的「最高」发的正是 `max`，在这里等于关。**（2026-09-23 更正：不是 Kiro 特有——同一台上 CC / anti / AWSb 渠道的 Claude 发 `max` 也都不想，是这台 New API 的 ①→④ 转换，见第十六个样本）** |
> | 顶层 `thinking`（`enabled + budget_tokens` / `adaptive`） | 静默忽略，不想 |
> | 函数工具、`tool_choice: none` | ✅ |
> | `tool_choice: required` / 具名 | 和 ④ 一样：**非流式生效**（拿「讲个笑话」也调用了 `get_weather`），**流式无视**（4 次 0 次调用；具名那条模型甚至复述「你要我调用 get_weather」，但没调用）。流式的 `prompt_tokens` 301，非流式 102，说明两条路径的转换不是同一套 |
>
> **强制 `tool_choice` 的复测（2026-09-23 晚些时候，同一模型 `[特价kiro量]claude-opus-5`，第十六个样本那一轮）**：带思考仍然 0 次调用
> （④ 非流式 4 次、流式 5 次）；**不带思考、流式**这次 5 次里 3 次调用（④），而上面第一轮是 16 次里 1 次——这一格随时间变，不能当成
> 稳定的「行」或「不行」。① 流式 `required` 5 次 0 次，但具名 2 次 2 次（上表第一轮具名是 0 次）。本项目的 `claude-adaptive` 总是带 `thinking`，落在稳定失败的那一格，所以「改发 `auto`」的判断不变。
> | `response_format`：`json_object` / `json_schema`（strict） | ❌ 都被忽略：答 ```` ```json ```` 代码块，键名自拟（`result` 而不是被 enum 锁死的 `answer: 7`）。**（2026-09-23 更正：四个渠道全一样，连 ④ 面真会执行 schema 的 AWSb 在 ① 面也被丢——是 New API 的转换，不是 Kiro，见第十六个样本）** |
> | `image_url`：data URL / http URL | data URL ✅；http URL 静默丢弃 |
> | `file` 片段（PDF） | ❌ 静默丢弃，33 s |
> | `web_search_options` | 转成 ④ 的 `web_search` 后**同样被劫持**：返回「Here are the search results for "…"」，模型没跑 |
>
> **对本项目**（能力表的「模型 id 轴」，见 [`capability-gating-plan.md`](capability-gating-plan.md) §8.10）：这台中转站自建、
> 没有可识别的主机，行为按上游渠道（id 里的 `kiro`）变，所以不写成平台画像，而是在 `newapi` / `custom` 两个平台上
> 加了一个**只点名**的模型格 `KIRO_CLAUDE`（id 同时含 `kiro` 与 `claude`，Sonnet 按推断一并收）。点到名的判「不发」，
> 同一台上别的模型照旧：
>
> | 线路 | 能力 | 改后 | 为什么 |
> | --- | --- | --- | --- |
> | Chat | `pdfInput` | 不发 | `file` 被丢，PDF 子代理不会选中这个模型 |
> | Chat | `forcedToolChoice` | 发 `auto` | 流式无视强制；结构化任务仍先试工具调用，没调用就退回 JSON |
> | Chat | `structuredOutput`（`jsonSchema` 随之） | JSON 模式降到 `off`，只发提示语 | `response_format` 被无视 |
> | Anth | `forcedToolChoice` | 发 `{type:"auto"}` | 同上；④ 适配器以前不查这一格，这次补上 |
> | Anth | `web_search` | 不发 | 本项目对不带工具的请求也发服务端工具，那种请求会被劫持成一页搜索结果。代价是 agent 场景里本来能用的真搜索（情形 2）也关了——同一个模型开关分不出两种场景 |
>
> 其余给作者的建议：
>
> - 思考：④ 选 `claude-adaptive`，只有「关闭」（发 `low`）会真变浅，其余几档等价；① 选 `openai-generic` 时**别选「最高」**
>   （发 `max` = 不想），低 / 中 / 高都在想。
> - `anthropic_compat` 本来就不发 `cache_control`（`cachesPrompt` 只对官方标准开），在这里恰好是对的：这台只写不读，
>   打了断点也换不来缓存命中。它报的 `cache_read` 是估算拼出来的，用量页上这部分的缓存价不可信。

### 第十六个样本：同一台 New API 上 Claude 的五个渠道——Kiro / CC / anti 反代与 AWSb 正向、官 key（① ④ 两族，2026-09-23 实测）

> **怎么测的**：同一把 key、同一台中转站（第十五个样本那台），同一套 curl 用例（`python3` 并发脚本，约 350 次请求），逐渠道打
> `/v1/messages` 与 `/v1/chat/completions`。随机性大的几项（强制工具、`effort`、结构化输出、难题上的思考）补跑 2–3 次。
> 渠道只体现在模型 id 的前缀里：
>
> | 前缀 | 测的模型 | 背后是什么 |
> | --- | --- | --- |
> | `[特价kiro量]` | `claude-opus-5`（对照组，第十五个样本） | Kiro（AWS 的 IDE）反代 |
> | `[CC量]` | `claude-opus-4-6`、`claude-opus-5` | 反代；前缀推测是 Claude Code 通道（未证实） |
> | `[anti量]` | `claude-opus-4-6` | 反代；前缀推测是 Antigravity（未证实） |
> | `[正向AWSb量]` / `[正向AWSb量1]` | `claude-opus-4-6` | 正向 AWS Bedrock——消息 id 以 `msg_bdrk_` 开头 |
> | `[官key量]` | `claude-opus-5` | 官方 key 正向。**本次没测到**：这一档 opus-5 / opus-4-6 / sonnet-5 两个端点全部 502 `Upstream request failed`，相隔十分钟四次都一样 |
>
> `[正向AWSb量1]claude-opus-5` 对这把 key 回 404「No available channel for this model on the current token」（同一档的 `opus-4-6` 通）；
> `[正向AWSb量]` 目录里没有 `opus-5`（503 `model_not_found`）。
>
> **④ Anthropic Messages 面**：
>
> | 特性 | Kiro | CC | anti | AWSb |
> | --- | --- | --- | --- | --- |
> | `max_tokens: 8` | ❌ 无视（`end_turn`，53 token） | ✅ `stop_reason: max_tokens` | ✅ | ✅ |
> | `thinking`（adaptive / enabled+budget） | ✅ | ✅；**opus-5 的 thinking 块文本恒为空**（带 `display:"summarized"`、难题上 765 输出 token 也空），opus-4-6 有文本 | ❌ **不想**：没有 thinking 块；`[anti量]claude-opus-4-6-thinking` 变体也一样 | ✅ |
> | `display: "omitted"` | 无视，照给全文 | ✅ 块在、文本空 | —（本来就不想） | ✅ 块在、文本空 |
> | `output_config.effort` 分档（同一道难题 low / max 输出 token，各 2–3 次） | 只有 low 有效果（第十五个样本） | 分不开（745–1,804 对 768–1,929） | 分不开（不想） | ✅ **真分档**：low 6 / 207，max 1,037–1,156 |
> | 参数校验：乱写 `effort`、思考时 `temperature: 0.3` | 都 200 | 都 200 | 都 200 | 都 400，报错与官方同文（`Input should be 'low', 'medium', 'high' or 'max'`；`temperature may only be set to 1 when thinking is enabled`） |
> | `budget_tokens ≥ max_tokens` | 200 | 200 | 200 | 200 |
> | 工具轮回传篡改过的 `signature` | 200（不校验） | 200（不校验） | —（第一轮没调用工具） | ✅ 400 `Invalid signature in thinking block` |
> | 强制 `tool_choice`，不带思考（非流式 / 流式，每格 4–8 次） | 全调用 / 5 次 3 次（见第十五个样本复测） | 全调用 / 全调用 | **全不调用** / 全不调用 | 全调用 / 全调用 |
> | 强制 `tool_choice`，带 adaptive 思考 | 0 次（非流式 4、流式 5） | 非流式 3/8、流式 4/8——**时好时坏** | 0 次 | ✅ 全调用（与本项目「adaptive 支持强制」的假设一致） |
> | `output_config.format`（json_schema，schema 与 prompt 相冲） | ❌ 无视 | **opus-4-6 无视（散文）、opus-5 执行**（各 2/2） | ❌ 无视 | ✅ 执行 |
> | 图片 base64 / URL | ✅ / 丢 | ✅ / 丢 | ✅ / 500 `failed to decode base64 data` | ✅ / 400 `URL sources are not supported` |
> | PDF `document` base64 | ❌ 丢（33 s） | ✅ | ❌ 丢 | ✅（30 s） |
> | 纯文本 `document` + `citations` | 读到，无 citations | 读到，无 citations | ❌ **没读到** | ✅ 有 citations |
> | `web_search_20250305` 单挂 | ❌ 劫持（第十五个样本） | ✅ 真搜：要求搜就搜（`server_tool_use` + 结果块，`usage.server_tool_use.web_search_requests: 1`）；改写句子的请求不触发搜索、不劫持 | 丢：模型凭记忆答（「As of my latest information (July 2025)…」） | ❌ 400 `Input tag 'web_search_20250305' … does not match` |
> | `web_search` 与函数工具同发（流式） | ✅ 真搜 | ✅ 真搜 | 丢 | ❌ 400 |
> | `web_fetch_20250910` | 丢，模型假装抓了 | ✅ 有 `server_tool_use` 块 | 丢 | ❌ 400 |
> | `code_execution_20250825` | 丢，模型假装跑了 | 丢，没有块 | 丢 | ❌ 400 |
> | `cache_control`（7–17k 前缀连发两次） | 只写不读（假的） | ✅ 第二次 `cache_read` = 前缀 | ❌ 没有缓存字段，两次都按全价输入 | ✅ 第二次命中 |
> | 「Say OK.」的输入 token（不带 system） | 7 + 拼出来的缓存段 | 9–10 | **39**——约 30 token 的注入 | 10 |
> | `/v1/messages/count_tokens` | 404（这台中转站没有这条路由，五个渠道都一样） | ← | ← | ← |
>
> **① Chat Completions 面**（New API 先转成 ④ 再发，所以 ④ 的渠道差异在这里重演，外加转换本身的两条）：
>
> | 特性 | Kiro | CC | anti | AWSb |
> | --- | --- | --- | --- | --- |
> | `max_tokens: 8` | ❌ 无视 | ✅ `finish_reason: length` | ❌ 无视（209 token）——④ 面上它是生效的 | ✅ |
> | `reasoning_effort` low / high（难题） | ✅ 有 `reasoning_content` | opus-4-6 ✅；**opus-5 无**（同 ④ 面的空文本） | ❌ | ✅ |
> | `reasoning_effort` `max` / `none` | **四个渠道全部不想** | ← | ← | ← |
> | 顶层 `thinking` | 四个渠道全部忽略 | ← | ← | ← |
> | `response_format`（`json_object` / strict `json_schema`） | **四个渠道全部无视**：代码块 + 自拟键名。AWSb 在 ④ 面会执行 schema，这里也被丢 | ← | ← | ← |
> | 强制 `tool_choice`（`required` / 具名；非流式 / 流式） | ✅ / `required` 0/5、具名 2/2 | ✅ / ✅ | ❌ / ❌（非流式 5 次 1 次、流式 5 次 0 次） | ✅ / ✅ |
> | `image_url` data / http | ✅ / 丢 | ✅ / 丢 | ✅ / 丢 | ✅ / 400 |
> | `file`（PDF） | ❌ 丢 | ✅ | ❌ 丢 | ✅ |
> | `web_search_options` | ❌ 劫持 | ✅ 答案引了搜索结果 | 无效（答 NOWEB） | ❌ 400 |
>
> **结论**：
>
> 1. **支持什么，由渠道决定，不由模型或协议决定。**同一个 `claude-opus-4-6`，CC 与 AWSb 上 PDF、缓存、强制工具都真的生效，
>    anti 与 Kiro 上都被丢。每个渠道是一种「阉割法」：
>    - **CC 反代**最接近官方 Claude：服务端工具（搜索、网页抓取）、PDF、缓存都是真的；但不做任何参数校验、签名不校验，
>      opus-5 的思考文本拿不到，强制工具带思考时时好时坏。
>    - **AWSb 正向（Bedrock）**校验与报错和官方一样严，`effort` 真分档，结构化输出与 citations 生效；**但没有任何服务端工具**
>      （Bedrock 本身不提供），URL 图片 400，PDF 慢。
>    - **Kiro 反代**：思考可用，其余大多被丢，`web_search` 单挂会被劫持（第十五个样本）。
>    - **anti 反代**：**不会思考**（`-thinking` 变体也不），强制工具无效，PDF 与文本文档都被丢，无缓存，还注入约 30 token 提示。
> 2. **有两条是这台 New API 的 ①→④ 转换，与渠道无关**：① 面 `response_format` 被丢、`reasoning_effort: "max"` / `"none"` = 不想。
>    所以同一台中转站上，**所有 Claude 走 ① 面都拿不到原生 JSON 模式**——第十五个样本把这两条记成 Kiro 特有，是只测了一个渠道的误判。
> 3. **「反代」与「正向」的分界是可观测的**：正向渠道带官方的参数校验与报错原文、签名校验、消息 id 前缀（`msg_bdrk_`）；反代渠道
>    对乱写的参数一律 200。想知道一个没见过的渠道是哪一类，发一个 `output_config.effort: "bogus"` 最便宜。
> 4. 两款模型（opus-4-6 / opus-5）在同一渠道上多数项一致，但**不是全部**：CC 上结构化输出只有 opus-5 执行、思考文本只有 opus-4-6 有。
>    按渠道点名时仍要留意模型差异。
>
> **对本项目**：本样本只记事实，应用侧还没改。PR #685 的 `KIRO_CLAUDE` 名单只点了 Kiro；按这里的数据，① 面的 `structuredOutput`
> 应当扩到这台中转站上的所有 Claude，anti / AWSb / CC 也各有要点名的格子。怎么改、为什么还没改，见
> [`issues/relay-claude-channel-gating.md`](../issues/relay-claude-channel-gating.md)。
>
> **后续（2026-09-23 同日）**：应用侧已按上游落地——作者在中转站渠道上配「前缀 → 上游」，内置 kiro / cc / anti / bedrock / official
> 五种画像，每格取自本样本与第十五个样本（[`capability-gating-plan.md`](capability-gating-plan.md) §8.11）。转换层那两条仍未进表。

### 第十七个样本：同一台 New API 上 GPT-5.6-sol 的四个上游——`[特价Pro]` / `[Plus]` / `[Pro]` 与 `[Azure]`（② ① 两族，2026-09-24 实测）

> **怎么测的**：还是第十、十五、十六个样本那台 `42.240.165.241:3000`，同一把 `CHENMO_KEY`。先用 `python3` 并发脚本打 curl 形状的请求
> （约 560 次，② `/v1/responses` 与 ① `/v1/chat/completions` 各一套，默认流式），随机性大的几项（结构化输出、力度、温度、强制工具、
> 缓存、图片 URL、创作请求）补跑 3–4 次；再用 `live.openai-responses.test.ts` 驱动本项目真实的 ② 适配器
> （`openai_responses_compat`）四档各跑一轮：**45 条过 41 条**，4 条失败都在下面的表里（三档无视 `max_output_tokens`、`[Pro]` 丢 `json_schema`）。
>
> | 前缀 | 测的模型 | 背后是什么（按可观测的特征推断） |
> | --- | --- | --- |
> | `[特价Pro]` | `gpt-5.6-sol` | ChatGPT 账号池（Codex 后端）：不发 `instructions` 时会被注入 Codex / 「coding assistant」提示，`usage` 带 `attribution` |
> | `[Plus]` | `gpt-5.6-sol` | 同上，Plus 账号 |
> | `[Pro]` | `gpt-5.6-sol` | 同上，Pro 账号；**参数校验与官方同文**（乱写 `effort` 回 400 `Invalid value: 'bogus'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'.`） |
> | `[Azure]` | **`gpt-5.6-terra`（替身）** | 名字叫 Azure，**实际是一个带「只准做 OpenAI 相关工作」护栏的网关**（见下文「`[Azure]` 的护栏」）。`[Azure]gpt-5.6-sol` 目录里有，但两次相隔 10 分钟都回 503 `No available channel for model gpt-5.6-sol under group 【官】az-gpt官`——这一档没有 sol 的线路，同档 terra / luna 可用，所以用 terra 顶替。**这一列比的是上游，不是模型** |
>
> 目录（`GET /v1/models`）对 `[Plus]` / `[Pro]` / `[特价Pro]` 声明 `supported_endpoint_types` 含 `anthropic` / `gemini`，但这把 key 打
> `/v1/messages` 回 `This group does not allow Anthropic Messages requests`——**目录声明的端点类型不等于这把 key 能用**。`[Azure]` / `[官key]` / `[AWSb]`
> 只声明 `openai`；`[官key]gpt-5.6-sol` 与 `[AWSb]gpt-5.6-sol` 同样 503「No available channel」。
>
> **② Responses 面**（`/v1/responses`）：
>
> | 特性 | 特价Pro | Plus | Pro | Azure（terra） |
> | --- | --- | --- | --- | --- |
> | 基础对话、流式事件序列 | ✅ 标准；但时快时慢（同一个 `temperature` 请求三次 6.6 / 9.7 / 62 s；另一道难题 xhigh 三次里一次 212 s 超时） | ✅ | ✅ 最快（2–8 s） | ✅ |
> | 带 `instructions` 时的输入 token（「Say OK.」） | 19（不注入） | 19 | 19 | **1,209**——网关在 `instructions` 后面追加约 1.2K token 的护栏，响应的 `instructions` 字段原样回显 |
> | 不带 `instructions` | 时有时无：「Say OK.」3 次都不注入（9）；创作题 2 次都多出 11 token（回显「You are a helpful coding assistant…」） | **4,389**：注入 Codex 提示（`usage.attribution.request_fields.instructions.input_tokens: 4380`），与第八、十个样本同一条 | 9（不注入） | 9（不注入，护栏也不加） |
> | `reasoning.effort` 各档回显 | 原样（`none` 除外） | 原样（`none` 除外） | 原样（`none` 除外） | 原样（`none` 除外） |
> | `effort: "none"` | **关不掉**：回显 `medium`，照样推理（四档一致，与第十个样本 terra 一致） | ← | ← | ← |
> | `effort` 真分档？（同一道数论题各 3 次，`reasoning_tokens` low / xhigh） | ✅ 295–428 / 583–588 | ✅ 197–237 / 344–356 | ✅ 170–200 / 259–349 | 弱：131–155 / 163–245 |
> | `effort: "max"` | ✅ 回显 `max`、有推理——第十个样本里 sol 发 `max` 回显 `none` 的现象**这次没出现** | ✅ | ✅ | ✅ |
> | 乱写 `effort` | 流式 `response.failed`（`upstream_error`） | 502 `Upstream request failed` | ✅ 400，官方原文 | 500 `Upstream gateway error` |
> | `reasoning.mode: "pro"` | 回显 `standard` | 回显 `standard` | 回显 `standard` | **回显 `pro`**，输入 6,445（同题别的请求 1.2K，只测 1 次） |
> | `temperature: 0.5` | 200，回显 `1.0`（静默改写） | ← | ← | **500 `Upstream gateway error`**（6/6；`temperature: 1` 则 200）——只要不是 1 就整条失败 |
> | `max_output_tokens: 16` | ❌ 无视 | ❌ 无视 | ❌ 无视 | ✅ `status: incomplete`、`incomplete_details.reason: max_output_tokens` |
> | `text.verbosity` low / high（同题输出 token） | ✅ 106 / 244 | ✅ 85 / 174 | ✅ 53 / 79 | ✅ 136 / 176 |
> | `text.format: json_schema`（schema 把 `answer` 锁成 7，省略 `strict` 与显式 `strict: true` 各 4 次） | ✅ 执行 | ✅ 执行（第八个样本那条「显式 `strict` 就被丢」**这次没出现**） | ❌ **两种写法都被丢**：回显 `{type:"text"}`，模型答 `{"answer":2}` | ✅ 执行 |
> | `text.format: json_object` | ✅ | ✅ | 回显 `text`，碰巧输出 JSON | ✅ |
> | 函数工具 `auto` / 强制具名 / `required`（effort `medium`，流式与非流式） | ✅ 全调用 | ✅ | ✅ | ✅ |
> | `input_image` data URL | ✅ | ✅ | ✅ | ✅ |
> | `input_image` http URL | ✅（raw.githubusercontent 上的图 3/3）；拒爬虫的主机（维基共享资源回 403）时，流里一个 `error` 事件后接空答 | ✅ 3/3 | ✅ 3/3；拒爬虫的主机回 400 `Error while downloading file` | ✅ 3/3；拒爬虫的主机回 **500 `count_token_failed`**——中转站为了算 token **自己先下载一遍**，下载失败整条失败 |
> | `input_file` PDF：`file_data` / `file_url` | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ |
> | 内置 `web_search`（单挂 / 与函数工具同发） | ✅ 真搜：1 次 `web_search_call` + `url_citation`，6–10 s，输入 8.5–14K（搜回的网页按输入计）——比第十个样本（112 s）快一个量级 | ✅ | ✅ | ❌ **静默丢弃**：没有 `web_search_call`，模型答「I can't perform a live web search」 |
> | `code_interpreter` | 流式 `response.failed` | 502 | 400 `Unsupported tool type` | 500 |
> | `file_search` | 流式 `response.failed` | 502 | 400 `Unsupported tool type` | 500 |
> | `image_generation` | 403 `Image generation is not enabled for this group` | 403 | 403 | ✅ **能出图**：83 s，`image_generation_call` 带 911K 字符的 base64 |
> | `store: true` | 200 | 200 | 200 | 500 |
> | 前缀缓存（同一 10K 前缀连发） | ✅ 第二次起 `cached_tokens` 9,984 | ✅ 9,984 | ✅ 9,984 | ✅ 11,576（多出的是护栏） |
> | 未知顶层键 | 200 | 200 | 200 | 200 |
>
> **① Chat Completions 面**（`/v1/chat/completions`；四档的响应 `id` 都是 `resp_…`、流里有 `reasoning_content`——New API 把 ① 翻成 ② 再发，与第八、十个样本一致）：
>
> | 特性 | 特价Pro | Plus | Pro | Azure（terra） |
> | --- | --- | --- | --- | --- |
> | 带 system 消息时的输入 token（「Say OK.」） | **4,397**（注入 Codex 提示，多数请求） | **4,395**（注入，3/3） | 19——但**带具名 `tool_choice` 的请求 4,434**（也注入；`auto` / `required` 的 58–59 不注入） | 19 |
> | 不带 system 消息 | 4,389（注入） | 20 | 9 | 9 |
> | 注入还有别的尺寸 | 同一档里还见过 +296 token（`file` / `verbosity` 那几条）与 **+17K**（10K 前缀的缓存题报 27,440） | — | — | — |
> | `reasoning_effort` low / high / xhigh / max | ✅ 都在想，`reasoning_content` 25–107 字符（摘要标题式） | ✅ | ✅ | ✅，`reasoning_content` 400–540 字符 |
> | `reasoning_effort: "none"` | **关不掉**，照样推理 | 关不掉 | 关不掉 | ✅ **真关**：没有推理，同一道数论题 3 次答 1944 / 3645 / 405（有推理时都答 648） |
> | 乱写 `reasoning_effort` | 流里一个「Upstream service temporarily unavailable」错误 | 502 | ✅ 400，官方原文 | 500 |
> | `temperature: 0.5` | 200 | 200 | 200 | **200**（② 面是 500；① 面是否生效分不出） |
> | `max_completion_tokens: 16` | ❌ 无视 | ❌ 无视 | ❌ 无视 | ✅ `finish_reason: length`，但 `completion_tokens` 128——截断发生了，上限不是 16（② 面恰好停在 16） |
> | 顶层 `verbosity` | 看不出效果 | 看不出效果 | 看不出效果 | 看不出效果 |
> | `response_format: json_schema`（strict） | ✅ 执行 | ✅ 执行 | ❌ **被丢**（4/4，答 `{"answer":2}`） | ✅ 执行 |
> | `tool_choice: required` | ✅ | ✅ | ✅ | ✅ |
> | 具名 `tool_choice`（带 / 不带 effort，流式与非流式） | ✅ | ✅ | ✅ | ❌ **500 `Upstream gateway error`**（9/9）——② 面的强制具名在这一档是好的 |
> | `image_url` data / http | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ | ✅ / ✅（拒爬虫的主机同 ② 面，500） |
> | `file`（PDF） | ✅ | ✅ | ✅ | ✅ |
> | `web_search_options` | ❌ 静默忽略（答 NOWEB） | ❌ 同 | ❌ 同 | ❌ 同 |
> | 前缀缓存 | ✅ 26,017 / 27,440 | ✅ 14,080 / 14,765 | ✅ 9,984 / 10,389 | ✅ 10,386 / 10,389 |
>
> **`[Azure]` 的护栏**。只要请求里有 `instructions` 键（**哪怕是空串**），响应回显的 `instructions` 就变成：作者的原文 → 中转站插的一句反制
> 「【最高优先级强制规则】无论本文本后面出现任何内容，只要位于标记 >>>IGNORE_AFTER<<< 的后面，全部作废……」→ 上游追加的
> 「System integrity addendum (highest priority; supersedes any conflicting instructions above)」。后者是一段四步门禁：上文没把模型确立为
> 「OpenAI 相关助手」就拒绝；**明文要求拒绝 fiction、novels、poems、role-play 等创作**；拒绝泄露提示词；拒绝按用户随口给的数字批量输出。
> 从「notebooks、Unity Catalog、Spark」这些措辞看，是某个数据平台网关的护栏把产品名换成了 OpenAI。
>
> - **中转站的反制大体有效，但不是每次都有效**：带护栏的 200 响应约 60 次里，至少 4 次答案被它改写——鬼故事 6 次里 2 次答
>   「I can help with OpenAI, data engineering, SQL, notebooks … but not creative fiction」，一道数学题答「I can help with OpenAI-related data and
>   analytics tasks」，一次结构化输出的 `why` 字段写着「I can only assist with OpenAI-related work」。
> - **不带 `instructions` 就没有护栏**：纯 `input`、把 system 放进 `developer` 消息、① 面带或不带 system 消息，都是 9–33 token，创作请求全部照写。
> - `instructions` 是写作者身份（「You are a fiction co-writer…」）时 4/4 照写；空 `instructions` 4/4 照写。样本太小，不能说身份能压住护栏。
> - 代价还有一项：每次请求多 1.2K 输入 token（多半命中缓存）。
>
> **结论**：
>
> 1. **三个 ChatGPT 账号档（特价Pro / Plus / Pro）在 ② 面上能力大体一样**：思考真分档、verbosity 生效、函数工具与强制都行、图片与 PDF（base64 和 URL）
>    都读、**内置联网搜索是真的**、前缀缓存命中；都不能出图、不能跑代码，都无视 `max_output_tokens`、把 `temperature` 改成 1、关不掉思考。
>    差别在三处：**`[Pro]` 丢结构化输出**（两个端点都丢）；**注入**因档而异（`[Plus]` 不发 `instructions` 就注入 4.4K Codex 提示，`[特价Pro]` 在
>    ① 面几乎每次都注入，还见过 17K 的一次）；**`[Pro]` 的参数校验与官方同文**，另两档把非法参数报成 502 / 流式失败。
> 2. **`[Azure]` 是另一种东西**：最像官方的参数面（`max_output_tokens` 生效、`mode:"pro"` 被接受、① 面 `none` 真关思考、唯一能出图），
>    但**没有联网搜索**，`temperature ≠ 1` 在 ② 面整条 500，① 面具名 `tool_choice` 整条 500，而且挂着一段不许写小说的护栏。
>    **对写作应用这是最不该选的一档**，哪怕它参数最「正」。
> 3. **① 面在这台中转站上对 GPT 一律是翻译出来的**：`web_search_options` 四档全部静默忽略，联网只能走 ② 面的 `web_search`；
>    `reasoning_effort: "none"` 只在 `[Azure]` 生效。要用 GPT-5.6 的内置工具，协议选 Responses。
> 4. **同一档位背后仍不止一个账号**（第十个样本的结论不变）：`[特价Pro]` 同一请求的注入量有 0 / 11 / 296 / 4.4K / 17K 五种，延迟从 3 s 到超时。
> 5. 两条旧结论被这次推翻或未复现，**都要按「当时当档」理解**：第八个样本 `[Pro]` 的「显式 `strict:true` 才丢 format」——这次是**不论写不写 strict 都丢**
>    （换了一台主机、一个时间）；第十个样本 sol 的「发 `max` 回显 `none`」——这次四档都正常。
> 6. 新字段：ChatGPT 账号档的 `usage` 带 `attribution`（按输出条目与 `request_fields.instructions` 分别计 token）和
>    `input_tokens_details.cache_write_tokens`。**`attribution.request_fields.instructions.input_tokens` 是判断「被注入了多少」最直接的读数**
>    （作者发 10 token、回报 4,380 就是被注入了）；`[Azure]` 没有这个字段，它的护栏只能从回显的 `instructions` 看出来。
>
> **对本项目**（2026-09-24 同日落地，[`capability-gating-plan.md`](capability-gating-plan.md) §8.12）：上游画像加了 `codex`（ChatGPT 账号池，
> 对应三个账号档）与 `azure`（网关）两种，作用域 `/gpt/`，作者在渠道的前缀表里把 `[Plus]` / `[Pro]` / `[特价Pro]` 配成 codex、
> `[Azure]` 配成 azure 即可：
>
> - `[Azure]` 的护栏：新能力 `instructionsField` 在 azure 上判不收，`responses.ts` 把系统提示改成开头的 `developer` 消息、不发
>   `instructions`。其余上游照旧总发 `instructions`（挡 Codex 注入）。
> - Responses 上的温度在两种上游下都不发（一个改成 1，一个 500）；azure 的联网搜索不发、① 面强制工具改发 `auto`。
> - `[Pro]` 丢结构化输出**没进格子**（与另两档不一致），只写在模型抽屉的上游说明里；这一档发出去的 JSON 模式
>   （自动档在中转站上是 `json_object`，作者手选 json_schema 时是 json_schema）会被丢，结构化任务退回提示语。

### 第十八个样本：OrcaRouter 付费模型——三家官方协议经一台网关（①②③④ 四面，2026-09-26 实测 GPT-6 / GPT-5.6-terra / Claude Sonnet 5 · Opus 5.5 · Fable 5.1 / Gemini 3.8 Flash）

> **怎么测的**：第七个样本那台 `api.orcarouter.ai`，这次是有余额的 key（`ORCA_KEY`）。先 curl 约 120 次看形状
> （四面各自的非流 / 流、思考档位、工具往返与回灌变体、缓存、服务端工具、结构化输出、图片、计数端点、错误），
> 再用 `src/lib/ai/__tests__/live.orcarouter.test.ts` 驱动本项目真实的四个适配器（`openai_compat` /
> `openai_responses_compat` / `anthropic_compat` / `gemini_compat`，即 `orcarouter` preset 的四行）：修复前
> **28 条过 23 条**，修复后 **28 条全过**。方案与逐项结论在 [`orcarouter-probe-plan.md`](orcarouter-probe-plan.md)。
> 全程按 `cost_usd` / `GET /v1/generation` 记账，合计不到 1 美元（估算）。
>
> | 模型 id（目录） | 目录声明的面 | 单价（$/M 入 / 出） |
> | --- | --- | --- |
> | `openai/gpt-6-luna` | `openai` | 0.10 / 0.50 |
> | `openai/gpt-6-sol` | `openai` | 2 / 10 |
> | `openai/gpt-6-astra` | `openai` `openai-response` | 10 / 50 |
> | `openai/gpt-5.6-terra` | `openai` `openai-response` | 2 / 12 |
> | `anthropic/claude-sonnet-5` | `anthropic` `openai` `openai-response` | 2 / 10 |
> | `anthropic/claude-opus-5.5` | `openai` `anthropic` | 4 / 20 |
> | `anthropic/claude-fable-5.1` | `openai` `anthropic` | 10 / 50 |
> | `google/gemini-3.8-flash` | `openai` `gemini` | 0.75 / 3.75 |
>
> 目录共 203 条。`supported_endpoint_types` 仍是建议而非限制：`gpt-6-luna` / `-sol` 只声明 `openai`，打 `/v1/responses` 照样 200。

**先说背后是什么——这决定哪些观察能当「官方行为」记。**

| 面 | 回包里的证据 | 结论 |
| --- | --- | --- |
| ④ `/v1/messages` | `msg_011C…` id、不透明 base64 `signature`、`usage.cache_creation` 分项、`service_tier`、`inference_geo`、`stop_details`、`context_management` | **回包是 Anthropic 原样**（只多一个 `usage.cost_usd`） |
| ③ `/v1beta/…:generateContent` | `responseId`、`modelVersion`、**`createTime` 与 `usageMetadata.trafficType: "ON_DEMAND"`**、`thoughtSignature` | **回包是 Vertex AI 原样**（Vertex 专有字段；只多一个 `usageMetadata.costUsd`） |
| ① `/v1/chat/completions`（GPT） | `id: "gen-…"`、`provider: "OpenAI"`、`native_finish_reason`、`usage.cost` / `is_byok` / `cost_details.upstream_inference_cost`、`reasoning_details[]`（`format: "openai-responses-v1"`，密文尾部 base64 解出 `{"endpoint_slug":"openai/gpt-6-luna-20260922\|openai"}`） | **OpenRouter 形态**——网关把 ① 转给了一层 OpenRouter 式的翻译，上游再走 Responses |
| ② `/v1/responses`，默认 | `id: "gen-…"`、`msg_tmp_…` / `fc_tmp_…` 伪造的 item id、`summary:"auto"` 回显成 `"detailed"`、`store` 恒 `false`、`usage.cost`；terra 的 reasoning `format: "azure-openai-responses-v1"` | 同上的 OpenRouter 形态；terra 的上游是 Azure，luna 是 OpenAI |
| ② `/v1/responses`，带 `store: true` 或 `include` 含 `web_search_call.action.sources` | `resp_…` id、`billing`、`tool_usage`、`access_programs`、`moderation`、`prompt_cache_retention: "24h"`、`text.verbosity`、默认 `store: true`；**没有**任何 cost 字段 | **OpenAI 原样**。同一端点按请求里的字段分流到两套后端；`tools:[{type:"web_search"}]`、`include:["reasoning.encrypted_content"]`、`text.verbosity` 都**不**触发分流 |

**请求侧不是透传**：网关把 body 解析成它认识的结构再重新序列化。④ 上顶层多一个 `foo: 1`、`thinking.type: "bogus"`、
`output_config.effort: "bogus"`、`output_config.foo` 全部 200（官方对多余字段 400）；③ 上 `generationConfig.fooBar` 也 200，
但**枚举值会被上游校验**（`thinkingLevel: "BOGUS"` 回 Vertex 的原文 400）。② 的默认线路上 `reasoning.effort: "bogus"` 回网关自己的
`upstream_rejected_request`，原文被吞。**所以本样本里凡是「某某会不会 400」的结论都只对这台网关成立**；回包形状、字段、
事件序列、计费数字可以当官方记。错误信封也被改写过，见文末。

**④ Anthropic（Sonnet 5 为主，Opus 5.5 / Fable 5.1 各一发）：**

- **思考默认开、默认不显示。** 不发 `thinking` 时 Sonnet 5 照样思考（141 个思考 token），回一个 `thinking` block，**`thinking`
  文本为空、只有 `signature`**——即 adaptive 是默认、`display` 默认是 `omitted`。要看见思维链必须显式 `display: "summarized"`。
  Opus 5.5 同样（默认思考、文本空）；Fable 5.1 这一题没思考。
- **新字段 `usage.output_tokens_details.thinking_tokens`**：思考 token 单独报出，是 `output_tokens` 的子集
  （Sonnet 5：`output_tokens` 22 = 21 思考 + 1 正文）。
- **`output_config.effort`** `low` / `medium` / `high` / `xhigh` / `max` 都收；adaptive 下低档常常直接不想（`low` 0 思考 token），
  单次采样噪声很大，思考量不单调，不能拿一次结果推档位。`thinking: {type: "enabled", budget_tokens}` 在 Sonnet 5 上 200、照样思考。
- **thinking + 并行工具**：一轮里两个 `tool_use`，每个带新字段 **`caller: {"type": "direct"}`**（程序化工具调用的来源标记）。
  回灌时：原样回灌 ✓；**丢掉 thinking block 也 200**——与官方规则一致（缺失 → 静默关掉这轮思考、不报错；改动才 400，[`reasoning.md`](reasoning.md) §3.3）；去掉 `caller` 200；**改 `signature` → 400**
  `Invalid \`signature\` in \`thinking\` block`；改 thinking 文本但留原签名 200（摘要文本本来就不是被签的那份）。
- **流式**：thinking 以 `thinking_delta` 连续出，末尾一条 `signature_delta`；`content_block_start` 的 thinking block 带空的
  `signature: ""`。工具参数的第一条 `input_json_delta` 是空串。
- **提示缓存**：块级 `cache_control` 与**顶层** `cache_control`（自动缓存）都生效——9,848 token 的 system 第一次记
  `cache_creation_input_tokens` 9,848（$0.0247，= 1.25× 输入价），第二次 `cache_read_input_tokens` 9,848（$0.0020）。
- **`web_search_20250305` 不需要 beta 头**：`server_tool_use` → `web_search_tool_result`（10 条，带 `encrypted_content`）→ 带
  `citations`（`web_search_result_location`）的 text；`usage.server_tool_use` 是 `{web_search_requests: 1, web_fetch_requests: 0}`。
  **没发 `cache_control` 也记了 2,834 个 `cache_creation_input_tokens`**（搜索结果被服务端自动缓存）。一次 $0.051。
- **结构化输出**：`output_config.format: {type: "json_schema", schema}` 在 Sonnet 5 上生效（回 `{"color":"red","n":7}`）。
- **模型 id 回显**：Sonnet 5 回 `claude-sonnet-5`；Opus 5.5 / Fable 5.1 回连字符形 `claude-opus-5-5` / `claude-fable-5-1`，
  `inference_geo: "not_available"`，签名以 `CAQS…` 开头（Sonnet 5 是 `Ep…`）——后两者多半是另一条上游线路。
- `/v1/messages/count_tokens` **不路由**：301 到官网首页。

**③ Gemini 3.8 Flash（Vertex）：**

- **`thinkingLevel: "MINIMAL"` 被拒**：400 `Thinking level MINIMAL is not supported for this model.`。`LOW` / `MEDIUM` / `HIGH`
  的 `thoughtsTokenCount` 同一题 193 / 641 / 1,348，单调；不发时 685。
- **`thinkingBudget` 仍收**，但 **`thinkingBudget: 0` 关不掉思考**（仍 312 思考 token）——同理可能是网关把 `0` 丢了。
- **`includeThoughts: true`**：思考摘要是一个 `{text, thought: true}` part（英文、带小标题，一次整段给出，流式也不逐字）；
  `thoughtSignature` 挂在**正文 text part** 上。流式时签名单独落在最后一块：`{text: "", thoughtSignature}` + `finishReason`。
- **函数调用带 `id`**（`call_1626125`，新）：并行两个调用，签名只挂第一个 `functionCall` part；流以一个**光秃秃的
  `{text: ""}`** 收尾。回灌：`functionResponse` 带不带 `id` 都 200，两边都去掉 id 也 200；**去掉签名 → 400**
  `Function call is missing a thought_signature in functionCall parts`（HTTP 400，不是 `MISSING_THOUGHT_SIGNATURE` 的
  finishReason）；**把收尾的 `{text: ""}` 原样回灌 → 400** `required oneof field 'data' must have one initialized field`，
  而带签名的 `{text: "", thoughtSignature}` 回灌 200。后者的形态提示这可能是网关把空串当空值丢了、只剩 `{}`
  ——与上面说的请求侧重新序列化一致，未必是 Vertex 本身。
- **结构化输出**：`responseJsonSchema` 与旧的 `responseSchema`（大写类型）都生效；prompt 要求 `yellow` 而 enum 只有
  red/green/blue 时，回 `red`——**强制是真的**。
- **内置工具**：`googleSearch` → `groundingMetadata{webSearchQueries, searchEntryPoint.renderedContent, groundingChunks
  (vertexaisearch 重定向 URL), groundingSupports}`，一次 **$0.028**（检索费远高于 token 费）；`codeExecution` →
  `executableCode{language, code, id}` + `codeExecutionResult{outcome, output, id}`，`usageMetadata.toolUsePromptTokenCount`；
  `urlContext` → `urlContextMetadata.urlMetadata[{retrievedUrl, urlRetrievalStatus}]` 加 `groundingMetadata`。
- **图片**：`inlineData` 与 `inline_data`（蛇形）都收；一张 16×16 的 PNG 记 **1,098** 个 prompt token（默认媒体分辨率）。
- 不带 `alt=sse` 的 `:streamGenerateContent` 也回 SSE（官方是 JSON 数组）——网关行为。
- **`:countTokens` 被当成 `generateContent` 执行并计费**（回一段关于「数 token」的作文，$0.0028）——不要在这台网关上调它。

**② Responses（OpenRouter 形态线路为主，原样线路补测）：**

- `reasoning.effort` `none` / `low` / `medium` / `high` / `xhigh` / `max` 在 `gpt-6-luna` 上都 200；**`minimal` 被改写成 `low`**
  （回显 `effort: "low"`）。`gpt-6-sol` 在 ② 上也能用。
- 默认线路的流：`reasoning` item 一次 `added` / `done`，只有 `encrypted_content`、`summary: []`，**没有**任何
  `reasoning_summary_text.delta` 事件（非流时 `summary` 有文本）；两个并行 `function_call` 依次（不交错）。
- **回灌规则在两条线路上都测不出来**：`store: false` 下只回 id 的 reasoning item、篡改过的 `encrypted_content`、干脆丢掉
  reasoning item，在默认线路**和原样线路**上都 200——网关在转发前多半改写了 `input`。官方的回灌义务仍以
  [`responses.md`](responses.md) 为准，这里不改口。
- `web_search`：默认线路 `web_search_call` 事件齐全（`in_progress` / `searching` / `completed`）+ `url_citation` 注解；原样线路上
  `action.sources` 在、`usage.input_tokens_details.cache_write_tokens` 是新字段（4,388）。strict `text.format` 在 luna 上顶住了矛盾的 enum。

**① Chat Completions（经 OpenRouter 形态）：**

- GPT：`reasoning_effort` + `tools` 同发 200、两个并行调用正常流出——但这条线路上游走的是 Responses，**不能用来证伪「官方
  ① 上 5.4+ 不能 effort + tools」**。思维链只以 `reasoning_details` 的密文 / `reasoning` 摘要出现；strict `json_schema`
  顶住了矛盾的 enum；`web_search_options` 200 但无 `annotations`。
- 跨族：Claude 经 ① 的思维链在 `reasoning_content`；Gemini 经 ① 不返回思维链、只报 `reasoning_tokens`。

**网关自己的东西：**

- 响应头只有 `x-orca-request-id` / **`x-orca-route: model=…; fallback=0`**（文档里没有）/ `x-orca-version`，不漏任何上游头。
- 花费：④ 在 `usage.cost_usd`、③ 在 `usageMetadata.costUsd`、① 两个都有、② 默认线路只有 OpenRouter 的 `usage.cost`、② 原样线路
  **没有**；`X-OrcaRouter-Include-Cost` 头对 ② 无效。`GET /v1/generation?id=` 都查得到（`total_cost`，外加 New API 的
  `quota` = 美元 × 500,000）。
- **错误信封全被改写成 OpenAI 形**，且有 New API 的指纹：③ 是 `{"error":{"message", "type":"invalid_argument", "param":"",
  "code":400}}`（原文保留，但路径与 URL 被打成 `***`）；④ 是 `{"error":{"type":"<nil>", "message":"***.***.content.0: … (request id: …)"},
  "type":"error"}`——**`type` 是 Go 的 `<nil>`**，字段路径被遮；上游 5xx 变成 `api_error` `The upstream provider is temporarily
  unavailable`。

**对本项目**（同日落地）：

- `GEMINI_LEVEL` 的「关闭」从 `MINIMAL` 改成 `LOW`——前者在 3.8 Flash 上是 400，而这一档是作者要「尽量少想」，报错是最坏的结果
  （`reasoning.ts`；[`reasoning.md`](reasoning.md) 的 Gemini 一节）。
- Gemini 适配器回灌模型 parts 时跳过光秃秃的 `{text: ""}`（带签名的保留），否则经这台网关每个流式工具轮的第二轮都 400
  （`gemini.ts`）。
- `orcarouter` 的能力格子填上实测：①②③ `jsonSchema` ✓，② / ④ `web_search` ✓；`gpt-6` 进 strict schema 名单与输出上限表
  （128K），`gemini-3` 进输出上限表（64K）。

**补测：④ 的结构化输出（同日，curl 约 25 次 + live 用例 3 条）。** 统一用一个与 prompt 矛盾的 enum
（prompt 要求 `yellow`，enum 只有 red / green / blue），对照组去掉 enum：

| 条件 | 结果 |
| --- | --- |
| Sonnet 5 / Sonnet 4.6 / Opus 4.5，`thinking: disabled` | 都答 enum 内的值；对照组答 `yellow`——**强制是真的** |
| Opus 5.5 / Fable 5.1，`thinking: disabled` | **400**：`claude-opus-5-5 requires adaptive thinking; omit thinking or use thinking.type=adaptive and output_config.effort`（Fable 同义）——与结构化输出无关，这两个型号**不收 `disabled`** |
| Opus 5.5 / Fable 5.1，不发 `thinking` | 默认思考（文本空）+ enum 内的 JSON |
| Sonnet 5 / Opus 5.5 + adaptive + `effort: high` + `display: summarized` | thinking block 在前（Opus 的摘要里明说「yellow 不在 enum 里」），JSON 在后，算术也对 |
| Sonnet 4.6 + `thinking: {type: "enabled", budget_tokens: 1024}` | 同上 |
| 带工具、`tool_choice` 自动 | 第一轮照常 `tool_use`；回灌结果后第二轮给合 schema 的 JSON |
| 强制 `tool_choice`（`any` / 指名，含 adaptive 思考） | 照常强制出 `tool_use`，不冲突 |
| 流式 | JSON 走普通 `text_delta`，没有新的块类型 |
| schema 带 `minLength` / `maximum` / `pattern` / `minItems: 3`、缺或为 `true` 的 `additionalProperties` | 经网关都 200（请求侧结论，只对网关成立；官方文档把它们列为不支持） |
| `["string","null"]` 联合、带 `null` 的 enum、`anyOf` 含 `null`、对象数组 | 200，输出合 schema |

据此本项目打开 ④ 族的结构化输出（只有严格档）：[`structured-output-plan.md`](structured-output-plan.md) §13。
本项目 Claude 的「关闭」思考档本来就发 `adaptive` + `effort: low` 而不是 `disabled`，所以 Opus 5.5 / Fable 5.1
拒收 `disabled` 不影响本项目。

### 兼容层文档的通用规律（八个样本的共同点）

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
