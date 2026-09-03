# 千问AI平台实测与后续两件事：修兼容问题、接 Responses 族

> **状态：调研已落地（PR #466），修复与接入均未开工；执行顺序见 §6。** 2026-09-03 用作者的 key 对千问AI平台
> （百炼 / DashScope）的 ① Chat Completions 与 ④ Anthropic 两个面做了逐模型实测，
> 协议事实已写进 [`landscape.md`](landscape.md) §7 第六个样本，本文只放**结论、问题清单
> 与计划**。§3 是修复切片，§4 是 Responses 族的接入评估（含与 OpenAI 官方 GPT-5.4 /
> 5.5 / 5.6 的对照）。按 [`../reference/workflows.md`](../reference/workflows.md) 的惯例
> 一片一个 PR，每片合并后停下来等真机测试。
>
> **2026-09-03 追加**：用作者给的 New API 中转站 key 打了 `[Pro]gpt-5.4 / 5.5 / 5.6-sol` 的
> Responses 面约 90 次，§4.5 的 OpenAI 侧悬案大半定掉了；协议事实单独成页
> [`responses.md`](responses.md)，中转站怪癖是 [`landscape.md`](landscape.md) §7 第八个样本。
>
> 实测工具：`src/lib/__tests__/live.qianwen.test.ts`——用仓库里**真实的 adapter**
> （`streamOpenAI` / `streamAnthropic` / `streamCompletion` / `testProviderConnection`）
> 直连端点，设 `QIANWEN_KEY` 环境变量才运行，没有 key 整组跳过。验证的是"我们实际发出的
> 字节对面认不认"，不是手写的模仿请求。

## 0. 一句话结论

- **7 个模型在两条线上都能用现有代码跑通**（qwen3.8-flash、qwen3.7-flash、
  deepseek-v4-pro-0813、kimi-k3、glm-5.2、MiniMax-M2.5、qwen3-vl-plus）：流式、思维链、
  用量、工具调用与多轮回传、图片、JSON，全是现有 adapter 认识的形状。73 条实机用例
  71 条通过，两条失败都是用例本身的假设。
- **一处真 bug，与千问无关**：`deepseek` 思考档的「关闭」把 `thinking:{type:"disabled"}`
  包在字面量 `extra_body` 键里发出去，端点当未知字段忽略，思考照常。项目自己的
  [`reasoning-plan.md`](reasoning-plan.md) §2 表格写的就是顶层 `thinking`，测试却把错误
  形状钉死了。这是 §3 第 1 片。
- **Responses 族值得接，但理由不是千问**：OpenAI 官方文档明载 **GPT-5.4 起 Chat
  Completions 不再支持 `reasoning_effort ≠ none` 时的工具调用**——本项目的 agent 循环在
  GPT-5.4+ 上要么关思考、要么换协议。千问的 Responses 只是顺路多一个样本（而且砍得不少，
  §4.2）。

## 1. 实测矩阵（2026-09-03）

wire 层的细节（首块形状、错误信封、文档不符处）见 [`landscape.md`](landscape.md) §7
第六个样本；这里只列**本项目的每个开关落到每个模型上是什么结果**。

### 1.1 ① 面 `/compatible-mode/v1`（`openai_compat`）

