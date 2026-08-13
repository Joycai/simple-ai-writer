# 思考强度与思维链方案（reasoning effort / reasoning content）

> **状态：OpenAI Chat Completions 族已完整实现** —— 写侧（强度）、读侧
> （思维链 chunk）、回传合规、面板控件、以及结构化输出兜底路径的原生约束
> （§8）。**未做**：Gemini / Anthropic 族的映射，以及思维链的展示 UI。
>
> 本文是动手前的协议对比与取舍记录 —— 四家 API 在这件事上的分歧比表面看起来
> 大得多，且大部分分歧无法在代码里"事后发现"，只能提前决定怎么取舍。
> 实现推进时请回来更新每节的状态。
>
> 目标：让作者能为**单个模型**配置思考强度，并（可选）看到模型的思维链；
> 同时不破坏现有的 agent 工具循环与结构化输出路径。
>
> 前置阅读：[`provider-standards.md`](provider-standards.md)（6 个 `ApiStandard`
> 值、official/compat 契约）—— 本文的每一条"默认不发"都源自那里的 compat 契约。
>
> 协议事实已迁至 [`api/reasoning.md`](api/reasoning.md)、
> [`api/tools.md`](api/tools.md) 与 [`api/structured.md`](api/structured.md)；
> §2 / §3 的对比表保留为速查，以那三份为准。本文其余部分是**本项目的取舍**。

---

## 1. 两件不同的事

这个需求习惯被当成一件事说，实际上是两件，兼容性代价差一个数量级：

| | 写侧：思考强度 | 读侧：思维链 |
| --- | --- | --- |
| 做什么 | 请求体里多一个字段 | 解析新的流式事件 + 决定要不要回灌历史 |
| 四家分歧 | 档位名接近，语义不同 | 字段名、载体、回传义务**全不一样** |
| 风险 | 发错 → 400 | 不回传 → 多轮/工具调用直接失败 |
| 可回退 | 不发即回到今天 | 回传逻辑写错会打坏 agent 循环 |

**结论：写侧先做，读侧后做，回传合规单独一刀。** 见 §7 的 PR 切片。

---

## 2. 写侧：四家的强度控制

| 协议 | 参数位置 | 档位 | 默认 | 关闭 |
| --- | --- | --- | --- | --- |
| **OpenAI** Chat Completions | 顶层 `reasoning_effort` | `none / minimal / low / medium / high / xhigh / max`，**每个模型只支持子集** | 模型自定（gpt-5.x = `medium`） | `reasoning_effort: "none"` |
| **OpenAI** Responses | `reasoning: { effort, summary }` | 同上 | 同上 | 同上 |
| **DeepSeek** | 顶层 `reasoning_effort` + 顶层 `thinking: { type }` | 声明 `low/high/max`，**实际只有三档**：`medium`/`xhigh` 被吞成 `high` | **默认开**，effort = `high` | `thinking: {"type":"disabled"}` |
| **Anthropic** 新代（4.6+ / 5） | `output_config: { effort }`，配 `thinking: {"type":"adaptive"}` | `low/medium/high/xhigh/max`（`xhigh`、`max` 各自只有部分模型有） | `high`（= 不传） | `thinking: {"type":"disabled"}` |
| **Anthropic** 旧代（4.5 及更早） | `thinking: {"type":"enabled", "budget_tokens": N}` | **数值预算**，≥ 1024 且 < `max_tokens` | 关闭 | 省略该字段 |
| **Gemini** 新代 | `generationConfig.thinkingConfig.thinkingLevel` | `minimal/low/medium/high` | 动态 | 不可关（仅 flash-lite 默认关） |
| **Gemini** 2.5 代 | `generationConfig.thinkingConfig.thinkingBudget` | `-1` 动态 / `0` 关 / 具体 token 数 | 动态（`-1`） | `0`，但 2.5 Pro 拒绝 |

DeepSeek 另有 Anthropic 风格（`reasoning: {effort: none|low|high|max}`）与
Responses 风格（`output_config: {effort}`）两套等价写法。本项目只走
`/chat/completions`，用 OpenAI 风格那套即可。

### 2.1 四个真正的坑

1. **档位词一样，语义不一样。** `low/medium/high` 是最大公约数，但 DeepSeek 的
   `medium` 等于 `high`，OpenAI 的 `minimal`/`none` 只有部分模型有，Anthropic 的
   `xhigh`/`max` 也是。**不能把 UI 选中的字符串直接透传** —— 同一个"中"在不同
   模型上行为不一致，还可能 400。必须存"作者意图的抽象档位"，由各 adapter 映射。

