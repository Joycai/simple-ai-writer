# 结构化输出开关：按模型声明 JSON 模式 / JSON Schema

> **状态：`shipped` `unverified`** —— 2026-09-02 定案，三片当天全部落地。第 1 片：数据层、
> 三层解析、`json_schema` 形状、`strictify` / `stripNulls`、兜底路径、模型抽屉那一行（随设计稿 19，
> 见 [`docs/feature/model-drawer-redesign-brief.md`](../feature/model-drawer-redesign-brief.md)）。
> 第 2 片：§5.3 的 400 学习与 memo（`jsonMode.ts` 的 `withJsonModeFallback`，两处调用方都走它），
> `generator.ts` 的 `loreEntitySchema`（`category` 用 enum 钉住）。第 3 片：§7 第 3 点——降级可预测
> （`forcesToolChoiceAuto`，或 `toolChoice.ts` 的 memo 已记下端点拒绝强制）**且**实际生效的档是
> `json_schema` 时，`structured.ts` 跳过强制工具那一趟直接走 JSON 路径（`forcedToolIsWasted`）；
> 只有 `json_object` 可退时仍然试工具——`auto` 下模型多半还是会调，一次工具调用强于「合法 JSON，
> 形状靠散文」；§5.4 的「本会话实测降级」在抽屉的结构化输出行下方一行 mono 显示，且「将发送」
> 读的是 `effectiveStructuredOutput`（配置解析再按 memo 封顶，三处消费者一个答案）。
> Gemini 族的 `json_schema` 随后补上：`generationConfig.responseJsonSchema`（Gemini 2.5+），同一份
> strictify 结果原样发，id 表加 `gemini-2.5` / `gemini-3`，抽屉里 Gemini 族也有四枚 chip。
> `unverified` 指 §11 的五条实测一条都没跑：本文对 DashScope 与 Gemini 实际行为的陈述仍是文档
> 转述，400 判据用的是 OpenAI 的报文拼写（`response_format`）加 Gemini 的字段名
> （`responseJsonSchema`），两家的真实样本都欠着。
> 前半是对现状的审计（§1–§3，结论：知识库相关功能**已经在用**协议级的结构化输出，
> 但只用到 `json_object` 一档，且没有任何按模型关掉或升级它的开关），后半是方案（§4–§10）。
> 协议事实见 [`structured.md`](structured.md)，千问平台的官方口径见 §2；
> 上一轮的取舍（为什么当年**不**上 `json_schema`）见
> [`reasoning-plan.md`](reasoning-plan.md) §8，本文 §3 说明哪一条前提变了。
> 分层裁决依据 [`provider-layering.md`](provider-layering.md)：这是一个 **L3 模型字段**。

## 0. 一句话结论

- **拆分（LoreImproveModal → `splitTools`）根本不走 JSON**：每个特征一次工具调用，
  参数由端点按 schema 解码。它曾经是"一整块 JSON"，因为转义崩掉才改的
  （`splitTools.ts` 头注释），结构化输出开关对它**没有意义**。
- **整理（集合 / 分类的搬动）是 agent 工具循环 + 方案卡**，同样不走 JSON。
- **条目生成（`lore/generator.ts`）走的正是千问文档里的 JSON Object 模式**：
  OpenAI 族（含 DashScope 兼容模式）发 `response_format:{type:"json_object"}`，
  Gemini 发 `responseMimeType`，Anthropic 只能靠文本提示。这是协议能力，不是
  "让模型自觉吐 JSON"。
- **其余八处结构化任务（`agent/structured.ts`）先强制工具调用，被拒才退回
  JSON Object 模式**。强制工具调用是四族都有的 schema 强制手段，比
  `json_schema` 更可移植，所以当年选它做主路径是对的。
- **`json_schema` 一档从未用过**，`response_format` 在 OpenAI 族上**无条件发送**，
  没有任何按模型关闭的口子。这两点就是本方案要补的。

## 1. 现状盘点：哪里在用什么