| 模型 | 默认思考 | `openai-generic` 关 (`reasoning_effort:none`) | `qwen-budget` 开+预算 / 关 | `deepseek` 关（现状 `extra_body`） | `glm` 档（`thinking.clear_thinking`） | 强制 tool_choice（思考中） | `json_schema` strict | 图片 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3.8-flash | 开 | ✅ 关 | ✅ / ✅ | ❌ 照常思考 | ✅（被忽略） | 400 → 重试 auto ✅ | ✅ | ✅ |
| qwen3.7-flash | 开 | ✅ 关 | ✅ / ✅ | ❌ 照常思考 | **400** | ✅ 接受 | ✅ | ✅ |
| deepseek-v4-pro-0813 | 开 | ✅ 关 | ✅ / ✅ | ❌ 照常思考 | **400** | ✅ 接受 | ✅ | 无视图片 |
| kimi-k3 | 开 | ✅ 关 | **400（budget）** / ✅ | ❌ 照常思考 | ✅（被忽略） | ✅ 接受 | ✅ | ✅ |
| glm-5.2 | 开 | ✅ 关 | ✅ / ✅ | ❌ 照常思考 | ✅ | ✅ 接受 | ✅ | 无视图片 |
| MiniMax-M2.5 | 开 | **400** | ✅ / **400** | ❌ 照常思考 | **400** | 400 → 重试 auto ✅ | 不强制（散文或围栏） | 「看不到」 |
| qwen3-vl-plus | 关 | ✅ | ✅ / ✅ | （本就不思考） | **400** | ✅ 接受 | ✅ | ✅ |

补充：三种关法（`enable_thinking:false`、`reasoning_effort:"none"`、顶层 `thinking:{type:"disabled"}`）
在 6 个思考模型上等效；`reasoning_effort` 只有 3.8 代真分档；工具轮回传 `reasoning_content`
带不带都行；`json_object` 缺 "json" 字样只有 Qwen / DeepSeek 报 400。

### 1.2 ④ 面 `/apps/anthropic`（`anthropic_compat`）

| 模型 | 默认 `claude-adaptive`（`adaptive`+`display`） | `claude-budget`（`enabled`+`budget_tokens`） | `minimax` 档关（`disabled`） | 工具轮回传 thinking block（空签名） | 强制 `{type:"tool"}`（思考中） |
| --- | --- | --- | --- | --- | --- |
| qwen3.8-flash | ✅ | ✅ | ✅ | ✅ | 400 → 重试 ✅ |
| qwen3.7-flash | ✅ | ✅ | ✅ | ✅ | ✅ |
| deepseek-v4-pro-0813 | ✅ | ✅ | ✅ | ✅ | ✅ |
| kimi-k3 | ✅ | **400（budget）** | ✅ | ✅ | ✅ |
| glm-5.2 | ✅ | ✅ | ✅ | ✅ | ✅ |
| MiniMax-M2.5 | ✅ | ✅ | **400** | ✅ | 400 → 重试 ✅ |
| qwen3-vl-plus | ✅ | ✅ | ✅ | ✅ | ✅ |

连接测试：`/v1/models` 404 → 降级到假模型探测 → 400 裸 `{code,message}` → `apiErrorMessage`
的 `message` 分支判通。`x-api-key` 与 Bearer 都收，`authMode` 两个值都过。

### 1.3 没测的

付费额度以外的都测了；**没测**：`enable_search`（4.7）、qwen3.8-max 的 `preserve_thinking`
回传要求与 PDF `file` 块（4.9）、`json_schema` strict 对 `["string","null"]` 的接受度
（[`structured-output-plan.md`](structured-output-plan.md) §11 第 1 条）、国际站。
Responses 只探了一次（§4.2）。

## 2. 问题清单

按"作者会撞上的概率 × 有没有现象"排：