2. **"关闭"不是通用能力。** Gemini 2.5 Pro 关不掉；Claude Opus 5 在 `xhigh`/`max`
   effort 下收到 `thinking:{type:"disabled"}` 会 400。关闭只能是 best-effort 语义，
   UI 必须写明，不能承诺。

3. **Anthropic 新旧代互斥，且代次不可从模型名可靠判断。** 4.7+ 收到
   `thinking:{type:"enabled"}` 直接 400；4.5 及更早不认 `output_config`。在
   `anthropic_compat` 中继上模型名是作者手填的字符串（见
   `lib/ai/modelLabel.ts` 解析的那些 `特价kiro | claude-opus-4-6-thinking` 形态），
   猜代次不可靠。**只能默认不发 + 失败降级。**

4. **采样参数冲突 —— 本项目天然躲过了，别把它捡回来。** DeepSeek 思考模式不支持
   `temperature`/`top_p`/`presence_penalty`/`frequency_penalty`，OpenAI 推理模型
   同样不支持 `temperature`。而 `openai.ts:19` 与 `gemini.ts:113` 的 body 里
   本来就没有这些字段。**加思考强度的这一版，不要顺手加"温度"设置**，否则两个
   功能会在同一批模型上互相打架。

---

## 3. 读侧：四家的思维链

| 协议 | 流式字段 | 多轮/工具调用是否必须回传 |
| --- | --- | --- |
| **OpenAI 官方** | **没有内容**。只有 `usage.completion_tokens_details.reasoning_tokens` 计数 | — |
| **OpenAI** Responses | `reasoning.summary`（需 opt-in `summary: auto/concise/detailed`）+ `encrypted_content` | 无状态（`store:false`）时要回传 `encrypted_content` |
| **DeepSeek** / 多数兼容中继 | `delta.reasoning_content`（DeepSeek 官方）；OpenRouter 等用 `delta.reasoning`；部分中继内联 `<think>…</think>` | 无工具：**不必**（回传会被忽略）；**有工具调用：必须原样回传，否则 API 直接 400**，且「后续所有 user 交互轮次」都要带 |
| **Anthropic** | `content_block_delta` → `thinking_delta.thinking` + `signature_delta.signature` | 工具轮**必须**带 thinking block 及其 signature |
| **Gemini** | `part.thought === true` 的文本 part + `thoughtSignature` | **必须**回传 `thoughtSignature` |

### 3.1 本项目现状

- `gemini.ts:207` 用 `part.text && !part.thought` 过滤掉思考文本；`thoughtSignature`
  已经通过 `geminiAllModelParts` → `StreamChunk._geminiModelParts` →
  `StreamMessage._geminiModelParts` 原样回传。**Gemini 的回传合规性已经做完了**，
  缺的只是"把思考文本显示出来"。
- `anthropic.ts:442` 明确丢弃 `thinking_delta` / `signature_delta`，注释理由是
  "本 app 没有展示推理文本的界面，且 token 已计入 usage"。**回传合规性没做** ——
  今天不出问题，是因为 `thinkingFor`（`anthropic.ts:240`）在 forced tool 时禁用了
  思考，而普通 agent 轮次里 Claude 的 thinking block 缺失暂时被服务端容忍。
  这是新代模型的行为，不是可以依赖的契约。
- ~~`openai.ts` 只读 `delta.content`，`reasoning_content` 被静默丢弃。~~ **已修**，
  且这不只是"少了个展示"：DeepSeek 的推理模型在本 app 的工具循环里此前**必然
  失败** —— 第 1 轮发出工具调用，第 2 轮把 assistant 消息拼回去时缺
  `reasoning_content`，API 400。思考默认是开的，所以这是默认路径。
  单次流式任务（润色/改写/摘要）不受影响：它们不回传 assistant 消息。
- token 计数三家都已经对齐：Gemini 手动把 `thoughtsTokenCount` 折进 output
  （`gemini.ts:230`），Anthropic 的 `output_tokens` 本就含 thinking，OpenAI 的
  `completion_tokens` 也含 reasoning。**成本核算不需要改。**

---

## 4. 目标模型

### 4.1 数据

