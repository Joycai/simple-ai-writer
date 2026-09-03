# ② OpenAI Responses：协议事实（GPT-5.4 / 5.5 / 5.6 实测）

> **性质**：与 [`streaming.md`](streaming.md)、[`tools.md`](tools.md) 同类的协议事实页，
> 不含本项目的取舍（那些在 [`qianwen-compat-plan.md`](qianwen-compat-plan.md) §4）。
> 写成可以直接搬去别的项目用的形态：每条都附能验证它的请求骨架或字段路径。
>
> **实测来源**：2026-09-03，通过一个 New API 中转站（`hk.chenmoai.com`，`[Pro]` 档，
> 即 ChatGPT Pro 账号背后的 Codex 后端）打 `[Pro]gpt-5.4`、`[Pro]gpt-5.5`、
> `[Pro]gpt-5.6-sol`，请求约 90 次。**不是官方端点**——凡是"中转站干的"都单独标出
> 并收进 [`landscape.md`](landscape.md) §7 第八个样本；标「官方文档」的条目来自
> `developers.openai.com` 2026-09 版参考页（页面 URL 加 `.md` 可取 markdown）。
> 千问AI平台的 Responses 面只探过一次，见 [`landscape.md`](landscape.md) §7 第六个样本。

## 1. 骨架

```jsonc
POST {base}/responses            // base 与 ① 族相同（官方 https://api.openai.com/v1）
Authorization: Bearer …
{
  "model": "gpt-5.6-sol",
  "instructions": "…",                       // system；不发则用端点/中转站的默认（见 §8）
  "input": "…" | [ /* items */ ],
  "tools": [{ "type": "function", "name": "f", "description": "…", "parameters": {…}, "strict": false }],
  "tool_choice": "auto" | "none" | "required" | { "type": "function", "name": "f" },
  "reasoning": { "effort": "medium", "summary": "auto" },
  "text": { "format": { "type": "json_schema", "name": "x", "schema": {…} }, "verbosity": "medium" },
  "max_output_tokens": 4096,
  "store": false,
  "stream": true
}
```

`input[]` 的条目（item）类型，本项目会碰到的：

| 类型 | 形状 | 谁产生 |
| --- | --- | --- |
| 用户消息 | `{role:"user", content:"…"}` 或 `content:[{type:"input_text",text}, {type:"input_image",image_url:"data:…"|"https://…",detail?}]` | 客户端 |
| 助手消息 | `{type:"message", role:"assistant", status, phase:"commentary"|"final_answer", content:[{type:"output_text",text,annotations:[]}]}` | 模型（回传时原样） |
| 推理 | `{type:"reasoning", summary:[{type:"summary_text",text}], encrypted_content:"…"}` | 模型（回传时原样） |
| 函数调用 | `{type:"function_call", call_id, name, arguments:"<json 串>", status}` | 模型（回传时原样） |
| 函数结果 | `{type:"function_call_output", call_id, output:"…"}` | 客户端 |

`system`/`developer` 角色的消息条目也合法，但顶层 `instructions` 是官方推荐位置。

## 2. 请求侧字段（实测）

### 2.1 `reasoning`

| 字段 | 值 | 实测 |
| --- | --- | --- |
| `effort` | `none / minimal / low / medium / high / xhigh / max` | **按模型裁剪，越界 400**：gpt-5.4 到 `xhigh`（`max` → 400 `Unsupported value: 'max' is not supported with the 'gpt-5.4' model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.`）；5.5 与 5.6-sol 收到 `max`。**默认**：5.4 `none`，5.5 / 5.6 `medium`（响应 `reasoning.effort` 回显）。 |
| `summary` | `auto / concise / detailed` | 发 `auto` 回显 `detailed`。不发则 `null`，流里没有任何摘要事件。**即使发了，模型没推理（`reasoning_tokens: 0`）时也没有 `reasoning` 条目**——同一请求两次可能一次有一次没有。 |
| `context` | `auto / current_turn / all_turns` | 回显默认：5.4 `current_turn`，5.5 与 5.6 **`all_turns`**（文档说 5.6 才是，实测 5.5 也是）。显式 `current_turn` 被接受。 |
| `mode` | `standard / pro` | 5.6-sol 发 `pro` **回显 `standard`**——是中转站吞的还是这一档不放 pro，分不清；官方端点未验。 |

`effort: "none"` 时响应没有 `reasoning` 条目、`reasoning_tokens: 0`，与 ① 族的
`reasoning_effort:"none"` 同义。

### 2.2 `text`

- `format.type: "json_schema"`，`name` + `schema` 必填。**`strict` 省略时端点自动升成
  `strict: true`**（响应 `text.format.strict` 回显 `true`），输出严格匹配 schema。
  含 `["string","null"]` 的 schema 被 strict 接受。
