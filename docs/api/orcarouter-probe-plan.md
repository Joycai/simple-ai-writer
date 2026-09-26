# OrcaRouter 付费实测：三家官方协议的结构与特性（方案）

> **状态**：done（2026-09-26 起草、同日测完）。§7 是逐条的「测了什么 → 落在哪」。
>
> 这份文件写**这一轮要测什么、怎么测、结果落到哪**。测出来的协议事实不写在
> 这里——它们进 `landscape.md` 第十八个样本与各主题文件；这里只留方案与取舍。

## 1. 为什么测、测到什么程度算数

- 第七个样本（2026-09-03）是**零余额 key**，只测到探测与免费档；付费模型的
  任何生成都在「未测」里。本项目对 ②③④ 的大部分事实来自中转站（New API 各
  渠道），**`api.openai.com` / `api.anthropic.com` / Google 官方端点一次都没打
  过**——`responses.md` 开头、`gpt56-plan.md`、`thinking-verification.md`
  都这么写着。
- OrcaRouter 自称 ③④ 是**直接透传**、① ② 对 OpenAI 模型原生转发，所以它是
  目前能拿到的最接近官方的线路。但它仍是中继，**每条结论都要分两类记**：
  - **官方形态**：带透传证据才算（见 §3），否则只能写「经 OrcaRouter 观察到」。
  - **OrcaRouter 自己的行为**：翻译、改写、吞字段、加字段、错误信封、计费头。
- 与既有文档**冲突**的两处优先解决（冲突比空白更伤）：
  - `capability-matrix.md` 说 Google `jsonSchema ✓ measured`，
    `structured-output-plan.md` 说 `responseJsonSchema` 未验证、无真实样本。
  - `capability-matrix.md` 说 Anthropic `web_search ✓ measured`，
    `thinking-verification.md` §2.7 说官方端点「全部未验」——那个 ✓ 很可能来自
    第十六个样本的 CC 渠道，不是官方。

## 2. 选模型（第 0 步，免费）

先读 `GET /v1/models`（Bearer），按 `supported_endpoint_types` 为每族挑**当前
旗舰 + 一个便宜档**，不预设 id——目录是活的。候选方向：

| 族 | 旗舰（能力面最全） | 便宜档（跑多数形状用例） |
| --- | --- | --- |
| ① ② OpenAI | GPT-5.6 系（sol / luna 若在） | 最小的 GPT-5.x mini/nano |
| ④ Anthropic | Opus 5 / Sonnet 5（adaptive thinking） | Haiku 4.5（`budget_tokens` 旧式） |
| ③ Gemini | Gemini 3.x Pro（`thinkingLevel`） | Gemini 3.x Flash / 2.5 Flash（`thinkingBudget`） |

同一步：确认余额、`X-OrcaRouter-Include-Cost: true` 让每次响应带
`usage.cost_usd`（③ 是 `usageMetadata.costUsd`），记下 `X-Orca-Request-Id`，
抽一条用 `GET /v1/generation?id=` 对账。

## 3. 透传证据（判定一条观察能不能算「官方形态」）

| 族 | 透传的迹象 | 被翻译/伪造的迹象（第七个样本见过） |
| --- | --- | --- |
| ④ | `thinking.signature` 是长的不透明 base64；`id` 为 `msg_01…`；`usage` 带 `cache_creation` 分项、`service_tier` | `signature` 等于 message id；usage 只有两个数 |
| ② | `reasoning.encrypted_content` 可回灌；`resp_…` id；`output_text` 带 `annotations` | 事件序列缺 `response.output_item.added` 等官方必有事件 |
| ③ | `thoughtSignature` 出现且回灌生效；`modelVersion`、`responseId` | `parts: []` 而 `thoughtsTokenCount` 为 0（第七个样本的 Qwen 翻译件） |
| ① | `system_fingerprint`；OpenAI 形态的 `usage.*_details` | — |

另外记录响应头里漏出来的上游头（`anthropic-ratelimit-*`、`request-id`、
`openai-processing-ms`、`x-goog-*`），有就是强证据。

## 4. 探针清单

先 curl（`max_tokens` 压到 16–512，非流 + 流各一次），把形状看清；再进 §5 的
live 测试。每条后面是它要关掉的那个未决项。

### ② OpenAI Responses（`/v1/responses`，GPT-5.x）

1. 流式事件全序列，确认 `response.reasoning_text.delta` 是否出现（`responses.md` §9）。
2. `store:false` + `include:["reasoning.encrypted_content"]` 回灌多轮；**不带**
   `include` 时只回 id 的 reasoning item 是否 400。
