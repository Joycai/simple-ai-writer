# Agent 工具上下文瘦身：实施计划与 LLD

> 前置阅读：[`agent-tool-context.md`](agent-tool-context.md)（现状测量与选项评估）。
> 本文是**拍板后的执行方案**：分几个 PR、每个 PR 动哪些文件哪些函数、怎么测、怎么回滚。
> 状态：待实施。全部落地后把 §7 的结论并进 `CLAUDE.md`。

## 0. 定下来的取舍

| 决定 | 理由 |
| --- | --- |
| **分 5 个 PR，不合并** | CI 只对 `main` 的 PR 生效、且本仓库不做 stacked PR。PR1 是后面四个的计量地基，PR4/PR5 会改模型行为，混在一起出问题无法二分定位。 |
| **PR1 改的是 ceiling，不是 `fixedChars`** | `fixedChars` 是**字符**、按正文的 `charsPerToken`（中文 ~1.5）折算；工具 schema 是**英文 token**（~4 字符/token）。把英文 token 乘中文字符率会高估近 3 倍。工具开销的正确落点是 token 维度的 ceiling。 |
| **PR2 只做官方 `anthropic`，`anthropic_compat` 单独排期** | 本仓库对第三方 ④ 族端点一贯的态度是"文档写了不等于验过"（见 `docs/thinking-verification.md`）。缓存打错会 400，而 400 发生在流式请求开头，作者看到的是整轮失败。 |
| **PR5 拆成 5a/5b，先做不需要模型配合的那一半** | `lore_write` 组由**已批准的方案**自动装载，模型不需要知道"还有工具可以要"；`load_tools` 元工具需要模型主动索取，是另一个量级的行为风险。5a 单独就吃掉分层装载 61% 的收益。 |
| **不引入任何新的用户设置** | 缓存、分层装载都是实现细节，不是作者要决策的事。加设置就要动 `ConnOptions` + Model 表 + 设置面板三处（见 `docs/provider-layering.md`），代价远超收益。 |

## 1. PR1 —— 工具 schema 进入预算，并可观测

**目标**：让"省下的 token"变成真正能被别的层用掉的空间；顺带修掉 `agent-tool-context.md` §2 的两个偏差。

### 1.1 `lib/agent/toolCost.ts`（新文件）

现在 `AgentChat.tsx:413` 手写了一遍"路由 → 取定义 → 估 token"，PR1 之后还会有三个调用点需要同一个数。抽出来：

```ts
/**
 * 下一个请求会携带的工具 schema 的 token 数。
 *
 * 带缓存：getToolDefinitions 每次都重建对象（它要按活跃 profile 补 category
 * 枚举），而这个数会被上下文条在每次渲染时问一遍。缓存键必须**包含**分类签名，
 * 否则换项目后拿到的是上一个 workspace 的分类名对应的旧值。
 */
export function plannedToolTokens(
  preset: TaskPreset,
  subs: Record<SubAgentKind, SubAgentConfig>,
  models: Model[],
): number

/** 运行中的真实值：已装载工具集的 token 数（PR5 之后与 planned 会不同）。 */
export function toolTokensOf(ids: readonly ToolId[]): number
```

实现：`routePlannedTools` → `getToolDefinitions` → `estimateToolsTokens`；模块级
`Map<string, number>`，键 `ids.join(",") + "|" + loreCategoryIds().join(",")`。

### 1.2 `lib/context/budget.ts`

```ts
export interface ContextBudgetInput {
  // …
  /** 本次请求会携带的工具 schema token 数。0 = 无工具任务。 */
  toolSchemaTokens?: number;
}

export interface ContextBudgetPlan {
  // …
  /** 整个请求的输入上限（= window×util − 输出预留）。含工具。语义不变。 */
  inputCeilingTokens: number;
  /** 其中留给**消息**的部分（= inputCeilingTokens − toolSchemaTokens）。 */
  messageCeilingTokens: number;
  /** 工具 schema 占掉的那一块，供 UI 单独显示。 */
  toolSchemaTokens: number;
}
```