配置粒度是 **per-model**，落在 `configDb.ts:86` 的 `Model` 上 ——
`contextSize` / `maxOutput` / `probedAt` 已经是这个粒度，且同一 provider 下
reasoner 与普通模型混在一起，per-provider 粒度表达不了。

```ts
// lib/ai/configDb.ts → interface Model
/**
 * 作者为这个模型选的思考强度。"default" 或 undefined = 什么都不发，
 * 用服务端自己的默认值 —— 这是唯一对所有 compat 中继都安全的取值。
 */
reasoningEffort?: "default" | "off" | "low" | "medium" | "high" | "max";
/**
 * 思考 token 预算。仅 Anthropic 旧代与 Gemini 2.5 代用得上；两者都是
 * 数值语义而非档位语义，无法从 reasoningEffort 无损推导，所以单列。
 */
thinkingBudget?: number;
```

"要不要展示思维链"是**全局 UI 偏好**（"我想不想看"），生命周期与"这个模型怎么跑"
不同，因此加进 `lib/prefs.ts` 的 `PREF_KEYS`，不进 `Model`。

### 4.2 映射表放一处

新增 `lib/ai/reasoning.ts`，与 `lib/ai/jsonMode.ts`（per-protocol 请求整形）同构：
adapter 只调用它拿一段 body 片段合并进去，永远不自己写档位字符串。

| 项目档位 | OpenAI / DeepSeek | Anthropic 新代 | Anthropic 旧代 | Gemini 新代 / 2.5 |
| --- | --- | --- | --- | --- |
| 跟随默认 | 不发 | 不发 | 不发 | 不发 |
| 关闭 | `reasoning_effort:"none"` + `thinking:{type:"disabled"}` | `thinking:{type:"disabled"}` | `thinking:{type:"disabled"}` | `thinkingLevel:"minimal"` / `thinkingBudget:0` |
| 低 | `"low"` | `effort:"low"` | budget 2048 | `"low"` / 2048 |
| 中 | `"medium"` | `effort:"medium"` | budget 8192 | `"medium"` / 8192 |
| 高 | `"high"` | `effort:"high"` | budget 16384 | `"high"` / 16384 |
| 最高 | `"max"` | `effort:"max"` | budget 32768 | `"high"` / `-1` |

`thinkingBudget` 有显式值时覆盖档位推导出的数值（仅对那两条数值语义的路径生效）。

### 4.3 读侧的形状

`StreamChunk`（`types.ts:133`）新增一个变体：

```ts
| { reasoning: string }
```

**纯加法。** 现有 8 处 `"text" in chunk` 的消费者（`aiTaskStore.ts:563`、
`agent/runtime.ts:328`、`agent/structured.ts:108,132`、`agent/compactRun.ts:141`、
`lore/vision.ts:99`、`memoryStore.ts:121`、`ai/apiLog.ts:180`）全部不受影响，
只有需要展示的地方去接新变体。

附带好处：`lib/ai/json.ts` 与 `agent/structured.ts` 今天靠"从推理散文里抠 JSON"
兜底（`json.ts:3` 的注释就是为此写的），思维链从正文里分离出来之后，那条
兜底路径会干净很多。

### 4.4 回传（已实现，形状与原计划不同）

原计划是把 `_geminiModelParts` 泛化成一个不透明的 `_native?: unknown`。
实际做成了一个**有类型的** `_reasoning?: NativeReasoning`：

```ts
interface NativeReasoning { field: string; text: string }
```

改主意的理由：不透明 blob 把"谁写的谁读"变成一条只能靠注释维持的约定，
而这里真正需要记住的东西只有两样 —— 文本，和**它是从哪个字段名来的**。
把字段名和文本绑在一起，回传规则就变成一句与厂商无关的话：**模型给了什么，
就用它给的那个名字还回去**。`reasoning_content` 还是 `reasoning`，代码不需要
知道，也就不会因为下一家用了第三个名字而失效。

`_geminiModelParts` 保持原样：它承载的是 thought signature，与这条正交。

策略仍是**默认不回灌**、**只在有工具调用的那一轮**带上 —— 无工具时那些端点
本就忽略它，回传只是白花 token。

---

## 5. 取舍记录（为什么是这样）

1. **默认必须是"跟随服务端默认"（什么都不发）。** 本 app 的主力场景是
   `*_compat` 中继，任何主动发送都可能撞上某个中继不认的字段。四家的默认行为
   本来就是"开且 high"，不发已经是好行为。这条与 `provider-standards.md` §2.2
   的 compat 契约（默认值保守）一致。