3. 函数调用往返 + 并行工具调用的事件交错；5.6 多轮 round trip、`phase`。
4. `web_search` 工具，带/不带 `include:["web_search_call.action.sources"]` 对照。
5. `reasoning.effort` 全档（`none`…`xhigh`/`max`）哪档 400；`reasoning.mode:"pro"`、
   `background`、`previous_response_id`、`truncation` 各一发——中继上多半不支持，
   要记的是**怎么失败**。
6. strict `json_schema`（`text.format`）；`input_file`（PDF）。

### ① OpenAI Chat Completions（`/v1/chat/completions`，同一批 GPT）

7. `reasoning_effort ≠ none` + `tools` 同发（「5.4+ 不能同时用」的说法）。
8. GPT-5 发 `temperature ≠ 1`。
9. `stream_options.include_usage` 的 usage 块位置与 `*_details`。
10. `web_search_options`（第七个样本未测）。
11. **跨族翻译**（记为 OrcaRouter 行为）：Claude / Gemini 模型走 ①，思维链落在
    哪个字段（`thinking-verification.md` §1.3）、`reasoning_effort` 是否真翻成
    `budget_tokens` 1280/2048/4096（看 usage 里的思考 token 数）。

### ④ Anthropic Messages（`/v1/messages`）

12. adaptive thinking 是否真出 `thinking` block、`display` 摘要 vs 计费 token
    （§1.1、§2.1）；`output_config.effort` 是否透传（§2.3）。
13. 新模型发 `budget_tokens` 的报错原文、Haiku 4.5 上 `budget_tokens` 正常（§1.4、§2.4）。
14. thinking + tool_use 往返；**故意丢掉** thinking block 回灌，看 400 原文。
15. `cache_control` 两连发：`cache_creation_input_tokens` → `cache_read_input_tokens`
    （§2.8），顺带测最小可缓存长度。
16. `web_search_20250305` 不带 beta 头、`usage.server_tool_use.web_search_requests`、
    `pause_turn` 续写（§2.7；解决 §1 的冲突）。
17. 结构化输出：`output_config.format` json_schema 是否透传（本项目 ④ 恒为 `off`，
    若官方已支持则是新事实）；`count_tokens` 端点是否路由。
18. base64 图片输入（第七个样本说 ④ 是给 Claude 看图的正路）。

### ③ Gemini（`/v1beta/models/google/…:generateContent` / `:streamGenerateContent?alt=sse`）

19. `includeThoughts:true` 下 `part.thought` 的形状、`thoughtSignature` 挂在哪类
    part 上（§1.2，`gemini-plan.md` 最重要的未决项）。
20. Gemini 3 在经典 `generateContent` 上的思考形态（`landscape.md` 3.x 段）；
    `thinkingLevel` 各档 vs `thoughtsTokenCount`（§3.2）；3.x Pro 拒不拒 `MINIMAL`（§3.1）。
21. functionCall 往返：带 / 不带 `thoughtSignature` 回灌的差别。
22. `responseJsonSchema` vs `responseSchema`（解决 §1 的冲突）。
23. `googleSearch` / `codeExecution` / `urlContext` 的回包（`groundingMetadata`、
    `executableCode` / `codeExecutionResult` part）。
24. 流式 chunk 里 `usageMetadata` 出现在哪几块；`inlineData` 驼峰图片输入（§3.3）；
    `countTokens`（文档说不路由，记失败形态）。

### 横切

25. 每面一个故意的 400（非法参数）：错误信封是上游原样（`claude_error` /
    `gemini_error`）还是 OrcaRouter 信封；尽量触发一次流中错误。
26. 四面的 usage 与 `cost_usd` 对 `GET /v1/generation` 是否一致——喂给计费组
    文档里「上游报价」那一侧。

## 5. 仓库里的交付

1. **离线先行（不花钱）**：用 OrcaRouter 的 id 形态（`anthropic/claude-sonnet-4.6`，
   **点号**版本 vs 官方的 `claude-sonnet-4-6`）过一遍所有按模型 id 查表的地方
   （`normalizeModelId`、输出上限表、strict schema 名单、`capabilities.ts` 的正则、
   上游推断），查漏匹配。
2. **`src/lib/ai/__tests__/live.orcarouter.test.ts`**：`ORCA_KEY`（名字待定）缺失即
   整组 skip；按 `platforms.ts` 的 orcarouter preset 走**真实 adapter**
   （`streamCompletion`），四个 standard 各一组：基本流 + usage、思考档位、工具
   往返（含回灌）、结构化输出（`jsonModeShaping`）、图片输入、服务端工具
   （能开的）、错误。修复前跑一次、修复后跑一次。