`planContextBudget` 内部：

```ts
const inputCeilingTokens = max(0, floor(contextSize*util) - reservedOutputTokens);
const toolSchemaTokens  = max(0, input.toolSchemaTokens ?? 0);
const messageCeilingTokens = max(0, inputCeilingTokens - toolSchemaTokens);
const ceilingChars = floor(messageCeilingTokens * charsPerToken);   // ← 改这一行
```

**为什么保留 `inputCeilingTokens` 的旧语义而不是直接减掉**：它是 AiPanel 预算条的分母，
作者看到的"上限"不该因为一次内部重构而变小；工具开销应该表现为**可用空间被占掉**，
而不是**上限缩水**——前者能解释（条子上多一段），后者不能。

静态兜底路径（`contextSize` 缺失）：`messageCeilingTokens: 0`、`toolSchemaTokens: 0`，
与现有 `inputCeilingTokens: 0` 保持一致——那条路径本来就不做 token 规划。

### 1.3 四个消费方改读 `messageCeilingTokens`

| 文件 | 现在 | 改成 |
| --- | --- | --- |
| `stores/aiTaskStore.ts:504` | `plan.inputCeilingTokens \|\| ASSUMED_…` | `plan.messageCeilingTokens \|\| ASSUMED_…` |
| `stores/agentStore.ts:1174` | `inputCeilingFor(model.contextSize, util)` | 同上再减 `plannedToolTokens(AGENT_ASSIST_PRESET, …)` |
| `stores/agentStore.ts:1067`（压缩触发） | 同上 | 同上——**必须和 1174 用同一个数**，否则压缩阈值和裁剪阈值再次错位 |
| `stores/roleplayStore.ts:549` | 同上 | 同上（用 `presetFor(agent.kind)`） |

`aiTaskStore.ts:358` 和 `AiPanel.tsx:222` 的 `planContextBudget(...)` 调用各加一个
`toolSchemaTokens: plannedToolTokens(presetForTools(task.tools) ?? …)`；`presetForTools`
返回 `null`（`tools: "none"`）时传 0。

**建议顺手抽一个 helper** 到 `agentStore`/`roleplayStore` 共用：
```ts
const messageCeiling = (contextSize, util, preset) =>
  Math.max(0, inputCeilingFor(contextSize, util) - plannedToolTokens(preset, subs, models));
```
放 `lib/agent/toolCost.ts` 里，和 `plannedToolTokens` 挨着——三个 store 各写一遍减法，
就是下一次口径漂移的来源。

### 1.4 `runtime.ts` / `compact.ts` 的契约注释

两个函数的 `ceilingTokens` 参数含义从"输入上限"变成"**留给消息的**上限"。不改签名，
改注释——`AgentRuntimeOptions.inputCeilingTokens` 和 `planFold` 各一句：

> 这是消息的上限，不含工具 schema：调用方已经把 schema 的份额减掉了。这里再减一次
> 就是双重计费。

### 1.5 可观测性

`lib/agent/events.ts` 的 `round-start` 加一个字段：

```ts
| { kind: "round-start"; round: number; maxRounds: number;
    estInputTokens: number;
    /** 本轮实际携带的工具 schema token；force-text 收尾轮撤掉工具时为 0。 */
    toolTokens: number;
    at: number }
```

`runtime.ts:513` 填 `withholdTools ? 0 : toolTokensOf(activeToolIds)`。
`components/ai/AgentLog.tsx` 在轮次行上显示 `估 12.3k（工具 8.5k）`——**这是验证后面四个
PR 收益的唯一手段**，先有它再动别的。

`contextBreakdown.ts` 顶部注释里的 "the assistant preset carries 21 of them" 改成
不写死数字的说法（现在是 39，写死的数字注定过期）。

### 1.6 测试

- `budget.test.ts`：`toolSchemaTokens` 会等额压缩 `messageCeilingTokens` 和各层字符预算；
  `inputCeilingTokens` 不变；工具超过上限时 `messageCeilingTokens` 夹到 0 而不是负数。