| # | 问题 | 现象 | 位置 | 处置 |
| --- | --- | --- | --- | --- |
| P1 | `deepseek` 档「关闭」发 `extra_body:{thinking:{type:"disabled"}}` | 思考照常、照常计费，**无报错**；DeepSeek 官方与千问都中招 | `reasoning.ts` `reasoningBody` deepseek 分支 + `aiClient.test.ts` | ✅ §3 第 1 片已修（顶层 `thinking`） |
| P2 | 千问 ④ 面没有预设 | 作者得自己知道 base 是 `/apps/anthropic` 根地址、且不带 `/v1` | `ProviderDrawer.tsx` `PROVIDER_PRESETS` | ✅ §3 第 2 片已加 |
| P3 | `glm` 档的 `thinking:{clear_thinking:false}` 在非 GLM 模型上 400 | 作者误选类目才会撞；报错明确 | `reasoning.ts` `glm.extra` | ✅ 不改代码，类目提示文案已加「仅 GLM」（第 2 片） |
| P4 | kimi-k3 拒 `thinking_budget`、MiniMax-M2.5 拒关闭 | 400，报文明确 | 端点行为 | 不改代码；记入 landscape 供作者查 |
| P5 | MiniMax-M2.5 无视 `response_format` | JSON 任务可能拿到散文，`extractJsonObject` 抓不到 → 该任务失败 | 端点行为 | 作者把该模型的结构化输出声明成「关」（现有 L3 开关够用） |
| P6 | `KNOWN_OUTPUT_CAPS` / `modelLimits.ts` 的 Qwen 条目停在 qwen-max/plus/turbo 8K | 新模型无条目 → 不设上限，无害；但 3.7/3.8 代真实上限（131K，CoT 262K）作者得手填 | `modelLimits.ts` | ✅ 第 2 片补了 3.7/3.8-flash、qwen3-vl-plus、deepseek-v4-pro、glm-5.2、kimi-k3、MiniMax-M2.5（max 系列没有模型页数据，未加） |
| P7 | `KNOWN_JSON_SCHEMA` 只列 Qwen 与 GPT | DeepSeek V4 / GLM-5 / Kimi-K3 在千问上 strict 都过，但这是**千问的**能力，不是模型的；DeepSeek 官方无 `json_schema` | `jsonMode.ts` | **不加**（表是按模型 id 匹配、跨端点生效，加了会在官方端点上 400），维持作者手动声明 |

## 3. 修复切片

### 第 1 片：`deepseek` 关闭开关走顶层 `thinking`（P1）

- `reasoningBody` 的 `deepseek` 分支 `off` → `{ thinking: { type: "disabled" } }`。
- `aiClient.test.ts` 那条断言反过来：body **没有** `extra_body`，**有** `thinking.type === "disabled"`。
- 顺手：`reasoning-plan.md` §0「新出现在 wire 上」那段与
  [`../issues/thinking-verification.md`](../issues/thinking-verification.md) 4.2 标已验。
- 验证：`live.qianwen.test.ts` 已有 `openai-generic off` 用例，加一条 `deepseek off`
  断言 `reasoning === ""`（deepseek-v4-pro-0813 上现在会失败，改完应过）。DeepSeek 官方
  端点没有 key，留给作者真机。

### 第 2 片：千问 ④ 面预设 + 上限表 + 提示文案（P2 / P3 / P6）

- `PROVIDER_PRESETS` 加 `{ name: "通义千问 (Claude 格式)", apiStandard: "anthropic_compat",
  baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic" }`，`authMode` 留 `default`
  （`x-api-key` 实测可用，与官方一致，不必像 OrcaRouter 那样改 Bearer）。国际站是否也有
  `/apps/anthropic` 未验，不加第二行。
- `modelLimits.ts` 补 2026-09 的千问目录上限（数字来自模型页）：qwen3.8-flash / qwen3.7-flash
  131K、deepseek-v4-pro-0813 393K、glm-5.2 131K、kimi-k3 1M、MiniMax-M2.5 32K、qwen3-vl-plus 32K。
- `thinkingCatGlmHint` 中英文各加一句：只用于 GLM 模型，其它模型会 400。
- 验证：vite 预览点预设核对四个字段；`live.qianwen.test.ts` 的 anthropic 组已覆盖这条线。

### 第 3 片（可选，等作者有需要再做）：思考类目的「端点否决」memo

kimi-k3 拒预算、MiniMax 拒关闭、qwen3.8-flash 思考中拒强制工具——三件事都是端点用 400
说话，报文都明确。现有 `toolChoice.ts` 已经对第三件做了"一次 400、本会话记住"。同样的
memo 可以推广到「这个模型拒绝 `thinking_budget`」「这个模型拒绝关闭」，把 400 变成一次性
降级而不是每次失败。**不急**：三件事都有报错、都可由作者改类目解决。

## 4. Responses 族：评估与计划

### 4.1 为什么现在值得接