2. **Anthropic 只发 `output_config.effort`，`budget_tokens` 留作高级项。**
   理由见 §2.1 坑 3。配一次 400 降级重试：识别错误信息里的
   `output_config` / `thinking.type.enabled` 关键字后改用另一套写法。
   `lib/ai/modelHealth.ts` 与 `lib/ai/probeAnalysis.ts` 已有"读错误信息做判断"
   的先例可复用。

3. **`anthropic.ts:240` `thinkingFor` 的优先级保持最高。** forced tool 时依然
   无条件 disable 思考 —— 否则 `agent/structured.ts` 那批结构化任务（一致性
   检查、lore improve、条目拆分）全部退化到 JSON fallback，静默丢掉 schema 约束。
   该函数的注释里已经预警过这件事，实现时不要绕开它。

4. **不迁移 Responses API。** OpenAI 文档建议推理模型走 Responses，但本项目的
   compat 中继绝大多数只实现 `/chat/completions`；迁过去等于砍掉大半 provider。
   代价是拿不到 OpenAI 官方模型的 reasoning summary —— 接受，因为官方
   Chat Completions 本来也不返回推理内容，损失的只是"本来就没有的东西"。

5. **不做 per-task 的强度覆盖。** 概念上"一致性检查用低强度、续写用高强度"很诱人，
   但它会与 profile 的任务列表（每个 profile 可定义任意多个任务）正交相乘，
   配置面爆炸。如果以后要做，应该做在 preset 层（`agent/presets.ts`）而不是
   任务层，且只表达"降级"不表达"升级"。

---

## 6. 改动清单

| 文件 | 改动 |
| --- | --- |
| `lib/ai/reasoning.ts` | **新增**：抽象档位类型 + 四条映射 + `effortBody(family, model)` |
| `lib/ai/configDb.ts` | `Model` 加 `reasoningEffort` / `thinkingBudget`，含 schema 迁移与读写 |
| `lib/ai/types.ts` | `StreamOptions` 透传两个新字段；`StreamChunk` 加 `{reasoning}`；`_geminiModelParts` → `_native` |
| `lib/ai/openai.ts` | 请求：合并 `effortBody`；响应：解析 `delta.reasoning_content` / `delta.reasoning` |
| `lib/ai/anthropic.ts` | 请求：`output_config` + 降级重试，保留 `thinkingFor` 优先级；响应：`thinking_delta` |
| `lib/ai/gemini.ts` | 请求：`generationConfig.thinkingConfig`；响应：`part.thought` 的文本改为 emit `{reasoning}` 而非丢弃 |
| `components/settings/panes/` | 模型抽屉加"思考强度"下拉 + 说明文案 |
| `lib/prefs.ts` | `PREF_KEYS` 加"显示思维链" |
| `components/ai/` | AiPanel / AgentLog 的思维链折叠区 |
| `i18n/locales/` | 档位名、说明、"部分模型不支持关闭或不支持全部档位"提示 |

---

## 7. PR 切片

按"打坏东西的风险"从低到高：

1. ✅ **映射表 + 数据字段**（`reasoning.ts` + `Model.reasoningEffort` + 列迁移）。
2. ✅ **写侧接线 —— OpenAI 族**。`ConnOptions` 加一个字段就贯穿了全部 18 个调用点，
   这正是 [`provider-layering.md`](provider-layering.md) §6 那一刀要买的东西。
   ⬜ Gemini / Anthropic 族的映射与 Anthropic 的降级重试。
3. ✅ **模型抽屉 UI + i18n**（仅对 OpenAI 族渲染 —— 不给一个按了没反应的控件）。
4. ◐ **读侧 chunk 变体**（`{reasoning}`）✅；**展示**（AiPanel / AgentLog 的折叠区
   + prefs 开关）⬜。
5. ✅ **回传合规 —— OpenAI 族**（`_reasoning` + 工具轮回传 + 请求前剥离内部字段），
   含 `agentRuntime.test.ts` 的多轮工具用例。⬜ Anthropic 的 thinking block 回传。

### 第 1–3 步的落地记录

- `thinkingBudget` **没有实现**。它只对 Anthropic 旧代与 Gemini 2.5 有意义，
  两者的写侧都还没接，先加一个没有读者的字段只会变成噪音。