- `toolCost.test.ts`（新）：缓存命中同一组 ids；切换 workspace（`setActiveWorkspace`）后
  重新计算——照抄 `agentToolSchema.test.ts` 里那三个 profile 用例的写法。
- `chatCompact.test.ts`：加一个"消息 65%、工具 10% → 合计 75% 已过 70% 触发线"的用例，
  钉住压缩现在会在**含工具**的口径下启动。

**回滚**：`toolSchemaTokens` 全传 0 即回到今天的行为。

---

## 2. PR2 —— Anthropic 官方端点的显式 prompt caching

**目标**：④ 族上把每轮重发的 ~12k 固定头部从全价降到缓存价。**不改变任何 token 占用。**

### 2.1 `lib/ai/anthropic.ts`

现状：`system` 是字符串（`extractSystem`，line 489），`tools` 是纯数组（line 517）。

```ts
/**
 * 缓存断点。只在官方 anthropic 上打。
 *
 * `anthropic_compat` 排除在外：MiniMax 文档里写了 `system` 接受带 cache_control
 * 的数组，但没写 `tools`，而本仓库对第三方 ④ 族端点的既定态度是文档不等于验过
 * （docs/thinking-verification.md）。打错的代价是 400，且发生在流式请求的开头，
 * 作者看到的是整轮失败——不值得为省钱赌这一下。有真端点可测时见 §2.3。
 */
function cachesPrompt(standard: ApiStandard): boolean {
  return standard === "anthropic";
}
```

两处改动：

```ts
// system：字符串 → 单元素 text block，带断点
if (system) {
  baseBody.system = cachesPrompt(opts.standard)
    ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
    : system;
}

// tools：最后一项带断点，缓存覆盖整个 tools 数组
if (opts.tools?.length || serverTools.length) {
  const tools = [ ...serverTools, ...(opts.tools ?? []).map(toAnthropicTool) ];
  if (cachesPrompt(opts.standard) && tools.length) {
    tools[tools.length - 1] = {
      ...tools[tools.length - 1],
      cache_control: { type: "ephemeral" },
    };
  }
  baseBody.tools = tools;
}
```

**断点放最后一项而不是每一项**：Anthropic 的缓存是**前缀**缓存，一个断点缓存的是它
*之前的全部内容*。逐个打断点既浪费（上限 4 个）又没有额外收益。

**顺序即前缀**：`tools` → `system` → `messages`。`getToolDefinitions` 保序、
`withProfileCategories` 是纯函数、路由在一次运行内不变，所以 tools 数组在一次运行中
逐字节稳定；`runtime` 注入的各种 notice（`forcedTextNotice` / `checkpointNotice` /
`taskNudgeNotice`）都在 messages 里，落在断点之后，不影响命中。

**读侧不用改**：`readUsage`（line 410）已经在解析 `cache_read_input_tokens` /
`cache_creation_input_tokens` 并折进 `cachedTokens`，`token_usage` 表也有列。
PR2 是把这套已经建好的账本真正用起来。

### 2.2 测试

`aiClient.test.ts` 里加一个 `describe("streamCompletion — Anthropic prompt caching")`，
沿用该文件既有的 mock-fetch-验 body 写法：

1. `standard: "anthropic"` + 3 个工具 → `body.tools[2].cache_control` 存在，
   `body.tools[0..1]` 没有，`body.system` 是数组且带断点。
2. `standard: "anthropic_compat"` → `body.system` 仍是**字符串**，`tools` 上一个
   `cache_control` 都没有。（这条是防回归的重点：将来有人"顺手统一一下"就会踩响它。）
3. 只有服务端工具、没有本地工具时，断点落在服务端工具那一项上，且**不**产生 `tool_choice`
   （既有约束，别破坏）。

### 2.3 后续（不在 PR2 内）