- `format.type: "json_object"` 要求 prompt 出现 "json"，否则 400
  `Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'.`（与 ① 族同一条隐藏前置）。
- `verbosity: low/medium/high` 被接受并回显，默认 `medium`。
- **中转站陷阱**：显式 `strict: true` 时整个 `format` 被中转站丢掉（回显 `{type:"text"}`，
  输出不按 schema），省略 `strict` 反而正确。官方端点无此问题（官方文档明说 strict 可显式）。

### 2.3 `tools` / `tool_choice`

- 扁平定义 `{type:"function", name, description, parameters, strict?}`。**`strict` 省略 →
  响应 `tools[].strict` 回显 `true`**（官方文档：schema 兼容则自动 strict，否则退非 strict）。
  含 `["string","null"]` 的参数 schema 被自动 strict 接受。要保持非 strict 语义必须显式
  `strict: false`。
- `tool_choice`：`"required"` 与 `{type:"function",name}` 在 **effort `medium` 下都合法**
  （5.5、5.6-sol 实测；5.4 那次 504 未得结论）——② 族没有 ① 族 DeepSeek 式的"思考中禁止强制"。
- 并行调用：单工具场景未触发；`parallel_tool_calls` 回显默认 `true`。

### 2.4 状态与其它

- `store: false` 被接受并回显；此时 `reasoning` 条目**自带 `encrypted_content`**
  （1.3–1.4KB），不需要 `include: ["reasoning.encrypted_content"]`（发了也无害）。
  `store: true` 同样 200（中转站是否真存未验）。
- `max_output_tokens: 16` 被接受（官方最小值 16）。
- **未知顶层键被忽略**（`foo_bar: 1` → 200）。与 ④ 族 Anthropic 官方的"未知键 400"相反。
- `stream_options.include_obfuscation: false` 发了之后 delta 事件里**仍有 `obfuscation`
  字段**（中转站或端点忽略）。消费方必须无视该字段。

## 3. 响应侧：`output[]` 与 usage

非流式响应顶层键（2026-09 实测，供做类型时参考）：`id, object:"response", status,
created_at, completed_at, error, incomplete_details, instructions, model, output[],
reasoning{effort,summary,context,mode}, text{format,verbosity}, tools[], tool_choice,
parallel_tool_calls, store, previous_response_id, max_output_tokens, max_tool_calls,
truncation, temperature, top_p, top_logprobs, service_tier, prompt_cache_key,
prompt_cache_retention, safety_identifier, metadata, background, moderation, tool_usage,
usage, user, frequency_penalty, presence_penalty`。

`output[]` 的顺序：`reasoning`（若有）→ `function_call`* 或 `message`。助手 `message`
**恒带 `phase: "final_answer"`**（5.4 / 5.5 / 5.6 都是）；`commentary` 只在工具轮的
前置发言出现（本次未触发）。

`usage`：

```jsonc
{
  "input_tokens": 63,
  "input_tokens_details": { "cached_tokens": 0, "cache_write_tokens": 0 },
  "output_tokens": 34,
  "output_tokens_details": { "reasoning_tokens": 10 },
  "total_tokens": 97,
  "attribution": { "items": { "<item id>": {…} }, "request_fields": { "instructions": {…} } }  // 逐条目计费明细，可忽略
}
```

`cached_tokens` 是 input 的子集（与 ① 族同口径）。5.6-sol 一次 4.4K 输入命中了 3.5K 缓存。

## 4. 流式事件（实测序列）

纯文本：

```
response.created → response.in_progress
→ response.output_item.added        { item: {type:"message", status:"in_progress", phase:"final_answer", content:[]} }
→ response.content_part.added       { part: {type:"output_text", text:""} }
→ response.output_text.delta ×N     { delta, item_id, output_index, content_index, obfuscation }
→ response.output_text.done → response.content_part.done → response.output_item.done
→ response.completed                { response: <完整响应对象，含 usage> }
```

带推理摘要（`summary` 已发且模型真的推理了）时在 message 之前多一段：

```
response.output_item.added          { item: {type:"reasoning", summary:[]} }
→ response.reasoning_summary_part.added
→ response.reasoning_summary_text.delta ×N     { delta }
→ response.reasoning_summary_text.done → response.reasoning_summary_part.done
→ response.output_item.done         { item: {type:"reasoning", summary:[{type:"summary_text",text}], encrypted_content} }
```

函数调用：

```
response.output_item.added          { item: {type:"function_call", call_id, name, arguments:""} }
→ response.function_call_arguments.delta ×N    { delta }      // 实测 9 片
→ response.function_call_arguments.done        { arguments }  // 完整 JSON 串
→ response.output_item.done         { item: {type:"function_call", …, status:"completed"} }
```