- DeepSeek 的 `thinking: {type}` 开关**故意不发**。`reasoning_effort: "none"`
  已经能表达"关闭"，而 OpenAI 官方端点会拒绝不认识的顶层参数 —— 为一个方言
  字段冒险打断官方路径不划算。这是 §5 分类里的"长尾"处理。
- 六档中省略了 OpenAI 的 `minimal` 与 `xhigh`。它们夹在已有档位之间，而
  "并非每个模型支持每个值"这条规则总是先在边缘档位上应验。
- 存储上 `"default"` 归一化为 `undefined`，所以 DB 行不区分"从未设置"与
  "设成了默认" —— 两者要发送的东西完全一样。

### 第 4–5 步（OpenAI 族）的落地记录

- **这一刀修的是 bug，不是加功能。** 见 §3.1：DeepSeek 推理模型在工具循环里
  此前必然 400。
- **没有出现任何 provider 名字。** 读取端是一张字段名候选表
  （`REASONING_CONTENT_FIELDS`），回传端用"收到时是什么名字就用什么名字"。
  支持下一家的成本是往那张表里加一个字符串，而不是加一个分支。
- **请求前剥离 `_` 前缀字段**（`toWireMessages`）。此前 `_geminiModelParts`
  会原样出现在 OpenAI 请求体里 —— 实践中没炸，但那是运气：严格校验入参的端点
  有权拒绝未知键，宽松的端点则是白付 token。
### 面板控件（AI 面板三处）的落地记录

设计依据是 claude.ai/design 上「Simple AI Writer UI redesign」的
「02 AI 面板」一稿：一个「思考」拨盘 + 一个「力度 / effort」拨盘，不支持的那
一组按停用样式渲染并写明原因。三处入口：生成（AiPanel，紧接「窗口占用」行
下方）、对话助手（输入区附件行尾）、一致性检查（筛选行 + 空状态）。

三个决定，都不是显而易见的那一个：

1. **控件改的是模型设置，不是单次覆盖。** 思考深度是模型的属性（见
   [`provider-layering.md`](provider-layering.md) L3），所以三处面板与设置里的
   模型抽屉共享同一个值，切模型时跟着变。单次覆盖要在 aiTaskStore /
   agentStore / consistencyStore 各加一份临时状态，还要回答「对话助手这种长
   会话里『单次』指一轮还是整个会话」——为一个作者一年调不了几次的旋钮，
   不值得。

2. **两个拨盘对应协议层真实存在的两个轴**，不是把一个字段画成两个：思考多深
   （`thinking` / `thinkingLevel` / `reasoning_effort`）vs 整个回复花多少力气
   （Anthropic 的 `output_config.effort`，管到 prose、工具调用与思考三者）。
   OpenAI 族里两者塌缩成同一个字段，所以那里只有一个拨盘是活的。第二个拨盘
   会在 Anthropic 的映射接进来时点亮，届时删掉 `supportsSeparateEffort` 的
   常量 `false` 即可。

3. **两个拨盘都不可用时整行不渲染**，而不是渲染两组停用控件。停用控件要靠
   旁边的可用控件解释自己——设计稿里「力度」停用是成立的，因为「思考」在旁边
   亮着；孤零零两组停用只是在拥挤的面板里占三行说「这两件事你都做不了」。

一处偏离设计稿：一致性检查除了设计稿画的筛选行，**空状态里也放了一个**。
那一行只在已有报告后才出现，而最值得调档位的恰恰是第一次检查——否则作者得
先付一次运行的钱才能发现这个旋钮。

---

## 8. 结构化输出：兜底路径的原生约束

放在本文而不是单开一份，是因为触发它的正是思考模式：`agent/structured.ts` 的
降级判据里就写着 `"thinking mode"` —— **推理模型是走上那条兜底路径的主力**。

协议事实见 [`api/structured.md`](api/structured.md)。本项目的取舍：

1. **兜底路径此前是零约束。** 强制工具调用被拒后退回的那条 JSON 路径完全不发
   `response_format`，纯 prompt + 从散文里抠 JSON。也就是说，**恰恰在最不容易
   吐干净 JSON 的模型上，约束最弱**。现在退下来仍带原生参数。