`anthropic_compat` 的缓存需要一次真端点验证：拿 MiniMax-M3 的 ④ 族端点发一个带
`system` 数组断点的请求，看 400 与否、看 usage 是否回报 `cache_read_input_tokens`。
验过再开，并在 `docs/thinking-verification.md` 的清单里记一条。**这件事没做之前，
本项目最常用的中转端点吃不到 PR2 的收益**——所以 PR2 的排序在 PR1 之后、但它不是收益最大的一个。

**回滚**：`cachesPrompt` 返回 `false`。

---

## 3. PR3 —— 预算护栏（字面瘦身已量掉）

> **实施结论（1.22.0）**：动手前先量了一遍，**§3.1 的三类删除不做**，PR3 只剩护栏。
>
> 拿真实 schema 拆开看：39 个工具的 parameters 一共 15,776 字符，其中 **8,015 是
> 纯 JSON 结构**（`{"type":"string"}`、`required`、嵌套括号），只有 7,761 是描述文字
> —— 也就是说**参数层有一半根本不是文字，改文案动不了它**。剩下能真正删掉的重复
> 一共约 900 字符（≈225 token），不是原先估的 600 token：
>
> - `reason` 的 10 份描述缩写：省 ~170 字符。
> - 「批准前不写入」样板句上提：schema 里省 ~430 字符，但**旁白预设也带 L2 工具
>   （`propose_edit`/`append_file`/`create_chapter`/`rewrite_lines`）而它读的是
>   `ai.instructions.narrator`，不是 `agent`** —— 上提就得往两份指令里各写一遍，
>   两种语言四份副本，净收益接近零。这条是 §4.1 那条切分规则的一个真实反例：
>   "策略放 system" 只在**所有**用到该工具的界面共享同一份 system 时才成立。
> - 「Entity name exactly as returned by list_lore_entities」这类：`exactly as
>   returned by` 是在干活的（它是"别自己编名字"的指令），缩写省不到 200 字符却
>   要赌工具选择不退化。不换。
>
> 所以 PR3 的收益记为 **0**，§7 的汇总已按此更正。留下的是护栏——它才是这一步
> 真正值钱的部分：schema 体积没人盯着就会涨，而涨的代价是每一轮都付。

### 3.1 三类删除（**不做**，理由见上）

1. **样板句上提**。`"NOTHING is written until the user approves the card; the call blocks
   until they decide."` 出现在 5 个工具里（propose_edit / rewrite_document / rewrite_lines /
   create_file / create_chapter…）。删掉，在 `ai.instructions.agent` 里写一次：
   「所有 L2 工具在作者批准前都不写盘，调用会阻塞等待。」——这是跨工具策略，按 PR4 的
   划分规则本来就该在 briefing 里。省 ~430 字符。
2. **`reason` 参数描述**。10 处 `"One-line justification shown to the user on the review card"`
   → `"Why, in one line (shown on the review card)"`。省 ~170 字符。
3. **参数层的重复解释**。`update_facet_meta` 的 parameters 有 1,142 字符、比它的 description
   还长，其中 `mode` 的 auto/always/manual 在 description 里已经讲过一遍。同类：
   `create_lore_entity`(591) / `propose_lore_plan`(801) / `generate_image`(879)。
   规则：**枚举语义只讲一次**，讲在 description 里；参数描述只说"填什么"。

### 3.2 不动的部分（写进注释，防止后人"顺手优化"）

`rewrite_lines`(979) / `rewrite_document`(1000) / `export_pptx`(1222) 的长描述**保留**。
它们讲的是踩过的坑——长文件用 rewrite_document 会撞输出上限、批准后行号会移动、
web font 进不了 pptx——删掉省 200 token，换回来一次截断重跑就亏。在 registry 顶部
的模块注释里加一段说明这条界线。

### 3.3 护栏（本 PR 的**全部**内容）

`src/lib/__tests__/agentToolBudget.test.ts`（新）：四个预设各一个上限
（agent-assist / continue / roleplay-narrator / roleplay-character），外加
"每个工具的描述不得短于 40 字符、不得漏掉分类占位符替换"两条低成本不变量。
四个而不是一个：旁白那份也在长，而它一直没人量过。