1. **GPT-5.4 起，Chat Completions 上 `reasoning_effort ≠ none` 就不能带工具**
   （OpenAI「Migrate to Responses」指南，2026-09 版原话：*Starting with GPT-5.4, Chat
   Completions does not support tool calling with `reasoning_effort` values other than
   `none`*）。本项目的 agent 循环、结构化任务的强制工具、子代理，全靠工具；在 5.4 / 5.5 /
   5.6 上要开思考就只剩 Responses。**这条在中转站上验不了**：New API 把 ① 翻成 ② 再打
   后端，所以 `[Pro]gpt-5.4` 在 `/chat/completions` 上思考+工具照样能用（还多出官方没有的
   `reasoning_content`）；只有直连 api.openai.com 才能证实或证伪。
2. **5.6 代的新东西只在 Responses 上**：`reasoning.mode: "pro"`（Sol 的深推理模式）、
   `reasoning.context: "all_turns"`（5.6 默认，把往轮推理渲染回下一轮）、`tool_search` /
   `apply_patch` / `hosted_shell` 等内置工具、`prompt_cache_options`。
3. **千问也把 Responses 当一等面**：`reasoning.effort` 7 档、`previous_response_id`、
   内置工具（联网搜索在这个面上**有来源与引用**，Chat Completions 上没有）。

### 4.2 OpenAI 官方（GPT-5.4 / 5.5 / 5.6）vs 千问：同一个协议，两份能力面

请求侧：

| | OpenAI（2026-09 参考页） | 千问 `/compatible-mode/v1/responses` |
| --- | --- | --- |
| 支持模型 | 5.4 / 5.5 / 5.6-sol / -terra / -luna 全部同时支持 Chat Completions 与 Responses；1.05M 上下文、128K 输出 | 文档列 Qwen 3.5–3.8、deepseek-v4、glm-5.2、kimi-k3；**MiniMax-M2.5 实测 400**（`'agent_api_metadata'`）；"非列表模型仅基础能力" |
| `reasoning.effort` | `none/minimal/low/medium/high/xhigh/max`，**按模型裁剪**：5.4 到 xhigh（默认 none）、5.5 到 xhigh（默认 medium）、5.6 到 max（默认 medium） | 同一套 7 档词表，默认 `xhigh`；另收非标准 `enable_thinking` |
| `reasoning.summary` | `auto/concise/detailed`，不发则无摘要；**原始思维链不可见** | 文档无此字段；`reasoning` 条目里 `summary[]` 直接就是思维链文本 |
| `reasoning.mode` / `reasoning.context` | 5.6 独有：`standard/pro`、`auto/current_turn/all_turns`。**实测**：`context` 回显 5.4 `current_turn`、**5.5 与 5.6 都是 `all_turns`**；`mode:"pro"` 经中转站回显 `standard` | 无 |
| `text.format` / `text.verbosity` | `json_schema`（含 strict）、`json_object`（不推荐）；`verbosity low/medium/high`。**实测**：省略 `strict` 端点自动升 strict 并回显 `true`；`["string","null"]` 被 strict 接受；`json_object` 缺 "json" 字样 400 | **文档无 `text` 字段**——这个面上没有结构化输出，只能靠强制工具 |
| `tools[]` | 扁平 `{type:"function",name,parameters,strict}`；**`strict` 缺省即尝试 strict**（实测回显 `strict:true`，含 `["string","null"]` 的参数照样过），schema 不兼容时自动退非 strict；另有 custom（CFG 语法）与 10 种内置工具 | 扁平同形；内置工具 `web_search` / `code_interpreter` / `web_extractor` / `web_search_image` / `image_search` / `file_search` / `mcp` |
| `tool_choice` | `none/auto/required`、`{type:"function",name}`、`{type:"allowed_tools",mode,tools}`、内置工具型。**实测**：`required` 与 `{type:"function"}` 在 effort `medium` 下都合法（5.5 / 5.6-sol），没有 ① 族那种"思考中禁止强制" | `auto/none/required` + `{type:"function",name}`；思考模式下的强制档是否被拒未验（Chat 面上分模型） |
| 状态 | `store` **默认 true**；`previous_response_id` 或 `conversation`；`store:false` 时 `reasoning` 条目**默认带 `encrypted_content`**（实测 1.3–1.4KB，不用 `include`），回传即可无状态延续；**少回传不报错**（去掉 reasoning / 去掉 encrypted_content / 只回裸 function_call 都 200） | `store` 有；`previous_response_id`（7 天）与 `conversation`；**无 `encrypted_content`**，回传的是明文 `summary` |
| `input` 条目 | `message`（user/assistant/system/developer，assistant 带 `phase: commentary/final_answer`，**5.3-codex 起要求回传**）、`function_call`、`function_call_output`、`reasoning`、`item_reference`、内置工具条目 | `message`、`function_call`、`function_call_output`、`reasoning`（`id`+`summary[]`）、`web_search_call`；无 `phase`、无 `item_reference` |
| 图片 | `input_image` 收 URL 或 data URL，`detail: low/high/auto/original` | 文档只给纯文本 `content`；多模态是否走 `input_image` 未验 |
| 其它 | `background`、`truncation:auto`、`context_management`（compaction）、`max_tool_calls`、`prompt_cache_key`、`service_tier`、`stream_options.include_obfuscation` | 明确**不支持 `background`**；其余未提及即忽略（文档原话：未列参数被忽略） |