**`response.output_item.done` 的 `item` 就是回传用的完整条目**（含 `encrypted_content`）：
消费方只要收集这些 item，不必自己从 delta 拼。`response.reasoning_text.delta`
（原始推理文本）在这三款模型上从未出现。终止：`response.completed` /
`response.incomplete`（`response.incomplete_details.reason`）/ `response.failed`，
另有独立的 `error` 事件（`{type:"error", code, message, param}`）。事件都带 `sequence_number`。

## 5. 多轮回传（无状态，`store: false`）

工具轮：turn1 拿到 `output[]`，turn2 的 `input = 原历史 + output[] + function_call_output`。
以下四种写法在 5.4 / 5.5 上**都 200 且答对**：

1. 原样回传全部条目（含 `reasoning` 与 `encrypted_content`）——官方推荐。
2. 去掉 `reasoning` 条目。
3. 保留 `reasoning` 但删掉 `encrypted_content`（只剩 `summary`）。
4. 只回传裸 `{type:"function_call", call_id, name, arguments}`（不带 `id`/`status`）。

**结论：回传缺失不报错**，与 ④ 族 Anthropic（静默关思考）一样属于"无现象"那一类——
少回传的代价只在质量上（5.6 默认 `all_turns` 会把往轮推理渲染回去，缺了就没有）。

`phase`：第三轮把上一轮助手 `message` 的 `phase` 删掉再发，**不报错**；两个模型的行为
在有无 `phase` 下各自发生了变化（一次调工具、一次直接作答），样本太小不能下"性能下降"
的结论，只能说官方文档那句"drop 会退化"没有被反驳。

## 6. 错误

| 情形 | 状态 | 信封 |
| --- | --- | --- |
| effort 越界 | 400 | `{error:{message:"Unsupported value: …", type:"invalid_request_error", param, code}}` |
| `json_object` 缺 "json" | 400 | 同上 |
| 坏 key（中转站） | 401 | `{error:{code:"", message:"Invalid token …", type:"new_api_error"}}` |
| 假模型名（中转站） | **503** | `{error:{code:"model_not_found", message:"No available channel for model …", type:"new_api_error"}}`（流式请求同样是 HTTP 503 + 这个 JSON，不是 SSE） |
| 上游超时（中转站） | 504 / 502 | nginx HTML 页 / `{error:{message:"bad response status code 502"}}` |

假模型名答 503 而不是 404 意味着：把 404 当"端点不存在、可降级"的探测逻辑在这类中转站上
不会误判，但把 5xx 一律当"不可达"的逻辑会把它读成断网。

## 7. 与 Chat Completions 的对照（同一批模型、同一中转站）

| | ① `/chat/completions` | ② `/responses` |
| --- | --- | --- |
| 思考控制 | `reasoning_effort`（`xhigh` 被接受） | `reasoning.effort` |
| 思维链取回 | **`delta.reasoning_content` 有内容**（5.4 / 5.5；5.6-sol 那次为空）——这是中转站把 ② 的摘要翻译过来的，官方 ① 族没有这个字段 | `reasoning_summary_text.delta` |
| 思考 + 工具 | **可用**（effort `medium` 下拿到 `tool_calls`）——官方文档说 5.4 起不支持，**在中转站上验不了这条**：它很可能把 ① 翻译成 ② 再打后端 | 可用 |
| 结构化输出 | `response_format: json_schema` strict **正常** | `text.format` 见 §2.2 的 strict 陷阱 |
| 图片 | `image_url` data URL ✅ | `input_image` data URL ✅（前两次 504 是超时，非拒绝） |
| usage | `prompt_tokens` / `completion_tokens` + `completion_tokens_details.reasoning_tokens` | `input_tokens` / `output_tokens` + `output_tokens_details.reasoning_tokens` |

## 8. 中转站干的事（不要当成协议事实）

这些全部记在 [`landscape.md`](landscape.md) §7 第八个样本，这里只列标题：不发 `instructions`
时注入 Codex 的系统提示（输入 4.4K–7.5K token）、`text.format` 显式 `strict:true` 被整个丢掉、
`reasoning.mode:"pro"` 回显 `standard`、`include_obfuscation:false` 无效、60s 上游超时
（504 / 502 频繁，5.6-sol 尤甚）、假模型名 503、`/v1/models` 带 `supported_endpoint_types`。

## 9. 未验

- 官方端点本身（以上全部经中转站）；`reasoning.mode: "pro"` 与 `background` 在官方上的行为。
- `response.reasoning_text.delta` 何时出现（哪些模型放原始推理）。
- 并行工具调用的事件交错（多个 `function_call` 同时流）。
- `truncation: "auto"`、`context_management`、`conversation` / `previous_response_id`。
- `phase` 缺失的真实代价（需要多轮、带工具的长任务对照）。
- 5.6-sol 的多轮回传（两次都撞上中转站 502）。