```ts
/**
 * 工具 schema 的 token 棘轮。
 *
 * 这个数字每加一个工具就涨一次，而它是每一轮请求都要付的。上限不是"最优值"，
 * 是"超过它必须有人明确决定"——改这个常量本身就是那个决定，会出现在 diff 里。
 */
// 口径是**全预设**（39 个工具，未经 routeTools 裁剪）——路由结果随作者的子代理开关
// 变化，拿它当棘轮会让一个开关切换看起来像一次回归。
// 实测 9,609（estimateToolsTokens 的口径），取 10,000：够改措辞，不够加一个工具。
const AGENT_ASSIST_CAP = 10_000;

it("full toolset stays within the per-request budget", () => {
  const tokens = estimateToolsTokens(getToolDefinitions(AGENT_ASSIST_PRESET.tools));
  expect(tokens).toBeLessThanOrEqual(AGENT_ASSIST_TOOL_TOKEN_CAP);
});
```

同时钉住"没有工具的描述超过 N 字符"和"每个工具都有非空 description"两条低成本不变量。

**回滚**：文本改动，`git revert` 即可。

---

## 4. PR4 —— briefing 与 schema 去重

**目标**：~2,000 token/轮，所有厂商都吃得到。**这是唯一会改变模型行为的 PR，必须实测。**

### 4.1 切分规则

> 决策性信息（这个工具做什么、参数怎么填、A 和 B 该用哪个）留在 **tool description**——
> 它贴在调用点上，模型选工具时一定看得到。
> 流程与策略（顺序、优先级、禁令、失败后怎么办）留在 **system briefing**——
> 没有任何单个 schema 能表达跨工具的约束。

### 4.2 `i18n/locales/{zh-CN,en}.json` → `ai.instructions.agent`

**删除**（纯复述，schema 里已有且更细）：
- 「## 可用工具」下的 **查阅**、**配图**、**图示/页面**、**调整文档结构** 四段。

**保留并保持原样**（跨工具策略，schema 表达不了）：
- 「改{{kb}}的流程（强制）」整节——五步的 plan-first 纪律。
- 「**大文件必须分段写**」整段**连同它的理由**（"一次性输出会撞输出上限、那次调用什么都不会写入"）。
  理由不能删：没有理由的禁令，模型在长文件面前会当场违反。
- 「修改{{kb}}」段里的**优先级排序**（"按改动大小挑工具，绝不为了小改动整篇重发"），
  但压缩成一句 + 一行工具序列，不再逐个解释每个工具干什么。
- search_text 优先于逐个翻文件这条。

预期：3,418 → ~1,300 中文字符。

### 4.3 验收实测（本 PR 的主体工作量）

本地 ollama（`:11434`，有 gemma4:12b / qwen3.6）跑对照，改前改后各 4 次，三个任务：

| 任务 | 判据 |
| --- | --- |
| 「把 X 的别名加一个"阿瓦"」 | 4/4 先调 `propose_lore_plan`；4/4 用 `update_lore_meta` 而**不是** `update_lore_file` 整篇重发 |
| 「帮我写一个项目介绍页」 | 4/4 用 `create_file` 写 `.html` 且自包含；长内容 4/4 走 `append_file` 分段而不是一次性 |
| 「第三章里"星舰"全改成"星舟"」 | 4/4 用 `propose_edit` + `replace_all`，0/4 退回 `rewrite_document` |

**任何一格不达标就停在 4.2 的保守版本**（只删「查阅」「配图」两段，~800 token）。
结果——包括不达标的——记进本文件 §7。

**为什么必须用本地小模型测**：前沿模型能从 schema 自己推出这些纪律，测不出退化；
而这个应用明确支持本地小模型，退化恰恰只在那儿发生（`presets.ts` 里
`toolBriefingFor` 的注释记录过同一个现象：gemma4:12b 上 4 次里有 2 次不调工具）。

**回滚**：i18n 文本，`git revert`。

---

## 5. PR5a —— 知识库写工具随方案装载

**目标**：~2,500 token/轮，**模型无需任何配合**。

### 5.1 为什么这一组可以零风险地推迟发送