响应侧：

| | OpenAI | 千问 |
| --- | --- | --- |
| 流式事件 | 57 种；文本 `response.output_text.delta`，函数参数 **`response.function_call_arguments.delta/done`**（实测 9 片 delta + done 带完整串），推理摘要 `response.reasoning_summary_text.delta`（要发 `summary`，且模型真推理了才有），原始推理 `response.reasoning_text.delta`（三款上从未出现），结束 `response.completed` / `response.incomplete` / `response.failed`，另有裸 `error` 事件；delta 带 `obfuscation` 字段要无视。完整序列见 [`responses.md`](responses.md) §4 | 文档事件表约 30 种：有 `response.output_text.delta`、`response.reasoning_text.delta`、`response.output_item.added/done`、`response.completed`；**没有 `response.function_call_arguments.delta`**（参数可能整块随 `output_item.done` 到达，未验） |
| usage | `response.completed` 的 `response.usage`：`input_tokens` / `output_tokens` / `output_tokens_details.reasoning_tokens` / `input_tokens_details.cached_tokens` | 同形（文档事件表里有 `response.usage.*` 字段路径） |
| 错误 | HTTP 错误 `{error:{message,type,code}}`；流中 `error` 事件 `{code,message,param}` | ① 面同形的 `{error:{…}}`（MiniMax 那次就是）；流中形态未验 |

**三条会改设计的差异**：

1. **回传的东西不一样**。OpenAI 无状态延续靠 `reasoning.encrypted_content` +
   assistant `phase`；千问靠明文 `summary`。载体要能装两种：一个 `_responseItems`
   （对应 ④ 族的 `_thinkingBlocks`），把上一轮 `output[]` 里 `reasoning` / `function_call` /
   `message` 条目**原样**带回，不解释内容。
2. **结构化输出只有官方有**。`jsonMode.ts` 的 Responses 分支要能对千问退回「强制工具」
   （现有的 `withJsonModeFallback` 学 400 就能覆盖，前提是千问对 `text.format` 是报错而不是
   忽略——**未验，接入前必测**）。
3. **函数参数的流式**。adapter 得同时接受"delta 拼接"与"`output_item.done` 整块到达"，
   不能只认前者。实测官方两者都有，且 `output_item.done` 的 `item` 就是回传用的完整条目
   （含 `encrypted_content`）——**收集 `output_item.done` 即可，不必自己拼**。
4. **中转站对 `text.format` 的 `strict:true` 会整个丢掉 `format`**（第八个样本），而
   省略 `strict` 端点自动升 strict——所以 `json_schema` 一律**不发 `strict`**。工具定义
   则相反：要非 strict 语义必须显式 `strict:false`，否则官方自动 strict。