2. **`json_object` 的 "json" 前置条件必须由代码保证，不能靠 prompt 恰好提到。**
   OpenAI 与 DeepSeek 都要求上下文里出现该字面量，否则直接报错。今天成立只是
   因为内置提示词碰巧写了 JSON 字样——而 lore 生成的系统提示词是**作者可覆盖
   的**，改写掉那个词就是一次无从定位的硬报错。

3. **`jsonModeExtraBody` + `needsJsonTextCue` 合并成
   `jsonModeShaping(standard, promptText)`。** 一次调用同时给出参数与提示语，
   前置条件检查无法被忘记。OpenAI 族的提示语改为**条件附加**：原生约束已经
   生效，只在作者的 prompt 没提到 json 时才补，不在每次请求上重复一遍。

4. **不采用 OpenAI 的 `json_schema` 严格模式。** 三条理由：DeepSeek 不支持它
   （同族内官方支持、兼容端点不支持，且无法从协议族推断）；严格模式要求
   `additionalProperties:false` 且**所有字段必须 required**，而 lore 条目天然
   有可选字段；最重要的是**我们已有更可移植的等价手段**——强制工具调用，四族
   都支持，schema 就是工具的 `parameters`。`json_schema` 在这里是平级替代品，
   不是升级。

由此定下的分层：**能强制工具调用就用它（真 schema 强制）→ 不能就用原生 JSON
模式 + 散文描述形状（保证合法 JSON）→ prompt 只负责形状描述这一层。** 最后
这层无论如何省不掉，因为 `json_object` 本来就不保证形状。

---

### 与 DeepSeek 官方文档的逐条核对（2026-08-13）

对照 [create-chat-completion](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)
与 [tool_calls 指南](https://api-docs.deepseek.com/zh-cn/guides/tool_calls)：

**已确认一致**：assistant 的 `content` 是 `nullable **required**`（本实现显式发
`content: null`，字段存在）；`tool_calls` 结构；tool 消息的
`role`/`content`/`tool_call_id` 三个必填字段；`tool_choice` 的四种取值；
`tools` 上限 128；`stream_options.include_usage`；以及思考模式不支持
`temperature`/`top_p` —— 本 app 从不发送这两个。

**两处官方文档自相矛盾，实现按更贴题的那一份走：**

1. **`reasoning_effort` 在顶层还是 `thinking` 内部。** API 参考的顶层参数清单里
   没有 `reasoning_effort`，它被列为 `thinking: {type, reasoning_effort}` 的子
   字段，枚举只有 `low`/`high`/`max`；但思考模式指南的可运行示例把
   `reasoning_effort="high"` 作为 OpenAI SDK 的具名参数传入 —— 那会序列化到
   **顶层**。推断是两种都收（顶层为 OpenAI 兼容别名）。**本实现发顶层**，
   因为那是整个协议族通用的写法。**未实测。**

2. **`reasoning_content` 的用途。** API 参考说它是"(Beta) 用于思考模式下在对话
   前缀续写功能下"的入参；思考模式指南则要求工具调用轮必须回传否则 400。
   按指南实现 —— 讲工具调用的是那一页。

**已知缺口：「关闭」档在 DeepSeek 上可能无效。** `thinking.reasoning_effort`
的枚举里没有 `none`，DeepSeek 的关闭开关是 `thinking: {type:"disabled"}`，
而那个字段发给 api.openai.com 会被拒。仍然不为此加 provider 分支：若实测证明
无效，正确的修法是 §8 的探测/降级机制。

**这三条都只需要一次真实 DeepSeek 请求就能定论**，是本方案里最值得实测的部分。

---

## 9. 未决问题

- **兼容中继的思维链字段名**到底有几种？已知 `reasoning_content`（DeepSeek）、
  `reasoning`（OpenRouter）、内联 `<think>` 标签三类。第 4 步实现时按三种都试，
  但内联标签的剥离要不要做、会不会误伤正文里合法的 `<think>` 字样，待定。
- **是否给 `endpointProbe` 加一次"支持哪些档位"的探测**？现在的探测测的是
  上下文窗口与输出上限（见 `architecture.md` → Endpoint probing）。档位探测需要
  实际发一次请求看 400，成本比较高，倾向于不做，改为"发错了就降级并记住"。
- **旧代 Anthropic 的 `budget_tokens` 必须 < `max_tokens`**，而 `maxOutput` 是
  可选字段（未配置时 `anthropic.ts` 回落到常量）。档位推导出的 budget 与常量
  冲突时以哪个为准，实现时定。