| 功能 | 入口 | 约束强度（`structured.md` 的四档） | 走的机制 |
| --- | --- | --- | --- |
| 条目生成 / 从参考资料抽条目 | `lib/lore/generator.ts` | **1 · JSON 模式** | `jsonModeShaping` → `extraBody` 进 `runAgent`（`LORE_GENERATE_PRESET`，无工具） |
| 拆分整理（特征拆分） | `components/lore/LoreImproveModal.tsx` → `lib/lore/splitter.ts` | **3 · 工具调用**（非强制，多次） | `splitTools.ts` 收集器，一特征一调用 |
| 特征改写（同一弹窗的另一模式） | `LoreImproveModal.tsx:217` | 3 → 1 | `runStructuredTask` |
| 元信息改进（名字 / 别名 / 分类 / 摘要） | `LoreMetaImproveModal.tsx:185` | 3 → 1 | `runStructuredTask` |
| 词典标准化 | `LoreDictNormalizeModal.tsx:117` | 3 → 1 | `runStructuredTask` |
| 一致性检查 | `lib/consistency/scan.ts:181` | 3 → 1 | `runStructuredTask` |
| 检索词扩展 | `lib/context/expand.ts:159` | 3 → 1 | `runStructuredTask` |
| 扮演转场前情 | `lib/roleplay/recap.ts:112` | 3 → 1 | `runStructuredTask` |
| 生图提示词 / 人设校准 | `lib/image/promptGen.ts`、`calibrate.ts` | 3 → 1 | `runStructuredTask` |
| 集合 / 分类整理 | agent `lore_organize` 工具组 | 3（自由工具循环） | 方案卡门控，与 JSON 无关 |

"3 → 1" 的降级判据在 `structured.ts` 的 `TOOL_CAPABILITY_ERROR`：端点回
`tool_choice` / `thinking mode` / `does not support function calling` / 空工具调用
时才退，别的错误原样抛。退下来的那条路**带** `jsonModeShaping` 的原生参数
（reasoning-plan §8 第 1 条补的），不是零约束。

两条前置条件今天都由代码保证，不靠 prompt 碰巧：

- `json_object` 要求上下文里出现字面量 "json"（OpenAI、DeepSeek、DashScope 三家
  文档都写了）——`jsonModeShaping` 的 `mentionsJson` 在缺词时补一句 cue。
- 千问文档说"开结构化输出时不要设 `max_tokens`，会截断 JSON"——OpenAI 族的
  adapter 本来就**不发** `max_tokens`（`maxOutput` 在该族只是规划输入，见
  `modelLimits.ts`），天然满足。

## 2. 与千问文档的逐条对照（2026-09-02）