### 4.3 本项目怎么落：第四个协议族

按 [`provider-standards.md`](provider-standards.md) 的契约，`ApiStandard` 加两个值
`openai_responses` / `openai_responses_compat`，`ProtocolFamily` 加 `"responses"`。
**不是**在 `openai` 族里加开关：body、流式、工具形状、回传义务四样全不同，
[`landscape.md`](landscape.md) §3 早说了"两族无法合并"。

分层（[`provider-layering.md`](provider-layering.md)）：

- **L1 协议族**：adapter `lib/ai/responses.ts`；`familyOf` 的 12 处调用点逐个过
  （`ModelDrawer`、`ProviderDrawer`、`endpointProbe`、`image`、`index`、`jsonMode`、
  `modelSummary`、`providerProbe`、`reasoning`、`serverTools`、`types`、`urls`），
  加 [`../reference/workflows.md`](../reference/workflows.md)「Add a new provider/API」的 11 步。
- **L2 端点**：`baseUrl` 与 ① 族同（官方 `https://api.openai.com/v1`，千问
  `https://dashscope.aliyuncs.com/compatible-mode/v1`），`/responses` 由 adapter 拼；
  `/models` 探测复用 ① 族的。`authMode` 无意义（都是 Bearer）。
- **L3 模型**：新增思考类目 `responses-effort`（`shape: levels`，`menu` 按代：
  `off/low/medium/high/xhigh/max`，`off` → `effort:"none"`），复用 `OPENAI_EFFORT` 词表；
  `summary:"auto"` 随 effort 一起发（不发就没有思维链可看，同 Gemini 的 `includeThoughts`）。
  5.6 的 `mode:"pro"` 先不做（是"更贵的另一档"，等作者要）。`structuredOutput`
  的 `json_schema` 档在此族映射到 `text.format`。

### 4.4 切片

1. **协议事实**：`landscape.md` §3 按上表扩写（现在那节还是 2026-08 的 o 系列口径），
   `streaming.md` / `tools.md` / `reasoning.md` 各加 ② 族一列。纯文档，先合。
2. **族与标准的水管**：`types.ts` 两个值 + family、`configDb` / `configTransfer` 两张
   allowlist、`urls.ts`、i18n、`ProviderDrawer` 的 `STANDARD_ENDPOINTS` 与选项、
   `providerProbe` / `endpointProbe`、`defaultImageCaps`。adapter 只做**纯文本流式**
   （`instructions` + `input` 字符串或 message 条目 → `output_text.delta` → `{text}`，
   `completed` → `{done, usage}`，`incomplete` → `truncated`，`failed` / `error` 事件 → throw）。
   `store:false` 无条件发（本项目自己保存历史，服务端存一份没有意义，且 ZDR 组织必须）。
3. **工具**：`tools` 扁平化 + `strict:false` 显式发（沿用 ① 族"非 strict"的语义，避免
   官方自动 strict 把现有 schema 拒掉）；`function_call_arguments.delta` 与整块两种到达
   方式都拼；`function_call_output` 回传；`_responseItems` 载体把上一轮 `reasoning`（含
   `encrypted_content`）/ `function_call` / assistant `message`（含 `phase`）原样带回。
   `tool_choice` 的强制档接现有 `toolChoice.ts` 的 400 学习。
4. **思考**：`responses-effort` 类目、`reasoning:{effort,summary:"auto"}`、
   `reasoning_summary_text.delta` 与 `reasoning_text.delta` 都进 `{reasoning}`。
5. **结构化输出**：`jsonMode.ts` 的 ② 族分支 → `text.format:{type:"json_schema",…}`；
   千问上按 400 学习退回强制工具。
6. **图片 / 文件**：`image_url` part → `input_image`（data URL 直传）；`file` part →
   `input_file`。
7. **实测**：`live.openai-responses.test.ts`（作者的 OpenAI key，GPT-5.4 / 5.5 / 5.6-luna
   各跑一遍）与 `live.qianwen.test.ts` 加 Responses 组；结果回填 `landscape.md`。