`plan.ts` 已经在执行侧拦住它们了：没有已批准的方案，9 个 lore 写工具**一个都调不动**，
只会拿回一段"先调 propose_lore_plan"的错误文本。既然批准之前它们必然失败，那就**批准之前
不必发**——模型的路径完全不变（提方案 → 批准 → 动手），只是"动手"用的工具在批准那一刻才
出现在 wire 上。

附带修好一个现存的浪费：没有审批通道的界面（`ctx.requestPlanApproval` / `ctx.lorePlan`
缺失，见 registry ToolContext 注释）今天**照样发这 9 个 schema**，然后每次调用都回
"this surface cannot review lore plans"。5a 之后它们在那些界面上根本不出现。

### 5.2 数据模型

`registry.ts`：
```ts
export type ToolGroup = "lore_write";          // 5b 再加 file_ops / whole_file

export interface RegisteredTool {
  // …
  /** 非常驻分组。省略 = 常驻，行为与今天一致。 */
  group?: ToolGroup;
}
```
给 9 个工具打上 `group: "lore_write"`：`create_lore_entity`、`update_lore_file`、
`update_lore_meta`、`append_lore_file`、`edit_lore_file`、`update_facet_meta`、
`delete_lore_file`、`move_lore_entity`、`delete_lore_entity`。

**不打的**：`propose_lore_plan`（常驻，它是入口）、`update_memory`（不受方案约束）。

```ts
/** 按分组切分一个工具列表，保序。 */
export function partitionByGroup(ids: readonly ToolId[]):
  { resident: ToolId[]; deferred: Record<ToolGroup, ToolId[]> }
```

### 5.3 `runtime.ts`

```ts
// 开跑时
const { resident, deferred } = partitionByGroup(preset.tools);
/** 已装载工具，**有序**：常驻在前，装载进来的追加在后。 */
const active: ToolId[] = [...resident];
const loaded = new Set<ToolGroup>();

// 每一轮循环开头（round-start 事件之前）
if (!loaded.has("lore_write") && (runToolContext.lorePlan?.steps.length ?? 0) > 0) {
  loaded.add("lore_write");
  active.push(...deferred.lore_write);
  opts.onEvent({ kind: "tools-loaded", group: "lore_write",
                 names: deferred.lore_write, round, at: Date.now() });
}
const toolDefinitions = getToolDefinitions(active);   // ← 从 line 308 移进循环
```

以及 line 785：`executeRegisteredTool(toolCall, preset.tools, …)` → `executeRegisteredTool(toolCall, active, …)`。

**这一行是安全边界，不是优化**：`allowed` 继续用 `preset.tools` 的话，未装载的工具照样
可执行——工具门就成了摆设。回归测试必须钉住它。

**顺序必须是数组而不是 Set**：装载进来的排在常驻之后，PR2 的缓存断点覆盖的前缀
（tools 数组）在装载前后前半段完全一致；Anthropic 的前缀缓存下，常驻部分继续命中，
只有追加的尾巴是新的。用 Set 迭代序就没有这个保证。

**为什么用 `lorePlan.steps.length` 而不是新开一个状态**：`PlanGate` 已经是"作者签过字的
东西"的**唯一**记录（`plan.ts` 模块注释），再加一个布尔就有两个真相源，而它们会分叉。

### 5.4 事件与 UI

`events.ts` 加 `{ kind: "tools-loaded"; group: ToolGroup; names: ToolId[]; round: number; at: number }`，
`AgentLog.tsx` 渲染成一行「已装载 9 个知识库写入工具」——作者能看见工具集在运行中变了，
否则日志里会出现"上一轮还没有的工具"，无从解释。

`AgentChat.tsx` 的上下文条改用**常驻集**估算，并在 tooltip 里说明"批准设定方案后会增加"。
运行中的真值以 PR1 的 `round-start.toolTokens` 为准——条子是**发车前的估算**，不是实时表。

### 5.5 测试（`agentRuntimeToolGroups.test.ts`，新）