对照 [structured-output](https://platform.qianwenai.com/docs/developer-guides/text-generation/structured-output.md)：

| 千问文档说 | 本项目今天 |
| --- | --- |
| 两种模式：`json_object`、`json_schema`（`{name, schema, strict:true}` 三个字段都写） | 只发 `json_object` |
| `json_object` 支持面：Qwen 全系、Kimi（k3 / k2-thinking）、DeepSeek V4、GLM 4.5–5.1、Step | 全部按"OpenAI 族"一视同仁地发，没错 |
| `json_schema` 支持面：**仅 Qwen3.7-Plus/Flash/Max 系、Qwen3.8-Max/Flash 系** | 未用 |
| `json_object` 要 prompt 含 "JSON"；`json_schema` **不要** | 前者已保证；后者用上后可省掉那句 cue |
| 与 `enable_thinking` 兼容，但**思考模式下要求流式** | 本 app 永远流式 |
| "非思考模式的模型在思考模式下开 `json_object` 可能吐不出标准 JSON"，建议两步纠正 | 兜底路径本来就 `extractJsonObject` 从散文里抠；这条留作实测项（§11） |
| schema 支持的关键字：`type` / `properties` / `required` / `additionalProperties` / `description` / `enum`，支持嵌套对象与数组 | **没提 `anyOf` / 可空类型**——这是 strict 化可选字段的唯一障碍，见 §6.2 |
| 不要设 `max_tokens` | OpenAI 族不发 |

千问的 `json_schema` 写法与 OpenAI 官方同形（`structured.md` §1 表），所以
adapter 层不需要任何 DashScope 专属分支——差别只在**哪些模型接受它**，那是 L3
的事。

## 3. 为什么现在要加开关（reasoning-plan §8 第 4 条的前提变了哪些）

当年不上 `json_schema` 的三条理由，逐条重看：

1. *"DeepSeek 不支持，同族内官方支持、兼容端点不支持，无法从协议族推断。"*
   ——**仍然成立，而且正是要加"按模型声明"的理由**。从协议族推不出来的东西，
   本项目的惯例就是让作者在模型上声明（`thinkingCategory`、`serverTools`、
   `pdfInput`、`translateFormat` 全是这个形态）。
2. *"strict 要求全字段 required + `additionalProperties:false`，条目天然有可选字段。"*
   ——成立，但可以在**发送侧机械变换**（§6.2），不必改任何一处 schema 定义。
3. *"我们已有更可移植的等价手段——强制工具调用。"*
   ——**只在主路径成立**。被迫走兜底路径的恰恰是思考模型（Qwen 开
   `enable_thinking`、DeepSeek V4 恒思考），而它们**今天只拿得到 `json_object`**：
   合法 JSON，形状靠散文描述。在这条路上 `json_schema` 不是平级替代品，是从第
   1 档升到第 2 档。此外 `generator.ts` 从来没走过强制工具，它一直在第 1 档。

再加上一条当年没有的收益：**"关闭"档**。今天 OpenAI 族的每一次 JSON 任务都
无条件带 `response_format`，某个中继若不认这个字段，条目生成就是一个作者无法
绕开的硬 400。`reasoningEffort` 的 `default = 什么都不发` 就是为同一类风险设的，
JSON 模式缺这一档。

所以开关的价值排序是：**关闭（解救中继）> `json_schema`（升级兜底路径与条目生成）
> `json_object`（只是把今天的默认显式化，让"自动"有东西可退）**。

## 4. 数据模型：一个 L3 字段

按 `provider-layering.md` §2 的四问：不改 body 形状本身（同族同形）；换 key /
baseUrl 不变；**同一端点下换模型会变**（DashScope 上 Qwen3.8-Max 认 `json_schema`，
Qwen-Turbo 不认）→ L3。

```ts
// lib/ai/jsonMode.ts
/**
 * 作者对这个模型的结构化输出声明。缺省 = 自动（§5）。
 *   off          发任何 JSON 参数都不发，只留文本 cue —— 对所有中继都安全
 *   json_object  协议的 JSON 模式（① response_format / ③ responseMimeType）
 *   json_schema  schema 严格模式（① response_format.json_schema / ③ responseSchema）
 */
export type StructuredOutputMode = "off" | "json_object" | "json_schema";
export const STRUCTURED_OUTPUT_MODES: StructuredOutputMode[] = ["off", "json_object", "json_schema"];
export function parseStructuredOutputMode(v: unknown): StructuredOutputMode | undefined;
```

落点，照 `thinkingCategory` 的每一处：

| 层 | 改动 |
| --- | --- |
| `configDb.ts` `Model` | `structuredOutput?: StructuredOutputMode`，注释写"Declared rather than derived"那一段的同款理由 |
| `configDb.ts` 迁移 | `addColumn(models, "structured_output", TEXT)`；insert 列表加一列；`rowToModel` 用 `parseStructuredOutputMode` |
| `conn.ts` `ConnOptions` | 加 `structuredOutput?: StructuredOutputMode`；`connOptions()` 与 `pickConnOptions()` 各一行——**这就是 `ConnOptions` 存在的理由**，加完之后九处调用方一处都不用改 |
| `types.ts` `StreamOptions` | 通过 `ConnOptions` 子集关系自动获得，不单独声明 |
| 配置备份（`configsync/envelope`、本地导出） | `Model` 行整行序列化，不需要改；旧备份缺列读成 undefined = 自动 |

**绝不**把它放进 `caps`：`caps` 是图片路由那一套能力位（`ImageCaps`），且是 JSON
列；一个三值枚举放独立 TEXT 列，与 `thinking_category` 同形，`parse*` 函数在读取
侧把脏值归零。

## 5. 自动档怎么判

"自动"必须像 `thinkingCategory` 的 `auto` 一样是 **UI 哨兵而不是存储值**：存
undefined，读取时解析。解析分三层，前两层是配置期可算的，第三层是运行期学的：

### 5.1 第一层：协议族默认（今天的行为，一字不改）

```
① openai / openai_compat   → json_object
③ gemini / gemini_compat   → json_object（responseMimeType）
④ anthropic / anthropic_compat → off（本来就无此参数，cue 是全部机制）
```

这一层保证**没声明的模型发的字节与今天完全相同**——`reasoning.ts` 头注释那条
"unset 必须 byte-identical"在这里同样成立，`aiJsonMode.test.ts` 现有五条用例
一条都不该改。

### 5.2 第二层：模型 id 前缀表把默认**抬到** `json_schema`

```ts
/** modelId 前缀 → 已知支持 schema 严格模式。只抬不降：不在表里 = 族默认。 */
const KNOWN_JSON_SCHEMA: ReadonlyArray<string> = [
  // ── Qwen (DashScope)，千问文档 2026-09 口径 ──
  "qwen3.7-plus", "qwen3.7-flash", "qwen3.7-max",
  "qwen3.8-max", "qwen3.8-flash",
  // ── OpenAI 官方 ──
  "gpt-5", "gpt-4.1", "gpt-4o",
];
```

把 `modelLimits.ts` 里私有的 `normalizeModelId` 导出复用（小写 + 剥掉 `vendor/`
前缀，最长前缀命中），不再写第二份归一化。它今天不认 `特价kiro | qwen3.8-max`
这种中继别名——输出上限表同样不认，那类 id 走手动档，两张表一条规则。表**只抬
不降**：一个模型不在表里，最坏只是留在族默认的 `json_object`，那正是今天的行为。

只在 ①/③ 族查表——④ 族的表命中也没有意义（无 JSON 模式）。

### 5.3 第三层：端点自己的 400 是最终裁决（`toolChoice.ts` 的同款）

`toolChoice.ts` 已经证明这个形态可行：**端点的 400 在生成任何 token 之前到达，
零成本、确定性、本来就是我们要的那条声明**。照搬，写在新文件 `lib/ai/jsonModeMemo.ts`：

```
发 json_schema → 400 且报文含 response_format / json_schema / strict
  → 本次降为 json_object 重试一次，memo[endpoint+model] = json_object
发 json_object → 400 且报文含 response_format / json_object
  → 本次降为 off（只留 cue）重试一次，memo[endpoint+model] = off
```

判据要**窄**——参数名必须出现，理由同 `isForcedToolChoiceRejection`：
"does not support" 这类宽泛短语也会命中不相关的真错误，重试只会把整段上下文
再发一遍再失败一遍。memo 会话级、内存态、不入库：它是关于端点的事实，不是作者
的配置，重新学一次的代价是一个失败请求。

三层叠起来：**表决定开局出价，400 把它修正到端点真能接受的那一档**。将来加
DeepSeek / Kimi / GLM 只是往 5.2 的表里加一行（或者什么都不加——它们在千问的
`json_object` 支持面上，族默认就已经对了），不动任何分支。

### 5.4 手动档不经过 5.2，但**经过** 5.3

作者显式选了 `json_schema`，就不查表；但端点若 400，仍然降级重试并 memo——
作者选错档的代价应该是"这一档没生效"，不是"条目生成整个坏掉"。UI 上可以在
模型行显示"本会话实测降级为 JSON 模式"这一条（同 `probedAt` 的"某日实测"口径），
这是 §10 的第三片，不阻塞前两片。

## 6. 发到 wire 上的形状

### 6.1 `jsonModeShaping` 的签名扩一位

```ts
export function jsonModeShaping(
  conn: Pick<ConnOptions, "standard" | "modelId" | "baseUrl" | "structuredOutput">,
  promptText: string,
  schema?: { name: string; parameters: Record<string, unknown> },   // 有它才可能上 json_schema
): JsonModeShaping
```

`schema` 直接收 `ToolDefinition["function"]` 的那两个字段——`runStructuredTask`
的 `outputTool` 本来就是"参数即 schema"，一份定义两条路共用，**任何一处 schema
都不需要改写**。`generator.ts` 今天没有 schema（它的形状全在 prompt 里），第一片
里它只在 `off` / `json_object` 两档之间变化；给条目生成补一份 `LoreEntitySchema`
是 §10 第二片的事。

| 解析出的档 | ① Chat Completions | ③ Google GenAI | ④ Anthropic |
| --- | --- | --- | --- |
| `off` | 无 `extraBody`，**恒带 cue** | 同 | 同（今天的行为） |
| `json_object` | `response_format:{type:"json_object"}` + 条件 cue | `generationConfig.responseMimeType` + 恒 cue | 视同 `off` |
| `json_schema`（且给了 schema） | `response_format:{type:"json_schema", json_schema:{name, strict:true, schema: strictify(parameters)}}`，**无 cue**（文档明说不需要，那句 cue 省下来） | `generationConfig.responseMimeType` + **`responseJsonSchema`**（Gemini 2.5+ 的新字段，接标准 JSON Schema——类型联合、`additionalProperties`、`anyOf` 都认，所以同一份 strictify 结果原样发；**不是**旧的 `responseSchema`，那是 OpenAPI 方言，要 `nullable: true` 且不认 `additionalProperties`，两者互斥），无 cue。自动档的 id 表加 `gemini-2.5` / `gemini-3` | 视同 `off` |
| `json_schema` 但没给 schema | 退到 `json_object` 的行为 | 同 | 同 |

`extraBody` 仍然是 adapter 里**最后展开**的那一项（`openai.ts` 的"outranks config"），
所以这里不改 adapter 一行：shaping 算出来的东西照旧从 `extraBody` 进去。
`gemini.ts` 的 `generationConfig` 是一层深合并（已有注释说明），`responseSchema`
放进同一个对象即可。

### 6.2 `strictify()`：把我们的 schema 变成 strict 能吃的

strict 的两条硬规则（`structured.md` §3）：`additionalProperties:false`；
**所有字段进 `required`**。本项目八份 schema 里有可选字段的：一致性检查的
`suggestion` / `entity`，生图提示词的 `negative` / `style` / `aspect`。改这些定义
去迎合 strict 会反过来伤主路径（强制工具调用的参数里，可选就该是可选）。所以在
**发送侧**做一次纯变换：

```
strictify(schema):
  每个 object 节点：additionalProperties = false；
                  required = 全部 properties 的 key；
                  原本不在 required 里的字段 → type 加上 "null"（`type: ["string","null"]`）
  递归进 properties / items
```

与之配对的是**接收侧**一个 `stripNulls()`：把变换出来的 `null` 去掉，让调用方
拿到的 JSON 与走强制工具调用时形状一致——调用方今天就按"字段可能缺"写的，
`null` 对它们是新情况，不能漏这一步。

**风险点，也是 §11 第一条实测**：千问文档列的关键字里没有类型联合与
`anyOf`。若实测 DashScope 的 strict 校验拒绝 `type: [..., "null"]`，退路有两条，
按代价排：(a) 有可选字段的 schema 不上 `json_schema`，在 shaping 里判出来直接
走 `json_object`——一致性检查与生图提示词两处降档，其余六处照样升级；
(b) 不带 `strict:true`。(a) 是正解，(b) 等于没上。

### 6.3 json_schema 与思考、与工具

- 千问：`json_schema` 与 `enable_thinking` 兼容，要求流式——满足。
- **`json_schema` 与 `tools` 同发的行为文档没写**（`structured.md` §5 已把
  "JSON 模式与工具循环互斥"列为实践要点）。本项目里 JSON 模式只出现在**无工具**
  的请求上（`LORE_GENERATE_PRESET` 工具为空；`runStructuredTask` 的 `runJson`
  不带 `tools`），不需要新的守卫，但 `runtime.ts` 那条 `extraBody` 注释要把
  `json_schema` 一并点名。

## 7. 三个读取点

1. **`agent/structured.ts` 的兜底路径 `runJson`**：把 `jsonModeShaping(common, …)`
   改成带 `args.outputTool.function` 的调用，其余不动。这就是收益最大的一处：
   Qwen 思考开着被降级、DeepSeek V4 被 400 之后，退到的是 schema 严格模式而
   不是散文描述形状。
2. **`lore/generator.ts`**：第一片只让 `off` 生效（今天它在中继上无路可退）；
   第二片补 `LoreEntitySchema`（`name / aliases / category / summary / body`，`category`
   用 `enum` 钉到 `categoryIds`——这比 prompt 末尾那句"MUST be exactly one of"
   强得多，也是 `json_schema` 在这里的实际价值），让 `json_schema` 也生效。
3. **可选优化，不在前两片**：`structured.ts` 在**可预测**的降级场景（`forcesToolChoiceAuto`
   为真，即 Qwen `switch` 方言 + 思考开着）且解析档为 `json_schema` 时，**跳过强制
   工具那一趟直接走 `runJson`**。今天这个场景是：`toolChoiceFor` 把 `required`
   降成 `auto` → 模型多半不调用 → `EMPTY_TOOL_CALL` → 再发一次。省掉的是本地
   模型上以十秒计的一整趟。但它改变了主路径的选择逻辑，单独成片、单独实测。

`structured.ts` 的 `TOOL_CAPABILITY_ERROR` 判据、`toolChoice.ts` 的 memo、
`openai.ts` 的 `toolChoiceFor` **一个字都不动**——它们管的是第 3 档能不能用，
本方案管的是第 3 档不能用时退到第几档。

## 8. UI：`ModelDrawer` 里紧挨着思考类目的一行 Chip

```
结构化输出 (可选)      [自动] [关闭] [JSON 模式] [JSON Schema]
  自动：按协议族默认发送 JSON 模式；已知支持 schema 严格模式的模型自动升级。拿不准时选它。
```

- 形态复用 `ChipRow` / `Chip` + `hub.fieldHint`，值集 `["auto", ...STRUCTURED_OUTPUT_MODES]`，
  `auto` 存 undefined——与 `thinkingCategory` 那一段代码同构，可以直接照抄。
- **④ 族只显示 [自动] [关闭]**，hint 写"该协议族没有 JSON 模式参数，结构化任务
  走强制工具调用；关闭仅影响退路上的文本提示"。给 MiniMax 的作者一个能看懂的
  解释，比隐藏这一行好。
- ③ 族第一片显示 [自动] [关闭] [JSON 模式]，`JSON Schema` 待 §11 实测后再放出。
- hint 按选中档切换，四段文案，i18n key 前缀 `aiConfig.models.structuredOut*`，
  zh-CN 与 en 同时补；措辞对照 `docs/reference/terminology.md`（"JSON 模式"、
  "JSON Schema"作为专名不译）。
- 位置：`thinkingCategory` 那组之后、`serverTools` 之前——三者都是"这个模型的
  wire 能力声明"，放在一起。

## 9. 测试

- `aiJsonMode.test.ts`：现有五条**原样通过**（自动 + 无 schema = 今天的行为）；
  新增：三档 × 三族的 `extraBody`/cue 矩阵；`json_schema` 不发 cue；给了 schema
  但档位是 `json_object` 时不发 `json_schema`；④ 族三档全部退化为 cue。
- 新 `aiJsonSchemaStrict.test.ts`：`strictify` 对八份真实 schema（直接 import
  各处的 `OUTPUT_TOOL` / `findingsTool()`）的输出满足 strict 两条硬规则；
  `stripNulls(strictify 出来的样本)` 与原 schema 下的合法实例形状一致；幂等。
- 新 `aiJsonModeMemo.test.ts`：照 `toolChoice` 的测试写——400 报文命中/不命中
  的判据；降级顺序 `json_schema → json_object → off`；memo 按 `standard+baseUrl+modelId`
  键；`__reset` 供测试。
- `agentStructured.test.ts`：加一条"兜底路径带 `json_schema`"，一条"`off` 时兜底
  路径 `extraBody` 为 undefined 且带 cue"。
- `aiConn.test.ts`：`connOptions` / `pickConnOptions` 携带 `structuredOutput`。
- 前缀表：`qwen3.8-max`、`Qwen3.8-Max-2026-08`、`org/qwen3.7-plus` 命中，
  `qwen-plus`、`qwen3-max`、`特价 | qwen3.8-max`（中继别名，走手动档）不命中。

## 10. 分片

按惯例每片一个 PR，每片之后停下来给真机验证：

| 片 | 内容 | 用户能看到什么 |
| --- | --- | --- |
| **1** | §4 字段 + 迁移 + `ConnOptions`；§5.1/5.2 解析；§6.1 shaping 扩签名 + §6.2 `strictify`/`stripNulls`；§7 第 1 点（兜底路径）；§7 第 2 点的 `off` 半边；§8 UI；§9 全部测试 | 模型抽屉多一行；Qwen3.8 开思考做一致性检查 / 元信息改进时，兜底路径请求体里出现 `json_schema`；不认 `response_format` 的中继可以关掉它 |
| **2** | §5.3 的 400 学习 + memo；`generator.ts` 的 `LoreEntitySchema` 让条目生成也吃到 `json_schema`（`category` 用 `enum`） | 选错档不再是硬失败；条目生成不再把分类写到不存在的桶里 |
| **3**（可选） | §7 第 3 点：可预测降级时跳过强制工具那一趟；模型行上显示"本会话实测降级为 …" | 本地思考模型少等一整趟 |

第 1 片就能独立交付，且**对没声明的模型零行为变化**——这是可以放心合的理由。

## 11. 待实测（合第 1 片前至少跑第一条）

按 [`docs/issues/thinking-verification.md`](../issues/thinking-verification.md)
的口径，在 DashScope 兼容模式上用真实请求确认：

1. **strict 模式接不接受 `type: ["string","null"]`**（或 `anyOf` 带 `null`）。
   决定 §6.2 走主案还是退路 (a)。
2. Qwen3.8-Max **思考开着** + `json_schema` 流式：确认输出是否严格符合 schema，
   `reasoning_content` 与 `content` 是否照常分流。
3. Qwen-Turbo（不在支持面上）收到 `json_schema` 的**确切 400 报文**——那是 §5.3
   判据的样本，没有样本就不写判据。
4. 千问文档那句"非思考模式模型在思考模式下开 `json_object` 可能吐不出标准 JSON"：
   在 `qwen3-max` + `enable_thinking:true` 上复现一次，看 `extractJsonObject`
   够不够，不够再决定要不要做文档建议的两步纠正。
5. Gemini 的 `responseJsonSchema`：strictify 出来的类型联合与 `additionalProperties:false`
   是否被接受；一个不认这个字段的 gemini_compat 中继回的 400 报文是否含
   `responseJsonSchema` 字样（`isJsonModeRejection` 靠它降级）。

在这五条之前，本文所有关于 DashScope 实际行为的陈述都只是文档转述，状态 `unverified`。

## 12. 弃案

- **按供应商品牌加分支**（`if (isQwen(baseUrl))`）：`provider-layering.md` §4
  的"L2 必须是数据不能是代码"。品牌在中继上不可见，模型 id 才是作者知道的东西。
- **把 `json_schema` 提为主路径、强制工具调用退居其次**：强制工具调用四族都有，
  `json_schema` 只有 ①③ 有且 ① 的兼容端点参差不齐；主次颠倒等于把可移植性最好
  的一档让给最差的一档。reasoning-plan §8 第 4 条在**主路径**上仍然成立。
- **放 L2（Provider）**：同一 DashScope 端点下 Qwen3.8-Max 与 Qwen-Turbo 的答案不同，
  放 L2 立刻穿帮（`provider-layering.md` §1 L3 那段的原话）。
- **探测（发一个请求试）而不是声明**：可以做，但不该是第一片——§5.3 的 400
  学习已经在运行时免费拿到同一份事实，专门的探测只在作者想"提前知道"时才值得，
  那是 `endpointProbe` 的地界，以后再说。
- **改八份 schema 去迎合 strict**：伤主路径的可选语义，且把"strict 的规则"散到
  八个文件里；一处 `strictify` 就够。