第 2 片合并后就能在设置里选到这个族并聊天；第 3 片后 agent 能用；第 4 片后思考可调可见。

### 4.5 开工前必须用 key 定掉的（两边各一把）

- 千问：`text.format` 是报错还是忽略；函数参数到底怎么流；流中错误事件形状；
  `reasoning` 条目**不回传**是否报错（Chat 面上带不带都行，这个面未验）；
  `input_image` 是否可用。**全部未验。**
- OpenAI（2026-09-03 经中转站已定，见 [`responses.md`](responses.md)）：
  - ✅ `strict` 缺省 → 自动 strict，`["string","null"]` 过；工具要非 strict 必须显式 `strict:false`。
  - ✅ `include_obfuscation:false` 无效，adapter 无视 `obfuscation` 字段即可。
  - ✅ 回传缺失（reasoning / encrypted_content / phase）都不报错——是"无现象"类，按官方推荐原样回传。
  - ✅ `reasoning_text.delta` 三款上不出现，摘要走 `reasoning_summary_text.delta`，且需发 `summary`。
  - ✅ `input_image` data URL 可用；`json_object` 需 "json" 字样。
  - ❌ 仍未定：`phase` 缺失的真实代价（样本太小）；`mode:"pro"` 与官方 ① 族"5.4 起思考不能带工具"
    （中转站翻译过，验不了）；5.6-sol 的多轮回传（中转站 502）。

## 5. 弃案

- **在 `openai_compat` 里加 `useResponses` 开关**：body、事件、工具、回传四样都不同，
  开关会把 `streamOpenAI` 变成两个 adapter 的 if 森林。
- **有状态模式（`previous_response_id` / `conversation`）**：本项目的历史在本地、
  可编辑、可中途换模型，服务端存一份会与本地分叉；`store:false` + 回传条目在两家都够用。
- **按品牌给千问 Responses 单独一个 `ApiStandard`**：它就是 ② 族的 compat，
  砍掉的部分靠 400 学习与作者声明，和 ① 族的做法一致。
- **给 kimi-k3 / MiniMax-M2.5 写 id 判断**：品牌在中继上不可见，报错足够明确，
  作者改类目即可（`provider-layering.md` §4）。

## 6. 执行顺序与验收

一片一个 PR，合并后停下来等作者真机；每片的验收写成"跑什么、看什么"，不写"应该没问题"。