1. 首轮 `tools` 里**没有** `create_lore_entity`，**有** `propose_lore_plan`。
2. 模型在首轮直接调 `create_lore_entity` → 拿回 `Unknown tool`（而不是被执行、也不是
   plan.ts 的那段错误文本）。**这是安全边界的回归测试。**
3. `lorePlan.steps` 被填充后的下一轮，`tools` 里出现全部 9 个，且**前 N 项与首轮逐字节相同**
   （缓存前缀不变）。
4. 装载只发生一次（`tools-loaded` 事件只有一个）。
5. 没有 `lorePlan` 的 ToolContext 全程不装载。

### 5.6 收益核算

**实测（1.22.0）**：全预设 39 个工具 9,609 token → 常驻 30 个 7,067 token，
`lore_write` 那 9 个是 **2,542 token（26%）**。批准方案之前每轮省这么多，
而不涉及知识库的对话（多数）全程都省。估算命中。

预算侧**故意不跟着调**：`messageCeilingFor` 仍按完整工具集算。这一趟运行**可能**
会装载那一组，而 ceiling 要在整趟运行里都成立——按常驻算就等于赌它不装载，
赌输了历史已经裁到没有余地。省下来的是实打实的 wire token 和钱，只是不把这块
空间转手分给 RAG 各层。上下文条同理（它画的就是这个 ceiling）。

**回滚**：把 9 个 `group: "lore_write"` 标记去掉，`partitionByGroup` 自然返回全常驻。

---

## 6. PR5b —— `load_tools` 元工具（条件执行）

**前置条件**：5a 上线且 §5.5 的测试稳定；PR4 的实测显示本地小模型仍能遵守流程纪律。
**不满足就不做**——`file_ops` + `whole_file` 合计只有 6,457 字符（~1,600 token），
而它需要模型主动索取，是完全不同量级的行为风险。

设计概要（细节等 5a 的经验再定）：
- 新增 `load_tools({ groups: ToolGroup[] })`，`access: "read"`，description 内嵌**分组目录**：
  每组一行、不超过 15 词，总计 ~300 字符。这是 Anthropic Tool Search Tool 的客户端等价物——
  服务端那套只在 Anthropic API 上有，本应用要跑 OpenAI-compat / Gemini / 各种中转，
  必须自己实现。
- `ToolContext.loadToolGroups?: (groups: ToolGroup[]) => ToolId[]`，由 runtime 注入
  （与 `onNestedEvent` 同一种"运行时能力"注入方式）。
- 失败模式与兜底：模型不索取而是直接说"我做不到"。兜底是在 briefing 里加一行
  「需要新建/移动/删除文件时，先 `load_tools(["file_ops"])`」——**如果这一行本身就要 60 字符
  ×每轮，那 5b 的净收益要重算**。这正是它排在最后、且可以不做的原因。

## 7. 收益汇总与实测记录

| PR | 每轮省占用 | 省成本 | 代价 | 行为风险 |
| --- | --- | --- | --- | --- |
| 1 计量 | —（修正） | — | 小 | 无 |
| 2 ④族缓存 | 0 | 官方端点重复头部 ≈ -90% | 小 | 无（compat 未开） |
| 3 schema 护栏 | **0**（量过：可删的文字只有 ~225 token，且有反例，见 §3） | — | 小 | 无 |
| 4 briefing 去重 | ~2,000 | 同比例 | 中（实测占大头） | **中** |
| 5a 随方案装载 | **2,542**（实测） | 同比例 | 中 | 低 |
| 5b `load_tools` | ~1,600 | 同比例 | 中 | 中 |

全部落地后对话助手的每轮固定头部：**~12,300 → ~6,600 token**（-46%），
④ 族端点上这 6,600 里的绝大部分还走缓存价。（原估 ~6,000，PR3 量掉之后更正。）

> **实测数据待填**（PR1 的 `round-start.toolTokens` 上线后逐个 PR 记在这里，
> 包括 PR4 的对照结果——不达标的那一格尤其要记，它是后人重开这个话题时唯一有用的东西）。