3. **文档**：`landscape.md` 新增**第十八个样本**（`> **怎么测的**：` 开头，点名测试
   文件），第七个样本的「未测」逐条改口并链过去；协议事实落到 `responses.md` /
   `reasoning.md` / `structured.md` / `tools.md` / `usage.md` 与
   `issues/thinking-verification.md` 对应条目；`capability-matrix.md` 与
   `platforms.ts` 的 `source` 把 `? unmeasured` 换成实测。
4. **探针逼出来的修复**：各自单独 commit，理由进对应文档。
5. 分支改名 `docs/orcarouter-paid-probe`（或含修复时 `fix/`），开 PR 到 `main`，
   CI 绿即停。
6. **之后**：以合并后的 docs 为准更新 `ai-agent-architecture` skill
   （先重读 replica 当前结构与计数，新坑按组续号，打包 `.skill` 给作者上传）。

## 6. 花费与安全

- key 只在命令行环境变量里，每条命令 `zsh -lic` 载入、只打印长度；不进任何
  仓库文件、不进日志、不进文档。
- 旗舰模型只跑「只有它能回答」的用例，其余全用便宜档；思考用例给
  `max_tokens` 上限。按 `cost_usd` 累计，**预计 $2–6，到 $10 停下问作者**。
- 发现与 OrcaRouter 文档不符的地方（第七个样本已发现两处过时）照实记，不替它圆。

## 7. 结果（2026-09-26）

**§1 的前提被推翻了一半**：作者记得这台网关是透传的。回包看，③④ 确实是 Vertex AI / Anthropic
原样；但①与②的默认线路是一层 OpenRouter 形态的翻译（`gen-…` id、伪造的 item id、改写的
`summary`），② 只在 `store:true` 或 `include` 含 `web_search_call.action.sources` 时换到 OpenAI 原样；
而且**四面的请求都被网关重新序列化**，未知字段与非法枚举常被静默丢掉。所以记录时按「回包形状可当
官方、会不会 400 只对网关成立」分开（第十八个样本开头的表）。

| 计划项 | 结果 | 落在 |
| --- | --- | --- |
| 离线 id 审计（§5.1） | `gpt-6` 不在 strict schema 名单与输出上限表；`gemini-3` 不在输出上限表；Claude 按设计不查表 | 修：`jsonMode.ts` / `modelLimits.ts` |
| ② 1–6 | 事件序列、effort 各档（`minimal`→`low`）、web_search 两条线路、strict `text.format` 已测；回灌义务、`pro` / `background` / `previous_response_id` 被网关挡住测不出 | 第十八个样本 ② 段；`usage.md` |
| ① 7–11 | 走 OpenRouter 形态，「5.4+ effort+tools」无法证伪；strict schema 与跨族思维链字段已测 | 第十八个样本 ① 段 |
| ④ 12–18 | 默认思考 + `omitted`、`thinking_tokens`、回灌三种变体、缓存（块级与顶层）、web_search 无 beta 头、`output_config.format`、图片已测；`count_tokens` 不路由 | 第十八个样本 ④ 段；`reasoning.md` §2.2；`tools.md` §6；`structured.md` §1；`thinking-verification.md` |
| ③ 19–24 | 思考形状与签名位置、`MINIMAL` 被拒、档位单调、budget 0 关不掉、`functionCall.id`、回灌变体、两种 schema、三个内置工具、驼峰 / 蛇形图片已测；`countTokens` 被当生成执行 | 第十八个样本 ③ 段；`reasoning.md` §1.4；`tools.md` §5；`structured-output-plan.md` §11.5 |
| 25–26 | 错误信封被改写（③ OpenAI 形、④ `type:"<nil>"`、路径被遮）；cost 字段按面不同、② 原样线路没有 | 第十八个样本「网关自己的东西」 |
| live 测试 | `live.orcarouter.test.ts`：修复前 23/28，修复后 28/28 | — |

**探针逼出来的修复**（各自的理由写在代码注释与第十八个样本里）：

1. Gemini「关闭」`MINIMAL` → `LOW`（`reasoning.ts` `GEMINI_LEVEL`）：3.8 Flash 对 `MINIMAL` 回 400，
   「尽量少想」这一档报错是最坏的结果；多想几百 token 是便宜的那一边。
2. Gemini 回灌跳过光秃秃的 `{text:""}`（`gemini.ts`）：流式工具轮的第二轮在 Vertex 上必 400。
3. `orcarouter` 能力格子按实测填（`capabilities.ts`），`capability-matrix.md` 重新生成。

**留作后续、本轮不做**：④ 的 `output_config.format` 已证明可用，本项目 ④ 族结构化输出仍恒为
`off`——要不要按型号打开是另一个决定（型号范围、与思考 / 强制工具能否同用都还没测）。