| 序 | 片 | 改什么 | 验收 |
| --- | --- | --- | --- |
| A ✅ | §3 第 1 片 | `reasoningBody` deepseek `off` → 顶层 `thinking:{type:"disabled"}`；翻转 `aiClient.test.ts` 的断言；`reasoning-plan.md` §0 与 `thinking-verification.md` 4.2 收尾 | `QIANWEN_KEY=… vitest run live.qianwen.test.ts`：`deepseek category off` 一组 7 条全绿（现状 5 条红）；作者在 DeepSeek 官方端点上选 deepseek 档、关思考，API 日志里响应无 `reasoning_content` |
| B ✅ | §3 第 2 片 | 预设「通义千问 (Claude 格式)」；`modelLimits.ts` 补 3.7/3.8 代等 7 条上限；`thinkingCatGlmHint` 加「仅 GLM」 | vite 预览点预设核对 name / standard / baseUrl / authMode；`localeParity.test.ts`；作者用千问 key 走「测试连接」→ 判通（无 `/v1/models` 的降级路径） |
| C ✅ | §4.4 第 1 片 | `landscape.md` §3 按 [`responses.md`](responses.md) 重写（现在是 2026-08 的 o 系列口径）；`streaming.md` / `tools.md` / `reasoning.md` 各加 ② 族一列 | 纯文档；审阅每条是否能对应 `responses.md` 里的一次请求 |
| D ✅ | §4.4 第 2 片 | `openai_responses` / `openai_responses_compat` 两个值 + `responses` 族的全部水管（12 处 `familyOf` 调用点、两张 allowlist、i18n、`STANDARD_ENDPOINTS`、探测、`defaultImageCaps`）；adapter 只做纯文本流式，`store:false` 无条件发，**永远发 `instructions`**。落地时多带了三样、少了一样：user 消息的 `image_url` / `file` part 已按 `input_image` / `input_file` 映射（不映射就是静默丢图；H 片只剩实测与用例）；别的供应商留下的 `tool_calls` / `tool` 历史按裸 `function_call` / `function_call_output` 条目过桥（§5 第 4 种写法）；`reasoning_summary_text.delta` 的读侧已进 `{reasoning}`（F 片只剩发送侧）。**没发 `tools`**（E 片），所以带工具的界面在这一族上只得到散文回答；思考类目默认 `off`、结构化输出默认 `off`，F / G 各自接管 | `tsc`（`STANDARD_ENDPOINTS` 是 `Record<ApiStandard,…>`，漏一处就红）；`responses.test.ts`（按「一模块一测试文件」单开，不塞进 `aiClient.test.ts`）：delta / usage / `incomplete` → truncated / `failed` 与 `error` 事件 → throw / 带 `obfuscation` 的 delta 不影响文本；作者在设置里选到该族、对话能出字 |
| E ✅ | §4.4 第 3 片 | 工具：扁平 `tools` + 显式 `strict:false`；`function_call_arguments.delta` 与 `output_item.done` 两种到达都拼；`function_call_output` 回传；`_responseItems` 载体原样带回 `reasoning` / `function_call` / assistant `message`；强制 `tool_choice` 接 `toolChoice.ts`。落地补了一条：载体带 `modelId`（同 `_thinkingBlocks` 的理由——加密推理对别的模型是不透明的），模型换了就退回裸 `function_call` 写法；`_responseItems` 由 `agent/runtime.ts` 随 `_reasoning` / `_thinkingBlocks` 一起搬上 assistant 消息，是它唯一的消费者 | 单测（`responses.test.ts`）：一次含 reasoning + function_call 的流 → `toolCalls` 一条、`_responseItems` 两条且 `encrypted_content` 原样，只有 delta / 只有整块 / 并行乱序三种到达都拼齐，回传时同模型用原条目、换模型退回裸写法；作者跑一次续写 agent 模式，API 日志第二轮 `input` 里能看到上一轮的 reasoning + function_call 条目 |
| F | §4.4 第 4 片 | `responses-effort` 类目（`off/low/medium/high/xhigh/max`，`off` → `none`）；`reasoning:{effort,summary:"auto"}`；`reasoning_summary_text.delta` → `{reasoning}` | 单测：每档的 wire 串；作者在 gpt-5.4 上选 `max` 应得到端点 400（这是对的，5.4 到 `xhigh`）——**不做**按模型裁剪 menu，同 ① 族"端点 400 是声明"的做法 |
| G | §4.4 第 5 片 | `jsonMode.ts` ② 族分支 → `text.format:{type:"json_schema",name,schema}`，**不发 `strict`**；千问上按 400 学习退回强制工具 | 单测：body 里 `text.format` 无 `strict` 键；作者跑一次条目生成 |
| H | §4.4 第 6 片 | `image_url` → `input_image`（data URL 直传）、`file` → `input_file` | 作者发一张图 |
| I | §4.4 第 7 片 | `live.openai-responses.test.ts`（`OPENAI_KEY` 或中转站 key）；结果回填 `responses.md` §9 与 `landscape.md` | 三款模型各一遍，含多轮回传；把 §4.5 剩下的三条定掉 |

A、B 各自独立，可先行；C 独立；D→E→F→G→H→I 严格串行（每片都建立在上一片的 adapter 上）。
A 合并前 `live.qianwen.test.ts` 里那条 `deepseek category off` 会红，这是故意的验收锚点。

**不在计划里**：有状态模式、`reasoning.mode:"pro"`、内置工具（`tool_search` / `apply_patch` /
`hosted_shell`）、Conversations API——等作者有明确场景再议（§5 弃案里写了为什么）。

